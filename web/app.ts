/**
 * 播放页：赛场切换 + 双 video 无黑场 + ABR 控制 + 实时曲线。
 */
import { VenueSwitcher } from '../player/venue-switcher.ts';
import { LineChart, type ChartSeries } from './chart.ts';
import type { ManifestResponse, VenueManifest, PlayerSnapshot } from './types-shim.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function loadManifest(): Promise<ManifestResponse> {
  const resp = await fetch('/api/manifest');
  if (!resp.ok) throw new Error(`manifest HTTP ${resp.status}`);
  return (await resp.json()) as ManifestResponse;
}

function log(msg: string): void {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const venues = manifest.venues;
  const stage = $('stage');

  // 赛场页签
  const tabs = $('venue-tabs');
  for (const v of venues) {
    const btn = document.createElement('button');
    btn.className = 'btn venue-tab';
    btn.dataset.venue = v.id;
    btn.textContent = v.name;
    btn.onclick = () => void switchVenue(v, btn);
    tabs.appendChild(btn);
  }

  const switcher = new VenueSwitcher(stage, venues, { autoAbr: true, manualIndex: 0 });

  // 码率下拉
  const renditionSelect = $<HTMLSelectElement>('rendition-select');
  const abrToggle = $<HTMLInputElement>('abr-toggle');

  function fillRenditions(venue: VenueManifest): void {
    renditionSelect.innerHTML = '';
    venue.renditions.forEach((r, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${r.id} · ${r.height}p · ${(r.bitrate / 1e6).toFixed(2)} Mbps`;
      renditionSelect.appendChild(opt);
    });
  }

  // 曲线
  const latencyChart = new LineChart($('chart-latency'), {
    title: '端到端延迟',
    unit: 'ms',
    min: 0,
    max: 5000,
    windowMs: 60_000,
    threshold: { value: 3000, color: '#fb5607', label: '3s 目标' },
  });
  const bufferChart = new LineChart($('chart-buffer'), {
    title: '缓冲时长 / 当前码率',
    unit: 'ms / bps',
    windowMs: 60_000,
  });

  let latestSnap: PlayerSnapshot | null = null;
  let latestVenue: VenueManifest = venues[0];

  switcher.onSnapshot((snap, venue) => {
    latestSnap = snap;
    latestVenue = venue;
    renderStats(snap, venue);
    renderCharts();
  });

  function renderStats(snap: PlayerSnapshot, venue: VenueManifest): void {
    $('s-latency').textContent = String(Math.round(snap.latencyMs));
    $('s-startup').textContent = String(switcher.activePlayer?.metrics.startupMs ?? 0);
    $('s-stalls').textContent = String(switcher.activePlayer?.metrics.stalls ?? 0);
    $('s-stallms').textContent = String(switcher.activePlayer?.metrics.stallMs ?? 0);
    $('s-bitrate').textContent = String(snap.bitrate);
    $('s-rate').textContent = snap.rate.toFixed(2);
    $('s-buffer').textContent = String(Math.round(snap.bufferMs));
    $('s-bw').textContent = Number.isFinite(snap.estimateBps) ? Math.round(snap.estimateBps).toString() : '–';
    renditionSelect.value = String(snap.renditionIndex);
    const m = switcher.activePlayer?.metrics;
    $('switch-count').textContent = `档位切换 ${m?.switches ?? 0} 次 · 赛场切换 ${m?.venueSwitches ?? 0} 次`;
    const pill = $('live-pill');
    pill.classList.toggle('stall', snap.stalling);
    $('live-text').textContent = snap.stalling ? '卡顿中' : `${venue.name} · 直播中`;
  }

  function renderCharts(): void {
    const hist = switcher.activePlayer?.metrics.history;
    if (!hist) return;
    const now = performance.now();
    const latencySeries: ChartSeries = {
      label: '延迟',
      color: '#3a86ff',
      points: hist.map((p, i) => ({ t: now - (hist.length - i) * 250, v: p.latencyMs })),
    };
    const bufferSeries: ChartSeries = {
      label: '缓冲(ms)',
      color: '#06d6a0',
      points: hist.map((p, i) => ({ t: now - (hist.length - i) * 250, v: p.bufferMs })),
    };
    const bitrateSeries: ChartSeries = {
      label: '码率(bps)',
      color: '#ffb703',
      points: hist.map((p, i) => ({ t: now - (hist.length - i) * 250, v: p.bitrate })),
    };
    latencyChart.setSeries([latencySeries]);
    bufferChart.setSeries([bufferSeries, bitrateSeries]);
  }

  async function switchVenue(venue: VenueManifest, btn: HTMLButtonElement): Promise<void> {
    document.querySelectorAll('.venue-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    fillRenditions(venue);
    try {
      await switcher.switchTo(venue.id);
      log(`切换到赛场：${venue.name}`);
    } catch (err) {
      log(`赛场切换失败：${(err as Error).message}`);
    }
  }

  abrToggle.onchange = (): void => {
    const auto = abrToggle.checked;
    renditionSelect.disabled = auto;
    switcher.updateConfig({ autoAbr: auto });
    log(auto ? '开启自动 ABR' : '关闭自动 ABR（手动选档）');
  };

  renditionSelect.onchange = (): void => {
    const idx = Number(renditionSelect.value);
    switcher.updateConfig({ autoAbr: false, manualIndex: idx });
    abrToggle.checked = false;
    renditionSelect.disabled = false;
    log(`手动切档：${latestVenue.renditions[idx].id}`);
  };

  // 启动
  fillRenditions(venues[0]);
  const firstTab = document.querySelector<HTMLButtonElement>('.venue-tab');
  firstTab?.classList.add('active');
  await switcher.start(venues[0].id);
  log(`已起播：${venues[0].name}（session ${switcher.activePlayer?.getSessionId().slice(0, 8)}…）`);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fb5607;padding:20px">${String(err)}</pre>`);
});
