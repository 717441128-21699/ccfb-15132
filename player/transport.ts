/**
 * 直播传输层：消费 /api/live 的分帧 CMAF 流。
 *
 * 帧格式（大端）：u64 publishAtMs | u32 seq | u32 byteLength | payload
 * （墙钟毫秒超过 2^32，publishAt 必须用 64 位）
 * seq === 0xFFFFFFFF 表示 init 帧。
 *
 * 职责：
 *  - 增量解析字节流，按 chunk 回调（不跨帧拼包）
 *  - 以「服务端发布时间 -> 客户端收齐时间」统计每个 chunk 的传输耗时，
 *    供 ABR 用 bytes*8/ms 计算瞬时吞吐
 *  - 支持 abort()（ABR 切档 / 切赛场时立即断开）
 */

export const FRAME_HEADER_BYTES = 16;
export const INIT_FRAME_SEQ = 0xffffffff;

export interface InitFrame {
  kind: 'init';
  data: Uint8Array;
}

export interface MediaFrame {
  kind: 'media';
  /** 服务端计划发布墙钟 ms（端到端延迟基准） */
  publishAt: number;
  /** 全局单调分片序号 */
  seq: number;
  data: Uint8Array;
  /** 本帧字节数 */
  bytes: number;
  /** 从发布到客户端收齐的耗时 ms（含网络模拟的限速/抖动） */
  transferMs: number;
  /** 收齐时的客户端墙钟 ms */
  receivedAt: number;
}

export type LiveFrame = InitFrame | MediaFrame;

export interface ThroughputSample {
  bps: number;
  bytes: number;
  transferMs: number;
  at: number;
}

export interface TransportHandlers {
  onFrame: (frame: LiveFrame) => void;
  onThroughput?: (sample: ThroughputSample) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export class LiveTransport {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private active = false;
  framesReceived = 0;
  initReceived = false;
  /** 最近一个媒体帧的分片序号 */
  lastSeq = -1;

  constructor(
    private readonly url: string,
    private readonly handlers: TransportHandlers,
    private readonly clock: () => number = Date.now,
  ) {}

  get running(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.controller = new AbortController();
    try {
      const resp = await fetch(this.url, {
        signal: this.controller.signal,
        headers: { Accept: 'application/octet-stream' },
        cache: 'no-store',
      });
      if (!resp.ok || !resp.body) throw new Error(`live fetch failed: HTTP ${resp.status}`);
      this.reader = resp.body.getReader();
      await this.pump();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.handlers.onError?.(err as Error);
    } finally {
      this.active = false;
      this.handlers.onEnd?.();
    }
  }

  private async pump(): Promise<void> {
    const reader = this.reader!;
    while (this.active) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) this.feed(value);
    }
  }

  /** 注入一段字节，解析出所有完整帧（测试可直接调用，绕过 fetch）。 */
  feed(chunk: Uint8Array): void {
    const incoming: Uint8Array<ArrayBuffer> =
      chunk.buffer instanceof ArrayBuffer
        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Uint8Array.from(chunk);
    this.buf = this.buf.length === 0 ? incoming : concat2(this.buf, incoming);
    let offset = 0;
    while (this.buf.length - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset, FRAME_HEADER_BYTES);
      const publishAt = Number(view.getBigUint64(0));
      const seq = view.getUint32(8);
      const length = view.getUint32(12);
      if (this.buf.length - offset - FRAME_HEADER_BYTES < length) break; // 等下一帧
      const payload = this.buf.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length);
      const receivedAt = this.clock();
      this.dispatch(publishAt, seq, payload, receivedAt);
      offset += FRAME_HEADER_BYTES + length;
    }
    this.buf = offset > 0 ? this.buf.slice(offset) : this.buf;
  }

  private dispatch(publishAt: number, seq: number, payload: Uint8Array, receivedAt: number): void {
    this.framesReceived++;
    if (seq === INIT_FRAME_SEQ) {
      this.initReceived = true;
      this.handlers.onFrame({ kind: 'init', data: payload.slice() });
      return;
    }
    this.lastSeq = seq;
    const transferMs = Math.max(0, receivedAt - publishAt);
    const frame: MediaFrame = {
      kind: 'media',
      publishAt,
      seq,
      data: payload.slice(),
      bytes: payload.byteLength,
      transferMs,
      receivedAt,
    };
    this.handlers.onThroughput?.({
      bps: transferMs > 0 ? (payload.byteLength * 8 * 1000) / transferMs : Number.POSITIVE_INFINITY,
      bytes: payload.byteLength,
      transferMs,
      at: receivedAt,
    });
    this.handlers.onFrame(frame);
  }

  abort(): void {
    this.active = false;
    try {
      this.reader?.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
    this.controller?.abort();
    this.reader = null;
    this.buf = new Uint8Array(new ArrayBuffer(0));
  }
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
