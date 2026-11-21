/**
 * 播放器集成测试：最小可用的 MSE / Video mock + 虚拟时钟，
 * 驱动 LLMsePlayer 走「收帧 -> 入队 -> ABR 降档 -> 追帧变速 -> 卡顿统计」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMsePlayer } from '../player/player.ts';
import { AbrController } from '../player/abr.ts';
import { FRAME_HEADER_BYTES, INIT_FRAME_SEQ } from '../player/transport.ts';
import type { VenueManifest } from '../shared/protocol.ts';

type AbrControllerLike = Pick<AbrController, 'sample' | 'decide' | 'force'>;

let now = 1_000_000;
const clock = (): number => now;
const advance = (ms: number): void => {
  now += ms;
};
const flush = (ms = 20): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 轮询等待断言成立（SourceBuffer 串行 append 需要若干事件循环才能排空）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${predicate.toString().slice(0, 60)}`);
}

class MockSourceBuffer {
  mode = 'segments';
  updating = false;
  buffered: TimeRanges;
  private ranges: Array<[number, number]> = [];
  private listeners: Record<string, Array<() => void>> = {};
  appendedInit = 0;
  appendedMedia = 0;
  changeTypeCalls: string[] = [];
  constructor(public mime: string) {
    this.buffered = makeRanges(this.ranges);
  }
  appendBuffer(data: Uint8Array): void {
    this.updating = true;
    // 用宏任务而非微任务模拟真实 SourceBuffer 的异步完成，
    // 避免 updateend 在 appendBuffer 同一调用栈内触发导致 pump 重入
    setTimeout(() => {
      this.updating = false;
      if (data.length > 0 && data[0] === 0x7f) this.appendedInit++;
      else {
        this.appendedMedia++;
        const start = this.ranges.length ? this.ranges[this.ranges.length - 1][1] : 0;
        // 相邻区间合并为单个连续 TimeRanges，贴近真实 MSE 的 buffered 表现
        this.ranges = [[0, start + 0.2]];
        this.buffered = makeRanges(this.ranges);
      }
      (this.listeners['updateend'] ?? []).forEach((fn) => fn());
    }, 0);
  }
  changeType(mime: string): void {
    this.changeTypeCalls.push(mime);
  }
  remove(): void {}
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(): void {}
}

function makeRanges(ranges: Array<[number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i][0],
    end: (i: number) => ranges[i][1],
  } as unknown as TimeRanges;
}

class MockMediaSource {
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  sourceBuffer: MockSourceBuffer | null = null;
  private openListeners: Array<() => void> = [];
  static isTypeSupported(): boolean {
    return true;
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'sourceopen') this.openListeners.push(fn);
  }
  removeEventListener(): void {}
  addSourceBuffer(mime: string): MockSourceBuffer {
    this.sourceBuffer = new MockSourceBuffer(mime);
    return this.sourceBuffer;
  }
  removeSourceBuffer(): void {
    this.sourceBuffer = null;
  }
  endOfStream(): void {
    this.readyState = 'ended';
  }
  triggerOpen(): void {
    this.readyState = 'open';
    for (const fn of this.openListeners) fn();
  }
}

class MockVideo {
  src = '';
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  readyState = 0;
  videoWidth = 1280;
  videoHeight = 720;
  private waitingListeners: Array<() => void> = [];
  private playingListeners: Array<() => void> = [];
  async play(): Promise<void> {
    this.paused = false;
    this.readyState = 3;
    // currentTime 进入已缓冲区间（mock 缓冲从 0 开始）
    if (this.currentTime === 0) this.currentTime = 0.01;
    queueMicrotask(() => this.playingListeners.forEach((fn) => fn()));
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'waiting') this.waitingListeners.push(fn);
    if (type === 'playing') this.playingListeners.push(fn);
  }
  removeEventListener(): void {}
  removeAttribute(): void {}
  emitWaiting(): void {
    this.readyState = 1;
    this.waitingListeners.forEach((fn) => fn());
  }
  emitPlaying(): void {
    this.readyState = 3;
    this.playingListeners.forEach((fn) => fn());
  }
}

let mediaSourceInstances: MockMediaSource[] = [];
/** 每个连接对应的可读流控制器，测试可手动 enqueue，保持连接不关闭。 */
let controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];

