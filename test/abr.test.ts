import { describe, it, expect } from 'vitest';
import { AbrController } from '../player/abr.ts';
import type { RenditionInfo } from '../shared/protocol.ts';

const renditions: RenditionInfo[] = [
  { id: '480p', bitrate: 900_000, width: 854, height: 480, codecs: 'avc1,mp4a' },
  { id: '720p', bitrate: 1_800_000, width: 1280, height: 720, codecs: 'avc1,mp4a' },
  { id: '1080p', bitrate: 3_600_000, width: 1920, height: 1080, codecs: 'avc1,mp4a' },
];

/** 用固定步进的虚拟时钟，避免真实定时器。 */
function fakeClock(start = 100_000): { now: () => number; advance: (ms: number) => void; t: number } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

describe('AbrController', () => {
  it('downshifts within 2 seconds when bandwidth collapses', () => {
    const clock = fakeClock();
    const abr = new AbrController(renditions, { upgradeCooldownMs: 4000 }, 2, clock.now);
    // 先在 1080p 喂充足带宽
    for (let i = 0; i < 10; i++) {
      abr.sample(5_000_000, clock.now());
      clock.advance(200);
    }
    expect(abr.index).toBe(2);

    // 带宽跌到 500kbps：安全系数后撑不住 1080p/720p/甚至 480p 边缘
    const decisions: number[] = [];
    const start = clock.now();
    let downshiftedAt = -1;
    for (let i = 0; i < 20; i++) {
      abr.sample(500_000, clock.now());
      const d = abr.decide(clock.now(), true);
      if (d) {
        decisions.push(d.index);
        if (downshiftedAt < 0) downshiftedAt = clock.now() - start;
      }
      clock.advance(200);
    }
    expect(downshiftedAt).toBeGreaterThanOrEqual(0);
    expect(downshiftedAt).toBeLessThanOrEqual(2000); // 2 秒内降档
    expect(abr.index).toBe(0);
  });

  it('does not upshift on transient spikes (hysteresis + cooldown)', () => {
    const clock = fakeClock();
    const abr = new AbrController(renditions, {}, 0, clock.now);
    for (let i = 0; i < 8; i++) {
      abr.sample(1_000_000, clock.now());
      abr.decide(clock.now(), true);
      clock.advance(500);
    }
    expect(abr.index).toBe(0);
    // 单个高吞吐样本（瞬时尖峰）
    abr.sample(8_000_000, clock.now());
    const d = abr.decide(clock.now(), true);
    expect(d).toBeNull(); // 慢 EWMA 未跟上，不升级
    expect(abr.index).toBe(0);
  });

  it('upshifts after sustained bandwidth and cooldown', () => {
    const clock = fakeClock();
    const abr = new AbrController(renditions, { upgradeCooldownMs: 1000 }, 0, clock.now);
    for (let i = 0; i < 30; i++) {
      abr.sample(6_000_000, clock.now());
      abr.decide(clock.now(), true);
      clock.advance(500);
    }
    expect(abr.index).toBe(2); // 逐步升到顶档
  });

  it('stall forces one step down and locks upgrades', () => {
    const clock = fakeClock();
    const abr = new AbrController(renditions, { stallLockMs: 3000 }, 2, clock.now);
    const d = abr.notifyStall(clock.now());
    expect(d?.index).toBe(1);
    expect(abr.index).toBe(1);
    // 锁定期内即使带宽充裕也不升级
    abr.sample(10_000_000, clock.now());
    clock.advance(500);
    expect(abr.decide(clock.now(), true)).toBeNull();
    clock.advance(3000);
    expect(abr.decide(clock.now(), true)).not.toBeNull();
  });

  it('never drops below lowest rendition', () => {
    const clock = fakeClock();
    const abr = new AbrController(renditions, {}, 0, clock.now);
    expect(abr.notifyStall(clock.now())).toBeNull();
    abr.sample(1000, clock.now());
    const d = abr.decide(clock.now(), true);
    expect(d).toBeNull();
    expect(abr.index).toBe(0);
  });
});
