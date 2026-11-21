/**
 * 统计页：轮询 /api/stats，展示每个观众端的起播时间与卡顿次数等指标。
 */
import type { StatsResponse, ViewerRecord } from './types-shim.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmtTime(ms: number): string {
  if (!ms) return '–';
  return new Date(ms).toLocaleTimeString();
}

function latencyBadge(ms: number): string {
  if (ms <= 3000) return '<span class="badge good">≤3s</span>';
  if (ms <= 5000) return '<span class="badge warn">偏高</span>';
  return '<span class="badge bad">超标</span>';
}

function render(data: StatsResponse): void {
  const viewers = data.viewers;
  $('online-count').textContent = String(viewers.length);
  $('updated-at').textContent = `更新于 ${new Date().toLocaleTimeString()}`;

  const started = viewers.filter((v) => v.startupMs > 0);
  const avgStartup = started.length ? started.reduce((s, v) => s + v.startupMs, 0) / started.length : 0;
  const live = viewers.filter((v) => v.latencyMs > 0);
  const avgLatency = live.length ? live.reduce((s, v) => s + v.latencyMs, 0) / live.length : 0;
  const stalled = viewers.filter((v) => v.stalls > 0).length;
  const totalStalls = viewers.reduce((s, v) => s + v.stalls, 0);

  $('avg-startup').textContent = avgStartup ? Math.round(avgStartup).toString() : '–';
  $('avg-latency').textContent = avgLatency ? Math.round(avgLatency).toString() : '–';
  $('stall-ratio').textContent = viewers.length ? ((stalled / viewers.length) * 100).toFixed(1) : '0.0';
  $('total-stalls').textContent = String(totalStalls);

  const tbody = $('rows');
  tbody.innerHTML = '';
  if (viewers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="small" style="text-align:center;padding:24px">暂无在线观众，打开播放器页后约 2 秒出现</td></tr>';
    return;
  }
  for (const v of viewers as ViewerRecord[]) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num"><code>${v.sessionId.slice(0, 13)}</code></td>
      <td>${v.venue}</td>
      <td class="num">${fmtTime(v.firstFrameAt || v.startAt)}</td>
      <td class="num">${v.startupMs}</td>
      <td class="num">${v.stalls}</td>
      <td class="num">${v.stallMs}</td>
      <td class="num">${v.latencyMs} ${latencyBadge(v.latencyMs)}</td>
      <td class="num">${v.switches}</td>
      <td class="num">${v.venueSwitches}</td>
      <td>${v.stalls > 0 ? '<span class="badge bad">卡顿</span>' : '<span class="badge good">流畅</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function refresh(): Promise<void> {
  try {
    const resp = await fetch('/api/stats', { cache: 'no-store' });
    render((await resp.json()) as StatsResponse);
  } catch (err) {
    $('updated-at').textContent = `刷新失败：${(err as Error).message}`;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
function applyInterval(): void {
  if (timer) clearInterval(timer);
  const ms = Number($<HTMLSelectElement>('interval').value);
  if (ms > 0) timer = setInterval(() => void refresh(), ms);
}

$('refresh').addEventListener('click', () => void refresh());
$('interval').addEventListener('change', applyInterval);
void refresh();
applyInterval();
