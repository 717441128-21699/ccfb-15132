/**
 * 调试台：带宽/延迟/抖动/丢包模拟 + 实时延迟与吞吐曲线。
 * 模拟参数通过 query 下发给服务端的 NetworkSimulator，可复现（固定种子）。
 */
import { LLMsePlayer } from '../player/player.ts';
import { LineChart, type ChartSeries } from './chart.ts';
import type { ManifestResponse, VenueManifest } from './types-shim.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface SimState {
  bw: number; // kbps，0=不限
  lat: number;
  jit: number;
  loss: number; // 百分比
  seed: number;
}

const PRESETS: Array<{ name: string; s: SimState }> = [
  { name: '家庭宽带', s: { bw: 5000, lat: 20, jit: 10, loss: 0, seed: 42 } },
  { name: '4G 波动', s: { bw: 1500, lat: 60, jit: 80, loss: 2, seed: 42 } },
  { name: '弱网', s: { bw: 600, lat: 120, jit: 150, loss: 8, seed: 42 } },
  { name: '突发丢包', s: { bw: 2500, lat: 40, jit: 30, loss: 15, seed: 7 } },
];

function log(msg: string): void {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function buildSimQuery(s: SimState): string {
  const p = new URLSearchParams();
  p.set('simBw', String(s.bw * 1000));
  p.set('simLatency', String(s.lat));
  p.set('simJitter', String(s.jit));
  p.set('simLoss', String(s.loss / 100));
  p.set('simSeed', String(s.seed));
  return p.toString();
}

async function main(): Promise<void> {
  const manifest = (await (await fetch('/api/manifest')).json()) as ManifestResponse;
  const venues = manifest.venues;

  const venueSelect = $<HTMLSelectElement>('venue-select');
  for (const v of venues) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    venueSelect.appendChild(opt);
  }

  const stage = $('stage');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  stage.appendChild(video);

  let venue: VenueManifest = venues[0];
  let player: LLMsePlayer | null = null;

  const latencyChart = new LineChart($('chart-latency'), {
    title: '端到端延迟', unit: 'ms', min: 0, max: 6000, windowMs: 60_000,
    threshold: { value: 3000, color: '#fb5607', label: '3s 目标' },
  });
  const bwChart = new LineChart($('chart-bw'), { title: '吞吐 / 码率', unit: 'bps', windowMs: 60_000 });

  function readState(): SimState {
    return {
      bw: Number($<HTMLInputElement>('bw').value),
      lat: Number($<HTMLInputElement>('lat').value),
      jit: Number($<HTMLInputElement>('jit').value),
      loss: Number($<HTMLInputElement>('loss').value),
      seed: Number($<HTMLInputElement>('seed').value) || 42,
    };
  }

  function syncLabels(s: SimState): void {
    $('bw-val').textContent = s.bw === 0 ? '不限' : `${s.bw} kbps`;
    $('lat-val').textContent = String(s.lat);
    $('jit-val').textContent = String(s.jit);
    $('loss-val').textContent = String(s.loss);
  }

  function wireCharts(): void {
    const hist = player?.metrics.history;
    if (!hist) return;
    const now = performance.now();
    const pts = hist.map((p, i) => ({ t: now - (hist.length - i) * 250, v: 0 }));
    latencyChart.setSeries([
      { label: '延迟', color: '#3a86ff', points: hist.map((p, i) => ({ t: pts[i].t, v: p.latencyMs })) },
    ]);
    bwChart.setSeries([
      { label: '当前码率', color: '#ffb703', points: hist.map((p, i) => ({ t: pts[i].t, v: p.bitrate })) },
      {
        label: '缓冲(ms)',
        color: '#06d6a0',
        points: hist.map((p, i) => ({ t: pts[i].t, v: p.bufferMs })),
      },
    ]);
  }

  async function spawn(s: SimState): Promise<void> {
    if (player) {
      await player.dispose();
      player = null;
    }
    player = new LLMsePlayer(video, venue, { autoAbr: true, manualIndex: 0, simQuery: buildSimQuery(s) });
    player.onLog((m) => log(m));
    player.onError((e) => log(`错误：${e.message}`));
    player.onSnapshot((snap) => {
      $('s-latency').textContent = String(Math.round(snap.latencyMs));
      $('s-stalls').textContent = String(player?.metrics.stalls ?? 0);
      $('s-stallms').textContent = String(player?.metrics.stallMs ?? 0);
      $('s-rend').textContent = venue.renditions[snap.renditionIndex].id;
      $('s-bw').textContent = Number.isFinite(snap.estimateBps) ? Math.round(snap.estimateBps).toString() : '–';
      $('s-rate').textContent = snap.rate.toFixed(2);
      $('s-buffer').textContent = String(Math.round(snap.bufferMs));
      wireCharts();
    });
    await player.start(venue);
    log(`拉流：${venue.name}，sim=${buildSimQuery(s)}`);
  }

  // 预设按钮
  const presetBox = $('presets');
  for (const pre of PRESETS) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = pre.name;
    b.onclick = () => {
      setInputs(pre.s);
      syncLabels(pre.s);
    };
    presetBox.appendChild(b);
  }

  function setInputs(s: SimState): void {
    $<HTMLInputElement>('bw').value = String(s.bw);
    $<HTMLInputElement>('lat').value = String(s.lat);
    $<HTMLInputElement>('jit').value = String(s.jit);
    $<HTMLInputElement>('loss').value = String(s.loss);
    $<HTMLInputElement>('seed').value = String(s.seed);
  }

  for (const id of ['bw', 'lat', 'jit', 'loss']) {
    $<HTMLInputElement>(id).addEventListener('input', () => syncLabels(readState()));
  }

  $('apply').addEventListener('click', () => {
    const s = readState();
    syncLabels(s);
    void spawn(s);
  });
  $('reset').addEventListener('click', () => {
    const s: SimState = { bw: 0, lat: 0, jit: 0, loss: 0, seed: 42 };
    setInputs(s);
    syncLabels(s);
    void spawn(s);
  });
  venueSelect.addEventListener('change', () => {
    venue = venues.find((v) => v.id === venueSelect.value) ?? venues[0];
    void spawn(readState());
  });

  syncLabels(readState());
  await spawn(readState());
}

main().catch((err) => {
  console.error(err);
  log(`致命错误：${String(err)}`);
});
