/**
 * 轻量实时折线图（Canvas，无第三方依赖）。
 * 支持多序列、固定时间窗口、自适应 devicePixelRatio 与容器宽度。
 */
export interface ChartSeries {
  label: string;
  color: string;
  points: Array<{ t: number; v: number }>;
}

export interface ChartOptions {
  title: string;
  unit: string;
  /** y 轴固定范围；不指定则自适应数据 */
  min?: number;
  max?: number;
  /** 时间窗口 ms */
  windowMs?: number;
  /** 可选阈值线 */
  threshold?: { value: number; color: string; label?: string };
}

export class LineChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private series: ChartSeries[] = [];
  private opts: ChartOptions;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, opts: ChartOptions) {
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  setSeries(series: ChartSeries[]): void {
    this.series = series;
    this.draw();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(200, rect.width || (this.canvas.parentElement?.clientWidth ?? 600));
    const h = 220;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    const padL = 52;
    const padR = 12;
    const padT = 28;
    const padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const now = performance.now();
    const windowMs = this.opts.windowMs ?? 60_000;
    const tMin = now - windowMs;
    const tMax = now;

    // 标题与图例
    ctx.fillStyle = '#9aa7b4';
    ctx.font = '12px system-ui';
    ctx.fillText(`${this.opts.title} (${this.opts.unit})`, padL, 16);
    let legendX = padL + 180;
    for (const s of this.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, 9, 10, 3);
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(s.label, legendX + 14, 14);
      legendX += ctx.measureText(s.label).width + 34;
    }

    // y 轴范围
    let yMin = this.opts.min;
    let yMax = this.opts.max;
    if (yMin === undefined || yMax === undefined) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of this.series) {
        for (const p of s.points) {
          if (p.t < tMin) continue;
          lo = Math.min(lo, p.v);
          hi = Math.max(hi, p.v);
        }
      }
      if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
      if (lo === hi) {
        lo -= 1;
        hi += 1;
      }
      const pad = (hi - lo) * 0.15;
      yMin = yMin ?? lo - pad;
      yMax = yMax ?? hi + pad;
    }

    // 网格 + y 标签
    ctx.strokeStyle = '#222a34';
    ctx.fillStyle = '#6e7b88';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui';
    const rows = 4;
    for (let i = 0; i <= rows; i++) {
      const y = padT + (plotH * i) / rows;
      const val = yMax - ((yMax - yMin) * i) / rows;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(formatVal(val), 6, y + 3);
    }

    const xOf = (t: number): number => padL + ((t - tMin) / (tMax - tMin)) * plotW;
    const yOf = (v: number): number => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // 阈值线
    if (this.opts.threshold) {
      const th = this.opts.threshold;
      if (th.value >= yMin && th.value <= yMax) {
        ctx.strokeStyle = th.color;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        const y = yOf(th.value);
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (th.label) ctx.fillText(th.label, w - padR - ctx.measureText(th.label).width, y - 4);
      }
    }

    // 数据线
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let started = false;
      for (const p of s.points) {
        if (p.t < tMin) continue;
        const x = xOf(p.t);
        const y = yOf(p.v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // x 轴时间标签
    ctx.fillStyle = '#6e7b88';
    for (let i = 0; i <= 4; i++) {
      const t = tMin + (windowMs * i) / 4;
      const label = `${Math.round((tMax - t) / 1000)}s`;
      const x = xOf(t);
      ctx.fillText(label, x - 8, h - 6);
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
}

function formatVal(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(v < 10 && !Number.isInteger(v) ? 1 : 0);
}
