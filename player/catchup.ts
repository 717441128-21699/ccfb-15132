/**
 * 追帧控制器：用温和的播放速率调整把端到端延迟维持在目标区间。
 *
 * - 延迟 > 目标 + 阈值：轻微加速（最高 1.10，避免音调/观感异常）
 * - 延迟 < 目标 - 阈值：轻微减速（最低 0.95），防止追上直播边缘
 * - 区间内：恢复 1.0
 * - 卡顿时由播放器暂停追帧（waiting 事件），恢复后重新决策
 *
 * 加速量与超出程度成比例并做斜率限制，避免速率频繁跳变。
 */
export interface CatchUpOptions {
  targetLatencyMs: number;
  /** 进入加速/减速的死区 */
  deadBandMs: number;
  minRate: number;
  maxRate: number;
  /** 每 1ms 超额延迟映射到的速率增量 */
  ratePerMs: number;
  /** 单次决策的最大速率变化（斜率限制） */
  maxStep: number;
}

export const DEFAULT_CATCHUP_OPTIONS: CatchUpOptions = {
  targetLatencyMs: 1500,
  deadBandMs: 350,
  minRate: 0.95,
  maxRate: 1.1,
  ratePerMs: 0.00004, // 超出 1000ms -> +0.04
  maxStep: 0.02,
};

export class CatchUpController {
  private appliedRate = 1;
  readonly options: CatchUpOptions;

  constructor(opts: Partial<CatchUpOptions> = {}) {
    this.options = { ...DEFAULT_CATCHUP_OPTIONS, ...opts };
  }

  get rate(): number {
    return this.appliedRate;
  }

  /**
   * 根据当前延迟决策新的播放速率。
   * @param latencyMs 端到端延迟（正数=落后于直播边缘）
   * @param stalled   是否处于卡顿
   */
  update(latencyMs: number, stalled: boolean): number {
    if (stalled || !Number.isFinite(latencyMs)) {
      this.appliedRate = 1;
      return this.appliedRate;
    }
    const { targetLatencyMs, deadBandMs, minRate, maxRate, ratePerMs, maxStep } = this.options;
    const excess = latencyMs - targetLatencyMs;
    let desired = 1;
    if (excess > deadBandMs) {
      desired = clamp(1 + (excess - deadBandMs) * ratePerMs, 1, maxRate);
    } else if (excess < -deadBandMs) {
      desired = clamp(1 + (excess + deadBandMs) * ratePerMs, minRate, 1);
    }
    // 斜率限制 + 死区内回到 1.0
    const delta = clamp(desired - this.appliedRate, -maxStep, maxStep);
    this.appliedRate = clamp(this.appliedRate + delta, minRate, maxRate);
    if (desired === 1 && Math.abs(this.appliedRate - 1) < 0.002) this.appliedRate = 1;
    return this.appliedRate;
  }

  reset(): void {
    this.appliedRate = 1;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
