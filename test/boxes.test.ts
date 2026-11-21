import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  iterTopLevel,
  parseBoxes,
  findBox,
  extractTracks,
  isInitSegment,
  splitChunksByVideoMoof,
  prepareTfdtPatching,
  applyLoopRound,
  retimestampSegment,
  readSegmentTfdt,
} from '../shared/boxes.ts';

const STREAMS = path.resolve(__dirname, '..', 'streams');
const INIT = path.join(STREAMS, 'track', '720p', 'init.mp4');
const SEG0 = path.join(STREAMS, 'track', '720p', 'seg-00000.m4s');
const SEG9 = path.join(STREAMS, 'track', '720p', 'seg-00009.m4s');

describe('box parsing', () => {
  it('parses init segment and extracts RFC6381 codecs', async () => {
    const buf = new Uint8Array(await readFile(INIT));
    expect(isInitSegment(buf)).toBe(true);
    const root = parseBoxes(buf);
    const types = root.map((b) => b.type);
    expect(types).toContain('ftyp');
    expect(types).toContain('moov');

    const moov = root.find((b) => b.type === 'moov')!;
    const tracks = extractTracks(moov);
    expect(tracks).toHaveLength(2);
    const video = tracks.find((t) => t.handler === 'vide')!;
    const audio = tracks.find((t) => t.handler === 'soun')!;
    expect(video.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    expect(audio.codec).toBe('mp4a.40.2');
    expect(video.timescale).toBeGreaterThan(0);
    expect(audio.timescale).toBe(48000);
  });

  it('every segment starts with moof and contains 10 video-boundary chunks', async () => {
    const buf = new Uint8Array(await readFile(SEG0));
    const tops = iterTopLevel(buf);
    expect(tops[0].type).toBe('moof');

    const moov = parseBoxes(new Uint8Array(await readFile(INIT))).find((b) => b.type === 'moov')!;
    const videoTrackId = extractTracks(moov).find((t) => t.handler === 'vide')!.trackId;
    const chunks = splitChunksByVideoMoof(buf, videoTrackId);
    expect(chunks).toHaveLength(10);
    // 每个 chunk 以 moof 起始
    for (const c of chunks) expect(iterTopLevel(c)[0].type).toBe('moof');
  });

  it('reads monotonically increasing tfdt across the pool', async () => {
    const moov = parseBoxes(new Uint8Array(await readFile(INIT))).find((b) => b.type === 'moov')!;
    const video = extractTracks(moov).find((t) => t.handler === 'vide')!;
    const first = readSegmentTfdt(new Uint8Array(await readFile(SEG0))).get(video.trackId)!;
    const last = readSegmentTfdt(new Uint8Array(await readFile(SEG9))).get(video.trackId)!;
    expect(first).toBe(0n);
    // 20s 池末分片起点 = 18s，按视频 timescale 换算
    const expected = (18n * 1000n * BigInt(video.timescale)) / 1000n;
    expect(last).toBe(expected);
  });
});

describe('tfdt retimestamping', () => {
  it('rewrites tfdt to v1 and shifts by loop delta', async () => {
    const seg = new Uint8Array(await readFile(SEG0));
    const moov = parseBoxes(new Uint8Array(await readFile(INIT))).find((b) => b.type === 'moov')!;
    const tracks = extractTracks(moov);

    const overrides = new Map<number, bigint>();
    const loopMs = 20n * 1000n;
    for (const t of tracks) {
      const original = readSegmentTfdt(seg).get(t.trackId)!;
      overrides.set(t.trackId, original + (loopMs * BigInt(t.timescale)) / 1000n);
    }
    const out = retimestampSegment(seg, overrides);
    // 输出仍是合法 box 序列
    expect(() => iterTopLevel(out)).not.toThrow();
    const after = readSegmentTfdt(out);
    for (const t of tracks) {
      const delta = after.get(t.trackId)! - readSegmentTfdt(seg).get(t.trackId)!;
      expect(delta).toBe((loopMs * BigInt(t.timescale)) / 1000n);
    }
    // tfdt 已升级为 v1（payload 首字节 = 1）
    const moof = parseBoxes(out).find((b) => b.type === 'moof')!;
    const tfdt = findBox(moof.children, ['traf', 'tfdt'])!;
    expect(tfdt.payload![0]).toBe(1);
  });

  it('prepared chunk patching is stable across many loop rounds', async () => {
    const seg = new Uint8Array(await readFile(SEG0));
    const moov = parseBoxes(new Uint8Array(await readFile(INIT))).find((b) => b.type === 'moov')!;
    const tracks = extractTracks(moov);
    const videoId = tracks.find((t) => t.handler === 'vide')!.trackId;
    const chunks = splitChunksByVideoMoof(seg, videoId);
    const prepared = prepareTfdtPatching(chunks[0]);

    const deltas = new Map<number, bigint>();
    for (const t of tracks) deltas.set(t.trackId, (20n * 1000n * BigInt(t.timescale)) / 1000n);

    const round100 = applyLoopRound(prepared, deltas, 100);
    const values = readSegmentTfdt(round100);
    for (const t of tracks) {
      const base = readSegmentTfdt(chunks[0]).get(t.trackId)!;
      expect(values.get(t.trackId)).toBe(base + deltas.get(t.trackId)! * 100n);
    }
    // 原始 prepared 字节不被污染（可重复使用）
    const round0 = applyLoopRound(prepared, deltas, 0);
    expect(readSegmentTfdt(round0)).toEqual(readSegmentTfdt(chunks[0]));
  });

  it('handles 64-bit tfdt without overflow for long-running broadcasts', async () => {
    const seg = new Uint8Array(await readFile(SEG0));
    const moov = parseBoxes(new Uint8Array(await readFile(INIT))).find((b) => b.type === 'moov')!;
    const tracks = extractTracks(moov);
    const video = tracks.find((t) => t.handler === 'vide')!;
    const chunks = splitChunksByVideoMoof(seg, video.trackId);
    const prepared = prepareTfdtPatching(chunks[0]);
    // 模拟连续直播 30 天的循环轮次（20s/轮）
    const rounds = Math.floor((30 * 24 * 3600) / 20);
    const deltas = new Map<number, bigint>();
    for (const t of tracks) deltas.set(t.trackId, (20n * 1000n * BigInt(t.timescale)) / 1000n);
    const out = applyLoopRound(prepared, deltas, rounds);
    const v = readSegmentTfdt(out).get(video.trackId)!;
    expect(v > 2n ** 32n).toBe(true); // 已超出 32 位范围，证明 v1 必需
  });
});
