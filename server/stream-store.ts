/**
 * StreamStore：加载 streams/ 下的 CMAF 分片池，为每个赛场维护一条
 * 按墙钟推进的「直播时间轴」，并以 200ms 一个 chunk 的节奏向所有
 * 订阅连接广播 moof+mdat 字节。
 *
 * 性能策略：加载时把每个 chunk 的 tfdt 预编译为 v1（64 位）并记录固定
 * 偏移；广播时只做一次 slice + setBigUint64（循环轮次偏移），不再解析 box。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  parseBoxes,
  extractTracks,
  splitChunksByVideoMoof,
  prepareTfdtPatching,
  applyLoopRound,
  type PreparedChunk,
  type TrackInfo,
} from '../shared/boxes.ts';
import type { ManifestResponse, VenueManifest, RenditionInfo, EdgeInfo } from '../shared/protocol.ts';

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

interface RenditionData {
  info: RenditionInfo;
  init: Uint8Array;
  tracks: TrackInfo[];
  videoTrackId: number;
  /** 按 [segmentIndex * chunksPerSegment + chunkIndex] 排列的预编译 chunk */
  chunks: PreparedChunk[];
  loopDeltaByTrack: Map<number, bigint>;
}

export interface ChunkEvent {
  /** 该 chunk 计划发布的墙钟时间 ms */
  publishAt: number;
  /** 全局单调分片序号 */
  seq: number;
  /** 分片内 chunk 下标 0..chunksPerSegment-1 */
  chunkIndex: number;
  loopIndex: number;
  /** 已重打 tfdt 的 CMAF 字节 */
  data: Uint8Array;
}

interface Subscriber {
  queue: ChunkEvent[];
  waiters: Array<(err: Error | null) => void>;
  closed: boolean;
}

class VenueBroadcaster {
  readonly venue: VenueManifest;
  private renditions = new Map<string, RenditionData>();
  /** 每个码率一路独立订阅集合，避免把其它码率的 chunk 推给同一连接 */
  private subsByRendition = new Map<string, Set<Subscriber>>();
  private timer: NodeJS.Timeout | null = null;
  private nextChunkCount = 0;
  private startedAt = 0;
  readonly chunkMs: number;
  readonly segmentMs: number;
  readonly chunksPerSegment: number;
  readonly poolSegments: number;

  constructor(
    private readonly rootDir: string,
    private readonly entry: StoredManifest['venues'][number],
    m: StoredManifest,
  ) {
    this.chunkMs = m.chunkMs;
    this.segmentMs = m.segmentMs;
    this.chunksPerSegment = m.segmentMs / m.chunkMs;
    this.poolSegments = m.poolSegments;
    this.venue = {
      id: entry.id,
      name: entry.name,
      targetDurationMs: m.segmentMs,
      chunkDurationMs: m.chunkMs,
      poolSegments: m.poolSegments,
      renditions: entry.renditions.map(({ dir, ...rest }) => rest),
    };
  }

  async load(): Promise<void> {
    for (const r of this.entry.renditions) {
      const dir = path.join(this.rootDir, r.dir);
      const init = new Uint8Array(await readFile(path.join(dir, 'init.mp4')));
      const moov = parseBoxes(init).find((n) => n.type === 'moov');
      if (!moov) throw new Error(`${r.dir}/init.mp4 missing moov`);
      const tracks = extractTracks(moov);
      const videoTrack = tracks.find((t) => t.handler === 'vide');
      if (!videoTrack) throw new Error(`${r.dir}: no video track`);

      const loopDeltaByTrack = new Map<number, bigint>();
      for (const t of tracks) {
        const deltaMs = BigInt(this.poolSegments * this.segmentMs);
        loopDeltaByTrack.set(t.trackId, (deltaMs * BigInt(t.timescale)) / 1000n);
      }

      const chunks: PreparedChunk[] = [];
      const segFiles = (await readdir(dir)).filter((f) => f.endsWith('.m4s')).sort();
      if (segFiles.length !== this.poolSegments) {
        throw new Error(`${r.dir}: expected ${this.poolSegments} segments, found ${segFiles.length}`);
      }
      for (const f of segFiles) {
        const seg = new Uint8Array(await readFile(path.join(dir, f)));
        const parts = splitChunksByVideoMoof(seg, videoTrack.trackId);
        if (parts.length !== this.chunksPerSegment) {
          throw new Error(`${r.dir}/${f}: expected ${this.chunksPerSegment} chunks, got ${parts.length}`);
        }
        for (const part of parts) chunks.push(prepareTfdtPatching(part));
      }

      this.renditions.set(r.id, {
        info: { id: r.id, bitrate: r.bitrate, width: r.width, height: r.height, codecs: r.codecs },
        init,
        tracks,
        videoTrackId: videoTrack.trackId,
        chunks,
        loopDeltaByTrack,
      });
    }
  }

