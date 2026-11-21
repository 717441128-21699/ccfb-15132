/**
 * LL-CMAF 播放器主类。
 *
 * 协作关系：
 *   LiveTransport 收帧 -> ABR 决策档位 -> MseEngine 入队
 *   主循环（250ms）：卡顿检测、追帧变速、延迟/缓冲采样、统计上报
 *
 * 延迟模型：服务端每帧带 publishAt（直播边缘墙钟）。首帧建立
 *   edgeClockBase = 首帧 publishAt + 首帧媒体时间，之后
 *   edgeNow ≈ now + (edgeClockBase 推算)，端到端延迟 = edgeNow - 播放点对应墙钟。
 *   稳态下直接用「最新帧 publishAt + chunkMs - 播放点墙钟」估算。
 */
import { LiveTransport, type MediaFrame, type ThroughputSample } from './transport.ts';
import { AbrController } from './abr.ts';
import { CatchUpController } from './catchup.ts';
import { MseEngine } from './mse-engine.ts';
import { MetricsCollector, type MetricPoint } from './metrics.ts';
import type { VenueManifest, RenditionInfo, ViewerReport } from '../shared/protocol.ts';

export interface PlayerConfig {
  autoAbr: boolean;
  /** 手动档位下标（autoAbr=false 时生效） */
  manualIndex: number;
  /** 调试页网络模拟参数，会拼到直播 URL 上 */
  simQuery?: string | undefined;
  statsEndpoint?: string | undefined;
  reportIntervalMs?: number | undefined;
  tickMs?: number | undefined;
}

export interface PlayerSnapshot {
  latencyMs: number;
  bufferMs: number;
  bitrate: number;
  renditionIndex: number;
  rate: number;
  stalling: boolean;
  running: boolean;
  estimateBps: number;
  seq: number;
}

const DEFAULT_CONFIG: PlayerConfig = {
  autoAbr: true,
  manualIndex: 0,
  statsEndpoint: '/api/stats',
  reportIntervalMs: 2000,
  tickMs: 250,
};

export class LLMsePlayer {
  readonly metrics = new MetricsCollector();
  readonly catchUp = new CatchUpController();
  private engine: MseEngine;
  private transport: LiveTransport | null = null;
  private abr: AbrController | null = null;
  private venue: VenueManifest;
  private renditionIndex: number;
  private config: PlayerConfig;
  private readonly sessionId: string;
  private readonly startAt: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private startedPlayback = false;

  // 延迟锚点
  private anchorMediaSec: number | null = null;
  private anchorWallMs = 0;
  private latestPublishAt = 0;
  private latestSeq = -1;
  private chunkMs: number;
  private switchPending = false;

  constructor(
    private readonly video: HTMLVideoElement,
    venue: VenueManifest,
    config: Partial<PlayerConfig> = {},
    sessionId?: string,
    clock: () => number = Date.now,
  ) {
    this.venue = venue;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.renditionIndex = this.config.autoAbr
      ? 0
      : Math.min(this.config.manualIndex, venue.renditions.length - 1);
    this.chunkMs = venue.chunkDurationMs;
    this.sessionId = sessionId ?? makeSessionId();
    this.startAt = clock();
    this.clock = clock;
    this.engine = new MseEngine(video, {
      onWaiting: () => this.metrics.markStallStart(this.clock()),
      onPlaying: () => {
        const dur = this.metrics.markStallEnd(this.clock());
        if (dur > 0 && this.abr) {
          const d = this.abr.notifyStall(this.clock());
          if (d && this.config.autoAbr) this.switchRendition(d.index, 'stall-backoff');
        }
      },
      // 缓冲状态在 updateend 后才刷新；起播判断放在这里，避免入队时读到旧 buffered
      onUpdateEnd: () => this.maybeStartPlayback(),
      onError: (err) => this.emitError(err),
    });
  }

