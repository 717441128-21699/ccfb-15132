/**
 * 赛场切换器：双 video 元素轮换，实现「切赛场不黑屏」。
 *
 * 流程：
 *  1. A 元素正在显示并播放当前赛场；B 元素隐藏、静音附着
 *  2. 切换时在 B 上创建新播放器并拉流，B 与 A 同尺寸叠放（visibility:hidden 仍可解码）
 *  3. B 首帧进入 playing 且有稳定缓冲后，把 B 切为可见、A 隐藏
 *  4. 销毁 A 上的旧播放器，A 成为下一次切换的备用元素
 *
 * 若浏览器对隐藏元素限流，退化为在 A 上贴一张当前帧 canvas 快照兜底，仍避免黑屏。
 */
import { LLMsePlayer, type PlayerConfig, type PlayerSnapshot } from './player.ts';
import type { VenueManifest } from '../shared/protocol.ts';

export class VenueSwitcher {
  private players = new Map<HTMLVideoElement, LLMsePlayer>();
  private active: HTMLVideoElement;
  private standby: HTMLVideoElement;
  private switching = false;
  private snapshotCallbacks = new Set<(snap: PlayerSnapshot, venue: VenueManifest) => void>();

  constructor(
    private readonly host: HTMLElement,
    private venues: VenueManifest[],
    private config: Partial<PlayerConfig> = {},
  ) {
    this.active = this.createVideoElement('video-a');
    this.standby = this.createVideoElement('video-b');
    this.active.style.visibility = 'visible';
    this.standby.style.visibility = 'hidden';
  }

  private createVideoElement(id: string): HTMLVideoElement {
    const el = document.createElement('video');
    el.id = id;
    el.playsInline = true;
    el.muted = true;
    el.autoplay = false;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    el.style.background = '#000';
    this.host.appendChild(el);
    return el;
  }

  get activeVideo(): HTMLVideoElement {
    return this.active;
  }

  get activePlayer(): LLMsePlayer | undefined {
    return this.players.get(this.active);
  }

  get isSwitching(): boolean {
    return this.switching;
  }

  onSnapshot(fn: (snap: PlayerSnapshot, venue: VenueManifest) => void): () => void {
    this.snapshotCallbacks.add(fn);
    return () => this.snapshotCallbacks.delete(fn);
  }

  /** 首次进入：在 active 元素上起播第一个赛场。 */
  async start(venueId: string): Promise<void> {
    const venue = this.requireVenue(venueId);
    const player = new LLMsePlayer(this.active, venue, this.config);
    this.wirePlayer(player, venue);
    this.players.set(this.active, player);
    await player.start(venue);
  }

  /** 切换赛场：在备用元素预拉流，首帧后交换显示。 */
  async switchTo(venueId: string): Promise<void> {
    const venue = this.requireVenue(venueId);
    const current = this.activePlayer;
    if (current && current.currentVenue.id === venue.id) return;
    if (this.switching) return;
    this.switching = true;

    // 兜底：贴当前帧快照，防止隐藏元素解码受限期间出现黑场
    const fallback = this.capturePoster(this.active);

    try {
      // 销毁备用元素上的旧播放器（上一轮残留）
      const old = this.players.get(this.standby);
      if (old) {
        await old.dispose();
        this.players.delete(this.standby);
      }

      const player = new LLMsePlayer(this.standby, venue, this.config);
      this.wirePlayer(player, venue);
      this.players.set(this.standby, player);
      await player.start(venue);

      await this.waitForFirstFrames(this.standby, player);

      // 交换可见性
      this.standby.style.visibility = 'visible';
      this.active.style.visibility = 'hidden';
      if (fallback) this.host.removeChild(fallback);

      const prev = this.active;
      this.active = this.standby;
      this.standby = prev;

      // 释放旧播放器
      const oldPlayer = this.players.get(this.standby);
      if (oldPlayer) {
        await oldPlayer.dispose();
        this.players.delete(this.standby);
      }
    } catch (err) {
      if (fallback && fallback.parentElement) this.host.removeChild(fallback);
      throw err;
    } finally {
      this.switching = false;
    }
  }

  private waitForFirstFrames(el: HTMLVideoElement, player: LLMsePlayer, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        el.removeEventListener('playing', onPlaying);
        reject(new Error('venue switch timeout waiting for first frame'));
      }, timeoutMs);
      const onPlaying = (): void => {
        // 等到至少两个 rAF，确认画面已上屏而非仅触发事件
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timer);
          el.removeEventListener('playing', onPlaying);
          resolve();
        }));
      };
      el.addEventListener('playing', onPlaying, { once: true });
      void player;
    });
  }

  private capturePoster(video: HTMLVideoElement): HTMLCanvasElement | null {
    if (video.readyState < 2) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.objectFit = 'contain';
      this.host.appendChild(canvas);
      return canvas;
    } catch {
      return null;
    }
  }

  private wirePlayer(player: LLMsePlayer, venue: VenueManifest): void {
    player.onSnapshot((snap) => {
      for (const fn of this.snapshotCallbacks) fn(snap, venue);
    });
  }

  private requireVenue(id: string): VenueManifest {
    const v = this.venues.find((x) => x.id === id);
    if (!v) throw new Error(`unknown venue ${id}`);
    return v;
  }

  updateConfig(config: Partial<PlayerConfig>): void {
    this.config = { ...this.config, ...config };
    for (const p of this.players.values()) {
      if (config.autoAbr !== undefined) p.setAutoAbr(config.autoAbr);
      if (config.manualIndex !== undefined) p.setManualIndex(config.manualIndex);
      if (config.simQuery !== undefined) p.setSimQuery(config.simQuery);
    }
  }

  async dispose(): Promise<void> {
    for (const p of this.players.values()) await p.dispose();
    this.players.clear();
    this.host.innerHTML = '';
  }
}