  start(now: number): void {
    if (this.timer) return;
    this.startedAt = now;
    this.nextChunkCount = 0;
    const tick = (): void => {
      const publishAt = this.startedAt + this.nextChunkCount * this.chunkMs;
      this.emitTick(publishAt);
      this.nextChunkCount++;
      const nextAt = this.startedAt + this.nextChunkCount * this.chunkMs;
      this.timer = setTimeout(tick, Math.max(0, nextAt - Date.now()));
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const err = new Error('broadcaster stopped');
    for (const subs of this.subsByRendition.values()) {
      for (const s of subs) this.failSubscriber(s, err);
    }
  }

  private emitTick(publishAt: number): void {
    const chunkCount = this.nextChunkCount;
    const seq = Math.floor(chunkCount / this.chunksPerSegment);
    const chunkIndex = chunkCount % this.chunksPerSegment;
    const loopIndex = seq % this.poolSegments;
    const loopRound = Math.floor(seq / this.poolSegments);
    const poolChunkIndex = loopIndex * this.chunksPerSegment + chunkIndex;

    for (const [renditionId, r] of this.renditions) {
      const subs = this.subsByRendition.get(renditionId);
      if (!subs || subs.size === 0) continue; // 该码率当前无连接，跳过无谓的重打时间戳
      const ev: ChunkEvent = {
        publishAt,
        seq,
        chunkIndex,
        loopIndex,
        data: applyLoopRound(r.chunks[poolChunkIndex], r.loopDeltaByTrack, loopRound),
      };
      for (const s of subs) {
        if (!s.closed) s.queue.push(ev);
      }
      for (const s of [...subs]) {
        if (s.waiters.length) s.waiters.shift()!(null);
      }
    }
  }

  getRendition(id: string): RenditionData | undefined {
    return this.renditions.get(id);
  }

  edgeInfo(now: number): EdgeInfo {
    const elapsed = now - this.startedAt;
    const chunkCount = Math.max(0, Math.floor(elapsed / this.chunkMs));
    const seq = Math.floor(chunkCount / this.chunksPerSegment);
    return {
      seq,
      publishAt: this.startedAt + seq * this.chunksPerSegment * this.chunkMs,
      loopIndex: seq % this.poolSegments,
    };
  }

  /** 在指定码率通道上订阅，只会收到该码率的 chunk。 */
  subscribe(renditionId: string): Subscriber {
    let subs = this.subsByRendition.get(renditionId);
    if (!subs) {
      subs = new Set();
      this.subsByRendition.set(renditionId, subs);
    }
    const sub: Subscriber = { queue: [], waiters: [], closed: false };
    subs.add(sub);
    return sub;
  }

  unsubscribe(renditionId: string, sub: Subscriber): void {
    sub.closed = true;
    this.subsByRendition.get(renditionId)?.delete(sub);
    this.failSubscriber(sub, new Error('subscriber closed'));
  }

  private failSubscriber(s: Subscriber, err: Error): void {
    while (s.waiters.length) s.waiters.shift()!(err);
  }

  async next(sub: Subscriber): Promise<ChunkEvent> {
    if (sub.queue.length) return sub.queue.shift()!;
    if (sub.closed) throw new Error('subscriber closed');
    return new Promise<ChunkEvent>((resolve, reject) => {
      sub.waiters.push((err) => {
        if (err) reject(err);
        else if (sub.queue.length) resolve(sub.queue.shift()!);
        else reject(new Error('woken without data'));
      });
    });
  }

  /**
   * 新连接追边：回放当前分片已产生的 chunk（已按当前 loopRound 打时间戳）。
   * 最多一个分片的 backlog，避免海量积压；客户端拿到 seq 后从下一分片对齐。
   */
  prime(sub: Subscriber, renditionId: string, now: number): void {
    const r = this.renditions.get(renditionId);
    if (!r) throw new Error(`unknown rendition ${renditionId}`);
    const info = this.edgeInfo(now);
    const loopRound = Math.floor(info.seq / this.poolSegments);
    const elapsedInSegment = Math.min(this.segmentMs, Math.max(0, now - info.publishAt));
    const chunksReady = Math.min(
      this.chunksPerSegment,
      Math.max(1, Math.floor(elapsedInSegment / this.chunkMs) + 1),
    );
    for (let c = 0; c < chunksReady; c++) {
      const poolChunkIndex = info.loopIndex * this.chunksPerSegment + c;
      sub.queue.push({
        publishAt: info.publishAt + c * this.chunkMs,
        seq: info.seq,
        chunkIndex: c,
        loopIndex: info.loopIndex,
        data: applyLoopRound(r.chunks[poolChunkIndex], r.loopDeltaByTrack, loopRound),
      });
    }
  }
}

export class StreamStore {
  private broadcasters = new Map<string, VenueBroadcaster>();
  private manifest: ManifestResponse;

  private constructor(manifest: ManifestResponse) {
    this.manifest = manifest;
  }

  static async load(streamsDir: string): Promise<StreamStore> {
    const raw = JSON.parse(await readFile(path.join(streamsDir, 'manifest.json'), 'utf8')) as StoredManifest;
    const store = new StreamStore({
      generatedAt: Date.now(),
      venues: raw.venues.map((v) => ({
        id: v.id,
        name: v.name,
        targetDurationMs: raw.segmentMs,
        chunkDurationMs: raw.chunkMs,
        poolSegments: raw.poolSegments,
        renditions: v.renditions.map(({ dir, ...rest }) => rest),
      })),
    });
    const now = Date.now();
    for (const entry of raw.venues) {
      const bc = new VenueBroadcaster(streamsDir, entry, raw);
      await bc.load();
      bc.start(now);
      store.broadcasters.set(entry.id, bc);
    }
    return store;
  }

  getManifest(): ManifestResponse {
    return this.manifest;
  }

  getVenue(id: string): VenueBroadcaster | undefined {
    return this.broadcasters.get(id);
  }

  venues(): VenueBroadcaster[] {
    return [...this.broadcasters.values()];
  }

  shutdown(): void {
    for (const bc of this.broadcasters.values()) bc.stop();
  }
}
