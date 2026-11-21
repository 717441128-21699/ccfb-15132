/**
 * 测试流生成器。
 *
 * 为每个赛场 × 每档码率生成一段 20 秒的 fragmented MP4（CMAF 兼容）：
 *   - 2s 一个 CMAF 分片（10 个 chunk，每个 chunk 约 200ms）
 *   - H.264 (yuv420p) + AAC，单文件内音视频复用
 * 随后用 shared/boxes 拆成 init.mp4 + seg-00000.m4s ... 存到 streams/ 下，
 * 服务端按墙钟节奏循环推送这些分片，并在推送时重写 tfdt。
 *
 * 注意：AAC 编码器会在末尾产生一个纯音频 priming moof（比视频长约 1~2 帧），
 * 分片时把这种不含视频 traf 的 moof 并入前一个 chunk，保证每个 chunk 都以
 * 视频 moof 为边界，循环重打 tfdt 后时间轴依然连续。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  iterTopLevel,
  concat,
  parseBoxes,
  findBox,
  readTfdt,
  extractTracks,
  isInitSegment,
  splitChunksByVideoMoof,
} from '../shared/boxes.ts';
import type { RenditionInfo } from '../shared/protocol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'streams');

export const POOL_SECONDS = 20;
export const SEGMENT_MS = 2000;
export const CHUNK_MS = 200;
const FRAGMENTS_PER_SEGMENT = SEGMENT_MS / CHUNK_MS; // 10

interface RenditionDef extends RenditionInfo {
  videoBps: number;
  audioBps: number;
}

export const RENDITIONS: RenditionDef[] = [
  { id: '480p', bitrate: 900_000, width: 854, height: 480, codecs: '', videoBps: 780_000, audioBps: 120_000 },
  { id: '720p', bitrate: 1_800_000, width: 1280, height: 720, codecs: '', videoBps: 1_680_000, audioBps: 120_000 },
  { id: '1080p', bitrate: 3_600_000, width: 1920, height: 1080, codecs: '', videoBps: 3_480_000, audioBps: 120_000 },
];

export interface VenueDef {
  id: string;
  name: string;
  videoSrc: string;
  color: string;
  tone: number;
}

export const VENUES: VenueDef[] = [
  { id: 'track', name: '田径场', videoSrc: 'testsrc2', color: '0x3A86FF', tone: 440 },
  { id: 'court', name: '篮球馆', videoSrc: 'smptebars', color: '0xFB5607', tone: 554 },
  { id: 'pool', name: '游泳馆', videoSrc: 'rgbtestsrc', color: '0x06D6A0', tone: 659 },
];

interface StoredManifest {
  poolSeconds: number;
  segmentMs: number;
  chunkMs: number;
  poolSegments: number;
  venues: Array<{
    id: string;
    name: string;
    renditions: Array<RenditionInfo & { dir: string }>;
  }>;
}

async function runFfmpeg(args: string[]): Promise<void> {
  const exe = process.env.FFMPEG_PATH ?? 'ffmpeg';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-25).join('\n')}`));
    });
  });
}

function filterFor(venue: VenueDef, w: number, h: number): string {
  const label = `${venue.name} ${w}x${h}`;
  return [
    `${venue.videoSrc}=size=${w}x${h}:rate=25:duration=${POOL_SECONDS}`,
    `drawbox=x=0:y=0:w=iw:h=90:color=${venue.color}@0.85:t=fill`,
    `drawtext=text='${label}':x=24:y=24:fontsize=44:fontcolor=white`,
    `drawtext=text='%{pts\\:hms}':x=w-220:y=28:fontsize=40:fontcolor=white`,
    'format=yuv420p',
  ].join(',');
}

/** 读出某个 moof 内指定 track 的 tfdt。 */
function moofTfdt(segment: Uint8Array, moofBox: { start: number; size: number }, trackId: number): bigint {
  const node = parseBoxes(segment.subarray(moofBox.start, moofBox.start + moofBox.size))[0];
  for (const traf of node.children.filter((n) => n.type === 'traf')) {
    const tfhd = findBox(traf.children, ['tfhd']);
    const tfdt = findBox(traf.children, ['tfdt']);
    if (tfhd?.payload && tfdt) {
      const id = new DataView(tfhd.payload.buffer, tfhd.payload.byteOffset).getUint32(4);
      if (id === trackId) return readTfdt(tfdt);
    }
  }
  throw new Error(`track ${trackId} tfdt not found in moof`);
}

