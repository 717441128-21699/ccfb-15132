/**
 * 连接级网络模拟器：在真实 TCP 之外再叠加一层「带宽 / 延迟 / 抖动 / 丢包」。
 *
 * - 带宽：维护一条串行管道，每个 chunk 的传输完成时间 = max(到达, 管道空闲)
 *   + 字节数*8/带宽；带宽为 0 表示不限速。
 * - 延迟/抖动：传输完成后再叠加固定延迟与均匀随机抖动。
 * - 丢包：以 chunk 为粒度按概率整体丢弃（模拟一次突发丢包）；被丢 chunk
 *   的 tfdt 缺口由解码器跳帧处理，直播时间轴不等待、不重传。
 * RNG 可注入，测试用确定性种子，线上用 Math.random。
 */

export interface SimParams {
  latencyMs: number;
  jitterMs: number;
  /** 0..1 */
  lossRate: number;
  /** bps，0 表示不限速 */
  bandwidthBps: number;
}

export const DEFAULT_SIM: SimParams = { latencyMs: 0, jitterMs: 0, lossRate: 0, bandwidthBps: 0 };

export interface ScheduledDelivery {
  /** 计划投递的墙钟时间 ms */
  at: number;
  data: Uint8Array;
  dropped: boolean;
}

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class NetworkSimulator {
  private pipeFreeAt = 0;
  readonly droppedChunks: number[] = [];
  delivered = 0;
  scheduled = 0;

  constructor(
    readonly params: SimParams,
    private readonly rng: Rng = Math.random,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 计算一个 chunk 的投递计划；丢包时 dropped=true（仍占位以保持管道串行）。 */
  schedule(data: Uint8Array): ScheduledDelivery {
    const now = this.clock();
    this.scheduled++;
    const size = data.byteLength;
    let transferMs = 0;
    if (this.params.bandwidthBps > 0) {
      transferMs = (size * 8 * 1000) / this.params.bandwidthBps;
    }
    const start = Math.max(now, this.pipeFreeAt);
    const completeAt = start + transferMs;
    this.pipeFreeAt = completeAt;

    const jitter = this.params.jitterMs > 0 ? (this.rng() * 2 - 1) * this.params.jitterMs : 0;
    const at = completeAt + this.params.latencyMs + jitter;

    const dropped = this.params.lossRate > 0 && this.rng() < this.params.lossRate;
    if (dropped) this.droppedChunks.push(this.scheduled - 1);
    else this.delivered++;

    return { at, data, dropped };
  }
}

/** 从 query string 解析模拟参数（调试页使用），缺省走 DEFAULT_SIM。 */
export function parseSimParams(search: URLSearchParams): SimParams {
  const num = (k: string, min: number, max: number, dflt: number): number => {
    const raw = search.get(k);
    if (raw === null) return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(max, Math.max(min, v));
  };
  return {
    latencyMs: num('simLatency', 0, 10_000, 0),
    jitterMs: num('simJitter', 0, 5_000, 0),
    lossRate: num('simLoss', 0, 1, 0),
    bandwidthBps: num('simBw', 0, 1_000_000_000, 0),
  };
}