  private clock: () => number;
  private listeners = new Set<(snap: PlayerSnapshot) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  onSnapshot(fn: (snap: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onError(fn: (err: Error) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  get currentVenue(): VenueManifest {
    return this.venue;
  }

  get currentRendition(): RenditionInfo {
    return this.venue.renditions[this.renditionIndex];
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 启动直播（首次 attach + 拉流）。 */
  async start(venue: VenueManifest = this.venue): Promise<void> {
    this.venue = venue;
    this.chunkMs = venue.chunkDurationMs;
    const mime = mimeFor(venue.renditions[this.renditionIndex]);
    await this.engine.attach(mime);
    this.abr = new AbrController(venue.renditions, {}, this.renditionIndex, this.clock);
    this.openTransport();
    this.running = true;
    this.startLoops();
  }

  private liveUrl(venueId: string, renditionId: string): string {
    const base = `/api/live/${encodeURIComponent(venueId)}/${encodeURIComponent(renditionId)}`;
    return this.config.simQuery ? `${base}?${this.config.simQuery}` : base;
  }

  private openTransport(): void {
    const rendition = this.venue.renditions[this.renditionIndex];
    this.transport?.abort();
    this.switchPending = false;
    this.transport = new LiveTransport(
      this.liveUrl(this.venue.id, rendition.id),
      {
        onFrame: (frame) => this.handleFrame(frame),
        onThroughput: (s) => this.handleThroughput(s),
        onError: (err) => this.emitError(err),
      },
      this.clock,
    );
    void this.transport.start();
  }

  private handleThroughput(sample: ThroughputSample): void {
    this.abr?.sample(sample.bps, sample.at);
  }

  private handleFrame(frame: MediaFrame | { kind: 'init'; data: Uint8Array }): void {
    if (frame.kind === 'init') {
      this.engine.appendInit(frame.data);
      return;
    }
    const mf = frame as MediaFrame;
    this.latestPublishAt = mf.publishAt;
    this.latestSeq = mf.seq;

    // 切档在分片边界（chunkIndex=0 的帧 seq 会变化；以 seq 跳变识别新分片）
    if (this.switchPending) this.switchPending = false;

    this.engine.appendMedia(mf.data);

    // 起播判断在 updateend 回调（maybeStartPlayback）里做，那里 buffered 已刷新
    this.metrics.markFirstFrame(this.clock(), this.startAt);
    this.establishAnchor(mf);
  }

  /**
   * 起播：攒到约 600ms 缓冲后，先 seek 到缓冲起点（直播边缘）再 play。
   * 服务端长时间运行后媒体时间戳会累积到很大（tfdt 单调递增），新观众的
   * currentTime=0 会远离缓冲区间，必须 seek 过去才有可解码帧。
   */
  private maybeStartPlayback(): void {
    if (this.startedPlayback) return;
    if (this.engine.aheadBufferSeconds() < 0.6) return;
    this.startedPlayback = true;

    const b = this.engine.buffered();
    if (b && b.length > 0) {
      const start = b.start(0);
      // 仅当播放点不在任何缓冲区间内时才 seek（避免正常续播被打断）
      const inside = Array.from({ length: b.length }, (_, i) => i).some(
        (i) => this.video.currentTime >= b.start(i) && this.video.currentTime <= b.end(i),
      );
      if (!inside && Math.abs(this.video.currentTime - start) > 0.5) {
        try {
          this.video.currentTime = start + 0.05;
        } catch {
          /* seek 失败则直接 play，交给浏览器自行选点 */
        }
      }
    }
    void this.video.play().catch(() => undefined);
  }

  /** 建立「媒体时间 -> 墙钟」锚点，用于把播放点换算成直播边缘延迟。 */
  private establishAnchor(mf: MediaFrame): void {
    const end = this.engine.bufferEnd();
    if (end === null) return;
    // 该帧对应媒体区间末端 ≈ bufferEnd；其发布时刻 + 一个 chunk 时长 ≈ 末端墙钟
    this.anchorMediaSec = end;
    this.anchorWallMs = mf.publishAt + this.chunkMs;
  }

  /** 当前端到端延迟 ms：直播边缘墙钟 - 播放点对应墙钟。 */
  currentLatencyMs(): number {
    if (this.anchorMediaSec === null) return 0;
    // 播放点 mediaTime 对应的墙钟
    const playWall = this.anchorWallMs - (this.anchorMediaSec - this.video.currentTime) * 1000;
    // 直播边缘墙钟（最新发布帧的下一个 chunk 边界）
    const edgeWall = this.latestPublishAt + this.chunkMs;
    return Math.max(0, edgeWall - playWall);
  }

  private startLoops(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => void this.report(), this.config.reportIntervalMs);
  }

  private tick(): void {
    if (!this.running) return;
    const now = this.clock();

    // 卡顿检测兜底：readyState 低且在播放态
    if (this.video.readyState < 2 && !this.video.paused && !this.metrics.isStalling && this.startedPlayback) {
      this.metrics.markStallStart(now);
    } else if (this.video.readyState >= 3 && this.metrics.isStalling) {
      const dur = this.metrics.markStallEnd(now);
      if (dur > 0 && this.abr) {
        const d = this.abr.notifyStall(now);
        if (d && this.config.autoAbr) this.switchRendition(d.index, 'stall-backoff');
      }
    }

    // ABR 周期决策
    if (this.abr && this.config.autoAbr && !this.switchPending) {
      const hasBuffer = this.engine.aheadBufferSeconds() > 1.0;
      const decision = this.abr.decide(now, hasBuffer);
      if (decision) this.switchRendition(decision.index, decision.reason);
    } else if (this.abr && !this.config.autoAbr) {
      this.abr.force(this.renditionIndex);
    }

    // 追帧变速
    const latency = this.currentLatencyMs();
    const rate = this.catchUp.update(latency, this.metrics.isStalling || this.video.paused);
    if (Math.abs(this.video.playbackRate - rate) > 0.001 && !this.video.paused) {
      this.video.playbackRate = rate;
    }

    const point: MetricPoint = {
      t: now,
      latencyMs: latency,
      bufferMs: this.engine.aheadBufferSeconds() * 1000,
      bitrate: this.currentRendition.bitrate,
      rate,
    };
    this.metrics.record(point);
    this.emitSnapshot();
  }

  private switchRendition(index: number, reason: string): void {
    if (index === this.renditionIndex) return;
    this.renditionIndex = index;
    this.metrics.markSwitch();
    const mime = mimeFor(this.venue.renditions[index]);
    this.engine.changeType(mime);
    this.switchPending = true;
    // 重新拉流：新连接从当前分片边缘起播，天然在分片/IDR 边界对齐
    this.openTransport();
    this.emitLog(`ABR ${reason} -> ${this.venue.renditions[index].id}`);
  }

  /**
   * 切换赛场：替换 venue 并从边缘重新拉流。
   * 无黑屏由上层 VenueSwitcher 用双 video 元素保证（预附着 + 首帧后再换显示）。
   */
  async switchVenue(venue: VenueManifest): Promise<void> {
    if (venue.id === this.venue.id) return;
    this.venue = venue;
    this.chunkMs = venue.chunkDurationMs;
    this.renditionIndex = this.config.autoAbr ? 0 : Math.min(this.config.manualIndex, venue.renditions.length - 1);
    this.metrics.markVenueSwitch();
    this.startedPlayback = false;
    this.anchorMediaSec = null;
    this.catchUp.reset();
    this.abr = new AbrController(venue.renditions, {}, this.renditionIndex, this.clock);
    const mime = mimeFor(venue.renditions[this.renditionIndex]);
    this.engine.changeType(mime);
    this.openTransport();
    this.emitLog(`venue switch -> ${venue.name}`);
  }

  setAutoAbr(auto: boolean): void {
    this.config.autoAbr = auto;
    if (!auto && this.abr) this.abr.force(this.renditionIndex);
  }

  setManualIndex(index: number): void {
    this.config.manualIndex = index;
    if (!this.config.autoAbr && index !== this.renditionIndex) {
      this.switchRendition(index, 'manual');
    }
  }

  setSimQuery(simQuery: string | undefined): void {
    this.config = { ...this.config, simQuery };
    // 下一次重连生效；立即重连以应用调试参数
    this.openTransport();
  }

  snapshot(): PlayerSnapshot {
    return {
      latencyMs: this.currentLatencyMs(),
      bufferMs: this.engine.aheadBufferSeconds() * 1000,
      bitrate: this.currentRendition.bitrate,
      renditionIndex: this.renditionIndex,
      rate: this.video.playbackRate,
      stalling: this.metrics.isStalling,
      running: this.running,
      estimateBps: this.abr?.estimateBps ?? 0,
      seq: this.latestSeq,
    };
  }

  private async report(): Promise<void> {
    if (!this.running) return;
    const body: ViewerReport = {
      sessionId: this.sessionId,
      venue: this.venue.id,
      startAt: this.startAt,
      firstFrameAt: this.metrics.firstFrameAt,
      startupMs: this.metrics.startupMs,
      stalls: this.metrics.stalls,
      stallMs: this.metrics.stallMs,
      latencyMs: Math.round(this.currentLatencyMs()),
      switches: this.metrics.switches,
      venueSwitches: this.metrics.venueSwitches,
      updatedAt: this.clock(),
    };
    try {
      await fetch(this.config.statsEndpoint ?? '/api/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch {
      /* 统计上报失败不影响播放 */
    }
  }

  private emitSnapshot(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private emitError(err: Error): void {
    for (const fn of this.errorListeners) fn(err);
  }

  private logListeners = new Set<(msg: string) => void>();
  onLog(fn: (msg: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }
  private emitLog(msg: string): void {
    for (const fn of this.logListeners) fn(msg);
  }

  async dispose(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.transport?.abort();
    await this.engine.flush().catch(() => undefined);
    this.engine.dispose();
  }
}

export function mimeFor(r: RenditionInfo): string {
  return `video/mp4; codecs="${r.codecs}"`;
}

function makeSessionId(): string {
  // crypto.randomUUID 在现代浏览器与 Node 18+ 均可用
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
