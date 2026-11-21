/**
 * 播放器指标采集：卡顿次数/时长、码率切换、延迟与缓冲时间序列。
 * 环形缓冲保留最近 N 个采样点，供实时曲线使用。
 */
export interface MetricPoint {
  t: number;
  latencyMs: number;
  bufferMs: number;
  bitrate: number;
  rate: number;
}

export interface StallEvent {
  startedAt: number;
  durationMs: number;
}

const HISTORY = 600;

export class MetricsCollector {
  stalls = 0;
  stallMs = 0;
  switches = 0;
  venueSwitches = 0;
  startupMs = 0;
  firstFrameAt = 0;
  private stallStartedAt = 0;
  private stalling = false;
  readonly history: MetricPoint[] = [];
  readonly stallEvents: StallEvent[] = [];

  markStallStart(now: number): void {
    if (this.stalling) return;
    this.stalling = true;
    this.stallStartedAt = now;
    this.stalls++;
  }

  markStallEnd(now: number): number {
    if (!this.stalling) return 0;
    const dur = now - this.stallStartedAt;
    this.stalling = false;
    this.stallMs += dur;
    this.stallEvents.push({ startedAt: this.stallStartedAt, durationMs: dur });
    return dur;
  }

  get isStalling(): boolean {
    return this.stalling;
  }

  markSwitch(): void {
    this.switches++;
  }

  markVenueSwitch(): void {
    this.venueSwitches++;
  }

  markFirstFrame(now: number, startAt: number): void {
    if (this.firstFrameAt === 0) {
      this.firstFrameAt = now;
      this.startupMs = now - startAt;
    }
  }

  record(point: MetricPoint): void {
    this.history.push(point);
    if (this.history.length > HISTORY) this.history.shift();
  }

  reset(): void {
    this.stalls = 0;
    this.stallMs = 0;
    this.switches = 0;
    this.stallEvents.length = 0;
    this.history.length = 0;
    this.stalling = false;
    this.firstFrameAt = 0;
    this.startupMs = 0;
  }
}
