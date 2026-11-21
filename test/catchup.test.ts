import { describe, it, expect } from 'vitest';
import { CatchUpController } from '../player/catchup.ts';

describe('CatchUpController', () => {
  it('stays at 1.0 inside the dead band', () => {
    const c = new CatchUpController();
    expect(c.update(1500, false)).toBe(1);
    expect(c.update(1800, false)).toBe(1);
    expect(c.update(1200, false)).toBe(1);
  });

  it('gently accelerates when latency exceeds target + deadband', () => {
    const c = new CatchUpController();
    const rates: number[] = [];
    // 延迟 4s（超出 2.15s），连续决策应平滑爬升到 <= maxRate
    for (let i = 0; i < 30; i++) rates.push(c.update(4000, false));
    expect(rates[0]).toBeGreaterThan(1);
    expect(rates[rates.length - 1]).toBeLessThanOrEqual(1.1);
    expect(rates[rates.length - 1]).toBeGreaterThan(1.05);
    // 单调不减（斜率限制下）
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1] - 1e-9);
  });

  it('slows down when too close to the live edge', () => {
    const c = new CatchUpController();
    let r = 1;
    for (let i = 0; i < 30; i++) r = c.update(200, false); // 远低于目标
    expect(r).toBeGreaterThanOrEqual(0.95);
    expect(r).toBeLessThan(1);
  });

  it('returns to neutral when latency recovers', () => {
    const c = new CatchUpController();
    for (let i = 0; i < 30; i++) c.update(4000, false);
    let r = 1.1;
    for (let i = 0; i < 40; i++) r = c.update(1500, false);
    expect(r).toBe(1);
  });

  it('neutralizes rate while stalled', () => {
    const c = new CatchUpController();
    c.update(4000, false);
    expect(c.update(4000, true)).toBe(1);
  });

  it('rate changes are slope-limited per tick', () => {
    const c = new CatchUpController();
    let prev = 1;
    for (let i = 0; i < 5; i++) {
      const r = c.update(5000, false);
      expect(Math.abs(r - prev)).toBeLessThanOrEqual(0.02 + 1e-9);
      prev = r;
    }
  });
});
