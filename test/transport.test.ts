import { describe, it, expect } from 'vitest';
import { LiveTransport, FRAME_HEADER_BYTES, INIT_FRAME_SEQ, type LiveFrame } from '../player/transport.ts';

function frame(publishAt: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, BigInt(publishAt));
  dv.setUint32(8, seq);
  dv.setUint32(12, payload.length);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

describe('LiveTransport frame parser', () => {
  it('parses init and media frames delivered in one chunk', () => {
    let t = 100_000;
    const clock = (): number => t;
    const frames: LiveFrame[] = [];
    const tp = new LiveTransport('http://unused', { onFrame: (f) => frames.push(f) }, clock);

    const init = frame(0, INIT_FRAME_SEQ, new Uint8Array([1, 2, 3, 4]));
    const media = frame(99_000, 7, new Uint8Array(100).fill(9));
    tp.feed(concat(init, media));

    expect(frames).toHaveLength(2);
    expect(frames[0].kind).toBe('init');
    if (frames[0].kind === 'init') expect(Array.from(frames[0].data)).toEqual([1, 2, 3, 4]);
    expect(frames[1].kind).toBe('media');
    if (frames[1].kind === 'media') {
      expect(frames[1].seq).toBe(7);
      expect(frames[1].bytes).toBe(100);
      expect(frames[1].transferMs).toBe(1000); // 100000 - 99000
    }
    expect(tp.initReceived).toBe(true);
    expect(tp.lastSeq).toBe(7);
  });

  it('handles byte-by-byte delivery (partial frames)', () => {
    let t = 50_000;
    const clock = (): number => t;
    const frames: LiveFrame[] = [];
    const tp = new LiveTransport('http://unused', { onFrame: (f) => frames.push(f) }, clock);

    const f1 = frame(49_000, 1, new Uint8Array([7, 8]));
    const f2 = frame(49_500, 2, new Uint8Array([9]));
    const all = concat(f1, f2);
    for (const byte of all) {
      t += 1;
      tp.feed(new Uint8Array([byte]));
    }
    expect(frames).toHaveLength(2);
    expect(frames[0].kind).toBe('media');
    expect(frames[1].kind).toBe('media');
  });

  it('emits throughput samples per media frame', () => {
    const samples: number[] = [];
    const tp = new LiveTransport(
      'http://unused',
      { onFrame: () => undefined, onThroughput: (s) => samples.push(s.bps) },
      () => 200_000,
    );
    // 1000 字节，发布于 199000，收于 200000 -> 1000ms
    tp.feed(frame(199_000, 0, new Uint8Array(1000)));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo((1000 * 8 * 1000) / 1000, 5); // 8000 bps
  });

  it('does not emit a frame until full payload arrives', () => {
    const frames: LiveFrame[] = [];
    const tp = new LiveTransport('http://unused', { onFrame: (f) => frames.push(f) }, () => 0);
    const full = frame(0, 0, new Uint8Array(50));
    tp.feed(full.subarray(0, 20));
    expect(frames).toHaveLength(0);
    tp.feed(full.subarray(20));
    expect(frames).toHaveLength(1);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
