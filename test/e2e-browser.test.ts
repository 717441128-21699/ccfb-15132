/**
 * 真实浏览器 E2E（Playwright + 系统 Chrome）：
 *  - 页面加载后 MSE 真正起播（video.readyState 推进、currentTime 增长）
 *  - 端到端延迟指标稳定在 3s 目标线以下
 *  - 调试页带宽压到最低档后，播放器在数秒内自动降档
 *  - 赛场切换期间画面不黑（切换前后 video 均有解码帧）
 *
 * 前置：server 已在 8080 运行，dist 已构建（静态托管）。
 * 可用 `npm run smoke` 一键校验。
 */
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:8080';
const isWin = process.platform === 'win32';
let server: ChildProcess | null = null;
let browser: Browser;

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/manifest`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become ready');
}

beforeAll(async () => {
  // 若外部已有服务则复用，否则自起
  try {
    const r = await fetch(`${BASE}/api/manifest`);
    if (!r.ok) throw new Error('not ok');
  } catch {
    server = spawn(isWin ? 'npx.cmd' : 'npx', ['tsx', 'server/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '8080' },
      shell: isWin,
      stdio: 'ignore',
    });
    await waitForServer();
  }
  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) server.kill();
});

async function newPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });
  return page;
}

describe('playback page (real Chrome MSE)', () => {
  it('starts playback with decoded frames and sub-3s latency', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });

    // 等待视频真正起播：currentTime 持续增长
    await page.waitForFunction(
      () => {
        const v = document.querySelector<HTMLVideoElement>('#stage video');
        return !!v && v.readyState >= 2 && v.currentTime > 0;
      },
      { timeout: 20_000 },
    );

    // 让播放稳定 8 秒，期间采集延迟
    await page.waitForTimeout(8000);
    const latencyText = await page.textContent('#s-latency');
    const latency = Number(latencyText);
    expect(Number.isFinite(latency)).toBe(true);
    expect(latency).toBeLessThan(3000);
    expect(latency).toBeGreaterThan(0);

    const stalls = Number(await page.textContent('#s-stalls'));
    const startup = Number(await page.textContent('#s-startup'));
    expect(startup).toBeGreaterThan(0);
    expect(stalls).toBeGreaterThanOrEqual(0);

    // video 仍在前进
    const t1 = await page.evaluate(() => document.querySelector<HTMLVideoElement>('#stage video')!.currentTime);
    await page.waitForTimeout(1500);
    const t2 = await page.evaluate(() => document.querySelector<HTMLVideoElement>('#stage video')!.currentTime);
    expect(t2).toBeGreaterThan(t1);
    await page.close();
  }, 35_000);

  it('switches venues without a black screen', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const v = document.querySelector<HTMLVideoElement>('#stage video');
        return !!v && v.readyState >= 2 && v.currentTime > 0;
      },
      { timeout: 20_000 },
    );

    const activeIdBefore = await page.evaluate(
      `[...document.querySelectorAll('#stage video')].find(v => v.style.visibility !== 'hidden')?.id`,
    );
    const expectedActive = activeIdBefore === 'video-a' ? 'video-b' : 'video-a';

    const tabs = page.locator('.venue-tab');
    await tabs.nth(1).click(); // 切到第二个赛场

    // 直接等「目标元素」变为可见且在播放，避免交换中途两元素短暂都可见的竞态
    await page.waitForFunction(
      `(() => {
        const el = document.getElementById('${expectedActive}');
        return !!el && el.style.visibility === 'visible' && el.readyState >= 2 && !el.paused && el.currentTime > 0;
      })()`,
      { timeout: 15_000 },
    );

    const activeIdAfter = await page.evaluate(
      `[...document.querySelectorAll('#stage video')].find(v => v.style.visibility !== 'hidden')?.id`,
    );
    // 双 video 轮换：可见元素应已切换（A<->B）
    expect(activeIdAfter).toBe(expectedActive);
    expect(activeIdAfter).not.toBe(activeIdBefore);

    // 切换后画面持续推进，证明没有卡在黑场/冻结
    const t1 = await page.evaluate(
      `[...document.querySelectorAll('#stage video')].find(v => v.style.visibility !== 'hidden').currentTime`,
    );
    await page.waitForTimeout(1500);
    const t2 = await page.evaluate(
      `[...document.querySelectorAll('#stage video')].find(v => v.style.visibility !== 'hidden').currentTime`,
    );
    expect(t2).toBeGreaterThan(t1);

    // 事件日志确认切换动作发生
    const logText = (await page.textContent('#log')) ?? '';
    expect(logText).toContain('切换到赛场');
    await page.close();
  }, 30_000);
});

describe('debug page (network simulation)', () => {
  it('auto-downgrades rendition under severe bandwidth cap', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/debug.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>('#stage video');
      return !!v && v.readyState >= 2 && v.currentTime > 0;
    }, { timeout: 20_000 });

    // 带宽压到 500kbps（低于最低档 900k），应用并重新拉流
    await page.fill('#bw', '500');
    await page.click('#apply');

    // 等待自动 ABR 降到最低档 480p（弱网下反复确认，最多 20s）
    await page.waitForFunction(
      () => document.querySelector('#s-rend')?.textContent === '480p',
      { timeout: 20_000 },
    );

    const latency = Number(await page.textContent('#s-latency'));
    // 追帧机制应把延迟尽量拉回（弱网下允许放宽，但应有有限值而非失控增长）
    expect(Number.isFinite(latency)).toBe(true);
    await page.close();
  }, 35_000);
});