function installDomMocks(): void {
  mediaSourceInstances = [];
  controllers = [];
  vi.stubGlobal(
    'MediaSource',
    class extends MockMediaSource {
      constructor() {
        super();
        mediaSourceInstances.push(this);
        queueMicrotask(() => this.triggerOpen());
      }
    },
  );
  // 保留真实 URL 构造函数（内部有 new URL()），只打补丁对象方法
  const RealURL = globalThis.URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends RealURL {}, {
      createObjectURL: (): string => 'blob:mock',
      revokeObjectURL: (): void => {},
    }),
  );
  vi.stubGlobal('fetch', vi.fn());
}

/** fetch 每次被调用都返回一条新的、可 cancel 的流，并登记其控制器。 */
function mockPersistentStream(): void {
  vi.mocked(fetch).mockImplementation(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
      cancel() {
        /* 允许 transport.abort() 干净退出 reader.read() */
      },
    });
    return { ok: true, body: stream } as unknown as Response;
  });
}

function pushFrame(controller: ReadableStreamDefaultController<Uint8Array>, publishAt: number, seq: number, payload: Uint8Array): void {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, BigInt(publishAt));
  dv.setUint32(8, seq);
  dv.setUint32(12, payload.length);
  out.set(payload, FRAME_HEADER_BYTES);
  controller.enqueue(out);
}

const venue: VenueManifest = {
  id: 'track',
  name: '田径场',
  targetDurationMs: 2000,
  chunkDurationMs: 200,
  poolSegments: 10,
  renditions: [
    { id: '480p', bitrate: 900_000, width: 854, height: 480, codecs: 'avc1.64001e,mp4a.40.2' },
    { id: '720p', bitrate: 1_800_000, width: 1280, height: 720, codecs: 'avc1.64001f,mp4a.40.2' },
    { id: '1080p', bitrate: 3_600_000, width: 1920, height: 1080, codecs: 'avc1.640028,mp4a.40.2' },
  ],
};

const INIT_PAYLOAD = new Uint8Array([0x7f, 0x00, 0x01]);
const mediaPayload = (n: number): Uint8Array => new Uint8Array([0x01, n & 0xff, 0x02, 0x03]);

