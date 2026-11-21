import { describe, it, expect } from 'vitest';
import { NetworkSimulator, mulberry32, parseSimParams, DEFAULT_SIM } from '../server/network-sim.ts';

describe('NetworkSimulator', () => {
  it('deterministic RNG produces repeatable loss sequences', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(mulberry32(999)()).not.toBe(seqA[0]);
  });

  it('bandwidth limits serialize chunks through the pipe', () => {
    let now = 1000;
    const sim = new NetworkSimulator(
      { bandwidthBps: 8000, latencyMs: 0, jitterMs: 0, lossRate: 0 },
      () => 0,
      () => now,
    );
    // 1000 字节 = 8000 bit -> 1000ms
    const d1 = sim.schedule(new Uint8Array(1000));
    expect(d1.at).toBe(2000);
    // 第二个块必须等管道空闲，不能并行超车
    now = 1500;
    const d2 = sim.schedule(new Uint8Array(1000));
    expect(d2.at).toBe(3000);
  });

  it('applies latency and jitter on top of transfer time', () => {
    let now = 0;
    const fixed = mulberry32(1);
    const sim = new NetworkSimulator(
      { bandwidthBps: 0, latencyMs: 50, jitterMs: 20, lossRate: 0 },
      fixed,
      () => now,
    );
    const d = sim.schedule(new Uint8Array(10));
    // rng() 已知为某固定值，断言落在 [50-20, 50+20] 区间即可
    expect(d.at).toBeGreaterThanOrEqual(30);
    expect(d.at).toBeLessThanOrEqual(70);
  });

  it('drops chunks at the configured rate with seeded rng', () => {
    const rng = mulberry32(7);
    const sim = new NetworkSimulator(
      { bandwidthBps: 0, latencyMs: 0, jitterMs: 0, lossRate: 0.5 },
      rng,
      () => 0,
    );
    let dropped = 0;
    for (let i = 0; i < 200; i++) {
      if (sim.schedule(new Uint8Array(10)).dropped) dropped++;
    }
    // 200 次、50% 概率，给宽松边界
    expect(dropped).toBeGreaterThan(60);
    expect(dropped).toBeLessThan(140);
    expect(sim.droppedChunks.length).toBe(dropped);
  });

  it('unlimited bandwidth delivers immediately (plus latency)', () => {
    const sim = new NetworkSimulator(
      { bandwidthBps: 0, latencyMs: 5, jitterMs: 0, lossRate: 0 },
      () => 0.5,
      () => 100,
    );
    const d = sim.schedule(new Uint8Array(1_000_000));
    expect(d.at).toBe(105);
    expect(d.dropped).toBe(false);
  });
});

describe('parseSimParams', () => {
  it('returns defaults when query is empty', () => {
    expect(parseSimParams(new URLSearchParams())).toEqual(DEFAULT_SIM);
  });

  it('parses and clamps values', () => {
    const p = parseSimParams(
      new URLSearchParams('simBw=1000000&simLatency=80&simJitter=10&simLoss=0.2&simSeed=3'),
    );
    expect(p).toEqual({ bandwidthBps: 1_000_000, latencyMs: 80, jitterMs: 10, lossRate: 0.2 });

    const clamped = parseSimParams(new URLSearchParams('simLoss=99&simLatency=-50'));
    expect(clamped.lossRate).toBe(1);
    expect(clamped.latencyMs).toBe(0);
  });

  it('ignores non-numeric garbage', () => {
    const p = parseSimParams(new URLSearchParams('simBw=abc&simJitter='));
    expect(p.bandwidthBps).toBe(0);
    expect(p.jitterMs).toBe(0);
  });
});