async function splitFragmentedMp4(
  raw: Uint8Array,
  destDir: string,
): Promise<{ tracks: number; codecs: string[]; chunks: number }> {
  const tops = iterTopLevel(raw);
  if (!tops.some((b) => b.type === 'moof')) throw new Error('generated mp4 has no moof — ffmpeg fragmentation failed');

  // init：第一个 moof 之前的全部 box（ftyp + moov），忽略结尾 mfra
  const firstMoofIdx = tops.findIndex((b) => b.type === 'moof');
  const init = concat(tops.slice(0, firstMoofIdx).map((b) => raw.subarray(b.start, b.start + b.size)));
  if (!isInitSegment(init)) throw new Error('init segment sanity check failed');
  await writeFile(path.join(destDir, 'init.mp4'), init);

  const moov = parseBoxes(init).find((n) => n.type === 'moov')!;
  const tracks = extractTracks(moov);
  const codecs = tracks.map((t) => t.codec);
  const videoTrack = tracks.find((t) => t.handler === 'vide');
  if (!videoTrack) throw new Error('no video track');

  // 按「含视频 traf 的 moof」切 chunk，纯音频 priming moof 并入前一个 chunk
  const mediaTops = tops.filter((b) => b.type !== 'mfra').slice(firstMoofIdx);
  const mediaOnly = concat(mediaTops.map((b) => raw.subarray(b.start, b.start + b.size)));
  const chunks = splitChunksByVideoMoof(mediaOnly, videoTrack.trackId);

  const totalChunks = (POOL_SECONDS * 1000) / CHUNK_MS; // 100
  if (chunks.length !== totalChunks) {
    throw new Error(`expected ${totalChunks} video-boundary chunks, got ${chunks.length}`);
  }

  // 校验视频 tfdt 等间隔，再按 10 个 chunk 落一个分片
  const expectedStepMs = BigInt(CHUNK_MS);
  let prevTfdt: bigint | null = null;
  for (const c of chunks) {
    const firstMoof = iterTopLevel(c)[0];
    const tf = moofTfdt(c, firstMoof, videoTrack.trackId);
    if (prevTfdt !== null) {
      const deltaMs = ((tf - prevTfdt) * 1000n) / BigInt(videoTrack.timescale);
      if (deltaMs !== expectedStepMs) {
        throw new Error(`video chunk tfdt delta ${deltaMs}ms != ${CHUNK_MS}ms`);
      }
    }
    prevTfdt = tf;
  }

  let segCount = 0;
  for (let s = 0; s < chunks.length / FRAGMENTS_PER_SEGMENT; s++) {
    const seg = concat(chunks.slice(s * FRAGMENTS_PER_SEGMENT, (s + 1) * FRAGMENTS_PER_SEGMENT));
    await writeFile(path.join(destDir, `seg-${String(s).padStart(5, '0')}.m4s`), seg);
    segCount++;
  }
  return { tracks: tracks.length, codecs, chunks: segCount };
}

async function main(): Promise<void> {
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const manifest: StoredManifest = {
    poolSeconds: POOL_SECONDS,
    segmentMs: SEGMENT_MS,
    chunkMs: CHUNK_MS,
    poolSegments: (POOL_SECONDS * 1000) / SEGMENT_MS,
    venues: [],
  };

  for (const venue of VENUES) {
    const venueEntry: StoredManifest['venues'][number] = { id: venue.id, name: venue.name, renditions: [] };
    for (const r of RENDITIONS) {
      const dir = path.join(OUT, venue.id, r.id);
      await mkdir(dir, { recursive: true });
      const rawPath = path.join(dir, '_raw.mp4');
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', filterFor(venue, r.width, r.height),
        '-f', 'lavfi', '-i', `sine=frequency=${venue.tone}:sample_rate=48000:duration=${POOL_SECONDS}`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', String(r.videoBps),
        '-maxrate', String(Math.round(r.videoBps * 1.2)),
        '-bufsize', String(r.videoBps * 2),
        '-g', '50',
        '-keyint_min', '50',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', String(r.audioBps),
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', String(CHUNK_MS * 1000),
        '-t', String(POOL_SECONDS),
        '-y',
        rawPath,
      ];
      console.log(`[gen] ${venue.id}/${r.id} (${r.width}x${r.height} @ ${r.bitrate}bps)`);
      await runFfmpeg(args);

      const raw = new Uint8Array(await readFile(rawPath));
      const { tracks, codecs, chunks } = await splitFragmentedMp4(raw, dir);
      await rm(rawPath, { force: true });
      if (tracks !== 2) throw new Error(`expected 2 tracks, got ${tracks}`);
      if (chunks !== manifest.poolSegments) throw new Error(`segment count ${chunks}`);

      venueEntry.renditions.push({
        id: r.id,
        bitrate: r.bitrate,
        width: r.width,
        height: r.height,
        codecs: codecs.join(','),
        dir: path.relative(OUT, dir).split(path.sep).join('/'),
      });
    }
    manifest.venues.push(venueEntry);
  }

  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const files = await readdir(OUT, { recursive: true });
  console.log(`[gen] done. ${files.length} files under streams/`);
  console.log(
    JSON.stringify(
      manifest.venues.map((v) => ({ venue: v.id, renditions: v.renditions.map((r) => `${r.id}:${r.codecs}`) })),
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
