/**
 * MSE 引擎：封装 MediaSource / SourceBuffer 的 append 队列与缓冲管理。
 *
 * - 所有 append 串行排队（SourceBuffer 同一时刻只接受一个 appendBuffer）
 * - 切档走 changeType(mime)，不重建 MediaSource
 * - 自动回收播放点之前的旧缓冲，防止内存无界增长
 * - 向上抛 waiting/playing 与队列水位事件
 */

export interface MseEngineEvents {
  onWaiting?: () => void;
  onPlaying?: () => void;
  onUpdateEnd?: () => void;
  onError?: (err: Error) => void;
}

interface QueuedAppend {
  data: Uint8Array;
  kind: 'init' | 'media';
}

const RETAIN_BEHIND_S = 2;

export class MseEngine {
  mediaSource: MediaSource;
  sourceBuffer: SourceBuffer | null = null;
  private queue: QueuedAppend[] = [];
  private updating = false;
  private currentMime = '';
  private objectUrl = '';
  private disposed = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: MseEngineEvents = {},
  ) {
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen);
    this.video.addEventListener('waiting', this.handleWaiting);
    this.video.addEventListener('playing', this.handlePlaying);
  }

  private handleSourceOpen = (): void => {
    // sourceBuffer 在 attach() 中按需创建
  };

  private handleWaiting = (): void => this.events.onWaiting?.();
  private handlePlaying = (): void => this.events.onPlaying?.();

  get isOpen(): boolean {
    return this.mediaSource.readyState === 'open';
  }

  get pendingBytes(): number {
    return this.queue.reduce((s, q) => s + q.data.byteLength, 0);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** 创建 SourceBuffer（codecs 来自清单 RFC6381 串）。 */
  attach(mime: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const doAttach = (): void => {
        try {
          if (!MediaSource.isTypeSupported(mime)) {
            reject(new Error(`MIME not supported by this browser: ${mime}`));
            return;
          }
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
          this.sourceBuffer.mode = 'segments';
          this.currentMime = mime;
          this.sourceBuffer.addEventListener('updateend', this.handleUpdateEnd);
          this.sourceBuffer.addEventListener('error', () =>
            this.events.onError?.(new Error('SourceBuffer error')),
          );
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      };
      if (this.mediaSource.readyState === 'open') doAttach();
      else this.mediaSource.addEventListener('sourceopen', doAttach, { once: true });
    });
  }

  /** 切码率/编码：下一次 append 前切换 SourceBuffer 类型。 */
  changeType(mime: string): void {
    if (mime === this.currentMime || !this.sourceBuffer) return;
    if (this.updating) {
      // 入队一个「类型变更」占位，等队列排空后执行
      this.queue.push({ data: new Uint8Array(0), kind: 'init' });
      this.pendingMime = mime;
      return;
    }
    this.applyChangeType(mime);
  }

  private pendingMime: string | null = null;

  private applyChangeType(mime: string): void {
    const sb = this.sourceBuffer;
    if (!sb || mime === this.currentMime) return;
    // changeType 在较老浏览器可能不存在；不存在则跳过（同编码不同码率通常可直接 append）
    if (typeof sb.changeType === 'function') sb.changeType(mime);
    this.currentMime = mime;
  }

  appendInit(data: Uint8Array): void {
    this.enqueue({ data, kind: 'init' });
  }

  appendMedia(data: Uint8Array): void {
    this.enqueue({ data, kind: 'media' });
  }

  private enqueue(item: QueuedAppend): void {
    if (this.disposed) return;
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    if (this.updating || !this.sourceBuffer || this.queue.length === 0) return;
    const item = this.queue.shift()!;

    // 零长度 init 占位 = changeType 请求
    if (item.kind === 'init' && item.data.byteLength === 0 && this.pendingMime) {
      const mime = this.pendingMime;
      this.pendingMime = null;
      this.applyChangeType(mime);
      this.pump();
      return;
    }

    this.updating = true;
    try {
      // 显式拷贝到 ArrayBuffer 支撑的 Uint8Array，满足 DOM lib 的 BufferSource 约束
      const copy = new Uint8Array(item.data.byteLength);
      copy.set(item.data);
      this.sourceBuffer.appendBuffer(copy);
    } catch (err) {
      this.updating = false;
      this.events.onError?.(err as Error);
    }
  }

  private handleUpdateEnd = (): void => {
    this.updating = false;
    this.evict();
    this.events.onUpdateEnd?.();
    this.pump();
  };

  /** 回收播放点之前的缓冲（保留少量回看余量）。 */
  private evict(): void {
    const sb = this.sourceBuffer;
    if (!sb || this.updating || sb.buffered.length === 0) return;
    const current = this.video.currentTime;
    const removeEnd = current - RETAIN_BEHIND_S;
    if (removeEnd > sb.buffered.start(0)) {
      try {
        sb.remove(0, removeEnd);
      } catch {
        /* remove 与 update 状态冲突时忽略，下轮再试 */
      }
    }
  }

  /** 当前已缓冲的时间范围（秒），无缓冲返回 null。 */
  buffered(): TimeRanges | null {
    if (!this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return null;
    return this.sourceBuffer.buffered;
  }

  /** 播放点之后的可播缓冲秒数。 */
  aheadBufferSeconds(): number {
    const b = this.buffered();
    if (!b) return 0;
    const now = this.video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (now >= b.start(i) && now <= b.end(i)) return b.end(i) - now;
    }
    // 播放点尚未进入任何范围（起播前）：返回第一段长度
    return b.end(0) - b.start(0);
  }

  /** 缓冲最末端的媒体时间（秒）。 */
  bufferEnd(): number | null {
    const b = this.buffered();
    return b ? b.end(b.length - 1) : null;
  }

  async flush(): Promise<void> {
    while (this.updating || this.queue.length > 0) {
      await new Promise<void>((r) => setTimeout(r, 10));
      if (this.disposed) return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('playing', this.handlePlaying);
    if (this.sourceBuffer) {
      this.sourceBuffer.removeEventListener('updateend', this.handleUpdateEnd);
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      } catch {
        /* ignore */
      }
    }
    this.mediaSource.removeEventListener('sourceopen', this.handleSourceOpen);
    URL.revokeObjectURL(this.objectUrl);
    this.video.removeAttribute('src');
  }
}