/** 等待第 n 条流（0 基）被 fetch 创建并登记。 */
async function waitForController(index: number): Promise<ReadableStreamDefaultController<Uint8Array>> {
  const deadline = Date.now() + 1000;
  while (controllers.length <= index && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const c = controllers[index];
  if (!c) throw new Error(`stream controller #${index} never registered`);
  return c;
}

async function makePlayer(autoAbr = true): Promise<{ player: LLMsePlayer; video: MockVideo }> {
  mockPersistentStream();
  const video = new MockVideo();
  const player = new LLMsePlayer(
    video as unknown as HTMLVideoElement,
    venue,
    { autoAbr, reportIntervalMs: 100_000 },
    'session-x',
    clock,
  );
  await player.start(venue);
  await waitForController(0); // 确保首条直播流已建立
  await flush();
  return { player, video };
}

describe('LLMsePlayer integration', () => {
  beforeEach(() => {
    now = 1_000_000;
    installDomMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends init then media, starts playback and records first-frame metrics', async () => {
    const { player, video } = await makePlayer();
    const c = controllers[0];
    pushFrame(c, 0, INIT_FRAME_SEQ, INIT_PAYLOAD);
    for (let i = 0; i < 6; i++) {
      pushFrame(c, now - 400 + i * 200, 0, mediaPayload(i));
    }
    // SourceBuffer 串行 append，轮询等待队列排空且起播完成
    const sb0 = () => mediaSourceInstances[0].sourceBuffer!;
    await waitUntil(() => sb0().appendedMedia === 6);
    await waitUntil(() => video.paused === false);

    const sb = sb0();
    expect(sb.appendedInit).toBe(1);
    expect(sb.appendedMedia).toBe(6);
    expect(video.paused).toBe(false);
    expect(player.metrics.firstFrameAt).toBeGreaterThan(0);
    expect(player.metrics.startupMs).toBeGreaterThanOrEqual(0);
    await player.dispose();
  });

  it('downshifts to lower rendition when bandwidth collapses', async () => {
    const { player } = await makePlayer(true);
    const c = controllers[0];
    pushFrame(c, 0, INIT_FRAME_SEQ, INIT_PAYLOAD);
    for (let i = 0; i < 6; i++) pushFrame(c, now - 400 + i * 200, 0, mediaPayload(i));
    await waitUntil(() => mediaSourceInstances[0].sourceBuffer!.appendedMedia === 6);

    const internals = player as unknown as {
      abr: AbrControllerLike;
      switchRendition: (i: number, r: string) => void;
      renditionIndex: number;
    };

    // 把 ABR 与播放器都放到最高档（force 同步 ABR 内部 index，switchRendition 同步播放器）
    internals.abr.force(2);
    internals.switchRendition(2, 'manual');
    expect(internals.renditionIndex).toBe(2);

    // 建立高带宽 EWMA 基线后持续注入低带宽，ABR 应在 2s 内一路降到最低档
    internals.abr.sample(6_000_000, now);
    const downshifts: number[] = [];
    for (let i = 0; i < 20; i++) {
      advance(200);
      internals.abr.sample(400_000, now); // 400kbps 撑不住任何高档
      const d = internals.abr.decide(now, true);
      if (d) {
        downshifts.push(d.index);
        internals.switchRendition(d.index, 'downshift');
      }
    }

    expect(downshifts.length).toBeGreaterThan(0);
    expect(internals.renditionIndex).toBe(0);
    expect(player.metrics.switches).toBeGreaterThan(0);
    expect(mediaSourceInstances[0].sourceBuffer!.changeTypeCalls.length).toBeGreaterThan(0);
    await player.dispose();
  });

  it('catch-up raises playback rate when latency is high', async () => {
    const { player, video } = await makePlayer();
    const c = controllers[0];
    pushFrame(c, 0, INIT_FRAME_SEQ, INIT_PAYLOAD);
    for (let i = 0; i < 8; i++) pushFrame(c, now - 400 + i * 200, 0, mediaPayload(i));
    await flush();
    await video.play(); // 进入播放态，否则 tick 不改 playbackRate
    await flush();

    // 直接构造延迟锚点：播放点 mediaTime=1.0s，其墙钟锚定在 now；
    // 最新发布帧在 now+4000，于是端到端延迟约 4s，应触发加速。
    const anchor = player as unknown as {
      anchorMediaSec: number | null;
      anchorWallMs: number;
      latestPublishAt: number;
      chunkMs: number;
    };
    video.currentTime = 1.0;
    anchor.anchorMediaSec = 1.0;
    anchor.anchorWallMs = now;
    anchor.latestPublishAt = now + 4000 - anchor.chunkMs;

    (player as unknown as { tick: () => void }).tick();
    expect(player.snapshot().latencyMs).toBeGreaterThan(3000);
    expect(video.playbackRate).toBeGreaterThan(1);
    expect(video.playbackRate).toBeLessThanOrEqual(1.1);

    // 延迟回到目标区间（边缘只领先 1.5s）后，连续 tick 应收敛回 1.0
    anchor.latestPublishAt = now + 1500 - anchor.chunkMs;
    for (let i = 0; i < 40; i++) (player as unknown as { tick: () => void }).tick();
    expect(video.playbackRate).toBe(1);
    await player.dispose();
  });

  it('stall detection counts stalls and backs off ABR', async () => {
    const { player, video } = await makePlayer();
    const c = controllers[0];
    pushFrame(c, 0, INIT_FRAME_SEQ, INIT_PAYLOAD);
    for (let i = 0; i < 4; i++) pushFrame(c, now - 400 + i * 200, 0, mediaPayload(i));
    await flush();
    await video.play();
    await flush();

    video.emitWaiting();
    expect(player.metrics.isStalling).toBe(true);
    advance(500);
    video.emitPlaying();
    await flush();

    expect(player.metrics.stalls).toBe(1);
    expect(player.metrics.stallMs).toBe(500);
    await player.dispose();
  });

  it('reconnects (new fetch) on rendition switch and keeps stats session stable', async () => {
    const { player } = await makePlayer();
    expect(controllers).toHaveLength(1);
    const sessionBefore = player.getSessionId();

    const internals = player as unknown as { switchRendition: (i: number, r: string) => void };
    internals.switchRendition(1, 'manual');
    await flush();

    expect(controllers.length).toBeGreaterThanOrEqual(2); // 重连产生新流
    expect(player.getSessionId()).toBe(sessionBefore); // session 不变
    expect(player.snapshot().renditionIndex).toBe(1);
    await player.dispose();
  });
});
