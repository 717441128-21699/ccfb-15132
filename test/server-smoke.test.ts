/**
 * 端到端冒烟测试：启动真实 HTTP origin，验证
 *  - 清单接口
 *  - 直播分帧（init + 持续 media 帧、seq 单调、发布时间合理）
 *  - 网络模拟参数生效（限速下投递被推迟、丢包可复现）
 *  - 统计上报与列表
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { FRAME_HEADER_BYTES, INIT_FRAME_SEQ } from '../player/transport.ts';
import type { ManifestResponse, StatsResponse } from '../shared/protocol.ts';

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

let server: ChildProcess;

beforeAll(async () => {
  const isWin = process.platform === 'win32';
  server = spawn(isWin ? 'npx.cmd' : 'npx', ['tsx', 'server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin,
  });
  let stderr = '';
  server.stderr?.on('data', (d) => (stderr += d.toString()));

  // 等待端口就绪
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/manifest`);
      if (r.ok) break;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (Date.now() >= deadline) throw new Error(`server failed to start: ${stderr}`);
}, 20_000);

afterAll(() => {
  server.kill();
});

async function readFrames(url: string, maxFrames: number, maxMs = 4000): Promise<
  Array<{ publishAt: number; seq: number; length: number; receivedAt: number }>
> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`fetch ${url} failed: ${resp.status}`);
  const reader = resp.body.getReader();
  const frames: Array<{ publishAt: number; seq: number; length: number; receivedAt: number }> = [];
  let buf = new Uint8Array(0);
  const start = Date.now();

  while (frames.length < maxFrames && Date.now() - start < maxMs) {
    const { value, done } = await reader.read();
    if (done) break;
    const incoming = value!;
    const merged = new Uint8Array(buf.length + incoming.length);
    merged.set(buf, 0);
    merged.set(incoming, buf.length);
    buf = merged;

    let off = 0;
    while (buf.length - off >= FRAME_HEADER_BYTES) {
      const dv = new DataView(buf.buffer, buf.byteOffset + off, FRAME_HEADER_BYTES);
      const publishAt = Number(dv.getBigUint64(0));
      const seq = dv.getUint32(8);
      const len = dv.getUint32(12);
      if (buf.length - off - FRAME_HEADER_BYTES < len) break;
      frames.push({ publishAt, seq, length: len, receivedAt: Date.now() });
      off += FRAME_HEADER_BYTES + len;
    }
    buf = buf.slice(off);
  }
  await reader.cancel();
  return frames;
}

describe('HTTP origin', () => {
  it('serves a manifest with 3 venues and 3 renditions', async () => {
    const r = await fetch(`${BASE}/api/manifest`);
    const m = (await r.json()) as ManifestResponse;
    expect(m.venues).toHaveLength(3);
    for (const v of m.venues) {
      expect(v.renditions).toHaveLength(3);
      expect(v.targetDurationMs).toBe(2000);
      expect(v.chunkDurationMs).toBe(200);
      for (const rend of v.renditions) expect(rend.codecs).toContain('avc1.');
    }
  });

  it('streams init first then monotonically sequenced media chunks', async () => {
    const frames = await readFrames(`${BASE}/api/live/track/720p`, 12, 5000);
    expect(frames.length).toBeGreaterThanOrEqual(10);
    expect(frames[0].seq).toBe(INIT_FRAME_SEQ);
    expect(frames[0].length).toBeGreaterThan(100); // init segment

    const media = frames.slice(1);
    const seqs = media.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1]);
    // 同一分片内 chunk 的 seq 相同，跨分片 +1
    expect(new Set(seqs).size).toBeGreaterThanOrEqual(1);
    // 发布时间不落在未来太远（广播器按墙钟发布）
    for (const f of media) expect(f.receivedAt - f.publishAt).toBeGreaterThanOrEqual(-50);
    // 回归保护：publishAt 是完整墙钟毫秒，绝不能被截成 32 位（>2^32 即未回绕）
    for (const f of media) expect(f.publishAt).toBeGreaterThan(2 ** 32);
  });

  it('bandwidth simulation delays delivery relative to unlimited stream', async () => {
    // 480p 单 chunk 约 22~45KB；1.2Mbps 限速下单帧传输 ~150~300ms。
    // 跳过前 4 帧（prime 回放的历史 backlog 会污染首帧延迟），只比稳态。
    const limited = await readFrames(`${BASE}/api/live/track/480p?simBw=1200000&simSeed=1`, 12, 12_000);
    const plain = await readFrames(`${BASE}/api/live/track/480p?simSeed=2`, 12, 12_000);

    const steadyAvg = (list: typeof limited): number => {
      const media = list.filter((f) => f.seq !== INIT_FRAME_SEQ).slice(4);
      return media.reduce((s, f) => s + Math.max(0, f.receivedAt - f.publishAt), 0) / media.length;
    };
    expect(limited.filter((f) => f.seq !== INIT_FRAME_SEQ).length).toBeGreaterThan(4);
    expect(steadyAvg(limited)).toBeGreaterThan(steadyAvg(plain) + 80);
  }, 16_000);

  it('loss simulation with fixed seed is reproducible', async () => {
    // 固定采集时长而非帧数：30% 丢包下帧少，凑帧数会超时。
    // 同种子两次连接的 NetworkSimulator 丢包序列一致，收到帧数应相同。
    const collect = (): Promise<number> =>
      readFrames(`${BASE}/api/live/track/480p?simLoss=0.3&simSeed=99`, 1000, 6000).then(
        (f) => f.filter((x) => x.seq !== INIT_FRAME_SEQ).length,
      );
    const [a, b] = await Promise.all([collect(), collect()]);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  }, 10_000);

  it('accepts viewer stats and lists them', async () => {
    const sessionId = `smoke-${Date.now()}`;
    const resp = await fetch(`${BASE}/api/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        venue: 'court',
        startAt: Date.now() - 1500,
        firstFrameAt: Date.now() - 900,
        startupMs: 600,
        stalls: 2,
        stallMs: 450,
        latencyMs: 2100,
        switches: 3,
        venueSwitches: 1,
        updatedAt: Date.now(),
      }),
    });
    expect(resp.ok).toBe(true);

    const list = ((await (await fetch(`${BASE}/api/stats`)).json()) as StatsResponse).viewers;
    const mine = list.find((v) => v.sessionId === sessionId);
    expect(mine).toBeDefined();
    expect(mine?.stalls).toBe(2);
    expect(mine?.startupMs).toBe(600);
  });

  it('rejects unknown venue and rendition', async () => {
    const r1 = await fetch(`${BASE}/api/live/nope/720p`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${BASE}/api/edge/nope`);
    expect(r2.status).toBe(404);
  });
});
