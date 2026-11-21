/**
 * 自适应码率（ABR）控制器。
 *
 * 指标：
 *  - 快 EWMA（半衰期 1s）：捕捉突发劣化，驱动「2 秒内降档」
 *  - 慢 EWMA（半衰期 4s）：过滤瞬时抖动，驱动谨慎升级
 *
 * 规则：
 *  - 降档无冷却：快 EWMA × 安全系数撑不住当前档就立刻降到能撑住的最高档
 *  - 升级有迟滞 + 冷却：慢 EWMA 持续高于目标档 1.3 倍且经过冷却期
 *  - 卡顿惩罚：每次 stall 强制降一档并锁定升级 3s
 *  - 纯函数式决策，时钟可注入，便于单测
 */
import type { RenditionInfo } from '../shared/protocol.ts';

export interface AbrOptions {
  /** 带宽安全系数：只用到估计带宽的该比例 */
  safety: number;
  fastHalfLifeMs: number;
  slowHalfLifeMs: number;
  /** 升级冷却 ms */
  upgradeCooldownMs: number;
  /** 升级迟滞倍数 */
  upgradeHysteresis: number;
  /** stall 后升级锁定 ms */
  stallLockMs: number;
}

export const DEFAULT_ABR_OPTIONS: AbrOptions = {
  safety: 0.85,
  fastHalfLifeMs: 1000,
  slowHalfLifeMs: 4000,
  upgradeCooldownMs: 4000,
  upgradeHysteresis: 1.3,
  stallLockMs: 3000,
};

export type AbrReason = 'startup' | 'downshift' | 'upshift' | 'stall-backoff' | 'none';

export interface AbrDecision {
  index: number;
  reason: Exclude<AbrReason, 'none'>;
}

export class AbrController {
  private fast: number | null = null;
  private slow: number | null = null;
  private lastSampleAt = 0;
  private lastUpgradeAt = -Infinity;
  private stallLockUntil = -Infinity;
  private current: number;
  readonly options: AbrOptions;

  constructor(
    private readonly renditions: RenditionInfo[],
    opts: Partial<AbrOptions> = {},
    startIndex = 0,
    private readonly clock: () => number = Date.now,
  ) {
    if (renditions.length === 0) throw new Error('ABR requires at least one rendition');
    this.options = { ...DEFAULT_ABR_OPTIONS, ...opts };
    this.current = Math.min(startIndex, renditions.length - 1);
  }

  get index(): number {
    return this.current;
  }

  get currentRendition(): RenditionInfo {
    return this.renditions[this.current];
  }

  /** 估计带宽 bps（无样本时返回 Infinity 以外的保守 0） */
  get estimateBps(): number {
    return this.fast ?? 0;
  }

  /** 喂入一个 chunk 的实测吞吐。 */
  sample(bps: number, now: number = this.clock()): void {
    if (!Number.isFinite(bps) || bps <= 0) return;
    if (this.fast === null || this.slow === null) {
      this.fast = bps;
      this.slow = bps;
    } else {
      const dt = Math.max(1, now - this.lastSampleAt);
      this.fast = ewma(this.fast, bps, dt, this.options.fastHalfLifeMs);
      this.slow = ewma(this.slow, bps, dt, this.options.slowHalfLifeMs);
    }
    this.lastSampleAt = now;
  }

  /** 卡顿事件：强制降一档并锁定升级。 */
  notifyStall(now: number = this.clock()): AbrDecision | null {
    this.stallLockUntil = now + this.options.stallLockMs;
    if (this.current === 0) return null;
    this.current -= 1;
    this.lastUpgradeAt = -Infinity;
    return { index: this.current, reason: 'stall-backoff' };
  }

  /**
   * 周期性决策。返回需要切档时的目标下标，否则 null。
   * @param hasBuffer 调用方是否有健康缓冲（升级前置条件）
   */
  decide(now: number = this.clock(), hasBuffer = true): AbrDecision | null {
    if (this.fast === null || this.slow === null) return null;
    const { safety, upgradeHysteresis, upgradeCooldownMs } = this.options;
    const usableFast = this.fast * safety;
    const usableSlow = this.slow * safety;

    // 1) 降档优先：快 EWMA 撑不住当前档，立刻降到能撑住的最高档
    if (this.current > 0 && this.renditions[this.current].bitrate > usableFast) {
      let target = this.current - 1;
      while (target > 0 && this.renditions[target].bitrate > usableFast) target--;
      this.current = target;
      return { index: target, reason: 'downshift' };
    }

    // 2) 升级：最高档不升；锁定期/冷却期不升；无缓冲不升
    if (
      this.current < this.renditions.length - 1 &&
      now >= this.stallLockUntil &&
      now - this.lastUpgradeAt >= upgradeCooldownMs &&
      hasBuffer
    ) {
      const candidate = this.renditions[this.current + 1];
      // 慢 EWMA 要有迟滞余量，快 EWMA 也不能正在恶化
      if (candidate.bitrate * upgradeHysteresis <= usableSlow && candidate.bitrate <= usableFast) {
        this.current += 1;
        this.lastUpgradeAt = now;
        return { index: this.current, reason: 'upshift' };
      }
    }
    return null;
  }

  /** 外部强制指定档位（手动模式）。 */
  force(index: number): void {
    this.current = Math.max(0, Math.min(this.renditions.length - 1, index));
  }
}

function ewma(prev: number, sample: number, dtMs: number, halfLifeMs: number): number {
  const alpha = 1 - Math.exp((-dtMs * Math.LN2) / halfLifeMs);
  return prev + alpha * (sample - prev);
}
