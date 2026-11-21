/**
 * HTTP 服务（零运行时依赖）。
 *
 * 路由：
 *   GET  /api/manifest              赛场与码率清单
 *   GET  /api/edge/:venue           当前直播边缘（seq / 发布时间）
 *   GET  /api/live/:venue/:rendition 分帧的 CMAF 直播流（init + 持续 chunk）
 *   GET  /api/stats                 观众统计列表
 *   POST /api/stats                 上报观众统计（累计快照，按 sessionId 覆盖）
 *   GET  /                          托管 vite build 产物（dist/，存在时）
 *
 * 直播分帧（大端）：u32 publishAtMs | u32 seq（init 帧为 0xFFFFFFFF）| u32 byteLength | payload
 * 调试参数：simBw / simLatency / simJitter / simLoss / simSeed（见 network-sim.ts）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamStore } from './stream-store.ts';
import { StatsStore } from './stats-store.ts';
import { NetworkSimulator, parseSimParams, mulberry32 } from './network-sim.ts';
import { MANIFEST_PATH, STATS_PATH, type ViewerReport } from '../shared/protocol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STREAMS_DIR = path.join(ROOT, 'streams');
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8080);

/** init 帧的 seq 标记 */
const INIT_SEQ = 0xffffffff;
/** 帧头：u64 publishAtMs | u32 seq | u32 byteLength（墙钟毫秒超 2^32，必须 64 位） */
const HEADER_BYTES = 16;
const MAX_BODY = 8 * 1024;
/** 单连接积压上限：超过后直接跳到边缘，模拟直播丢旧帧 */
const MAX_BACKLOG_CHUNKS = 25;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeFrame(res: ServerResponse, publishAt: number, seq: number, payload: Uint8Array): boolean {
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, BigInt(publishAt));
  view.setUint32(8, seq >>> 0);
  view.setUint32(12, payload.byteLength >>> 0);
  return res.write(header) && res.write(payload);
}

async function pumpLive(req: IncomingMessage, res: ServerResponse, bc: ReturnType<StreamStore['getVenue']>, renditionId: string, url: URL): Promise<void> {
  const venue = bc!;
  const rendition = venue.getRendition(renditionId);
  if (!rendition) {
    res.writeHead(404).end(JSON.stringify({ error: 'unknown rendition' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });

  const sim = parseSimParams(url.searchParams);
  const seedRaw = Number(url.searchParams.get('simSeed'));
  const rng = Number.isFinite(seedRaw) ? mulberry32(seedRaw >>> 0) : Math.random;
  const net = new NetworkSimulator(sim, rng);

  // 1) init 帧立即下发
  writeFrame(res, 0, INIT_SEQ, rendition.init);

  // 2) 追边：回放当前分片已发布的 chunk
  const sub = venue.subscribe(renditionId);
  venue.prime(sub, renditionId, Date.now());

  let closed = false;
  const cleanup = (): void => {
    closed = true;
    venue.unsubscribe(renditionId, sub);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  res.on('error', cleanup);

  const drain = (): Promise<void> => new Promise((r) => res.once('drain', r));

  try {
    while (!closed) {
      // 积压保护：慢消费者直接跳到边缘，只保留最新一个 chunk
      if (sub.queue.length > MAX_BACKLOG_CHUNKS) {
        const skipped = sub.queue.splice(0, sub.queue.length - 1).length;
        res.setHeader('X-Skipped-Chunks', String(skipped));
      }
      const ev = await venue.next(sub);
      const delivery = net.schedule(ev.data);
      if (delivery.dropped) continue;

      const wait = delivery.at - Date.now();
      if (wait > 0) await sleep(wait);
      if (closed) return;

      const ok = writeFrame(res, ev.publishAt, ev.seq >>> 0, delivery.data);
      if (!ok) await drain();
    }
  } catch (err) {
    if (!closed) console.error('[live] pump error:', (err as Error).message);
  } finally {
    cleanup();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  if (!existsSync(DIST_DIR)) return false;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR)) return false;
  if (!existsSync(file) || !existsSync(path.join(file)) ) {
    // SPA 回退
    const index = path.join(DIST_DIR, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(await readFile(index));
      return true;
    }
    return false;
  }
  const stat = await readFile(file).catch(() => null);
  if (!stat) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(stat);
  return true;
}

async function main(): Promise<void> {
  const store = await StreamStore.load(STREAMS_DIR);
  const stats = new StatsStore();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;

    if (p === MANIFEST_PATH && req.method === 'GET') {
      sendJson(res, 200, store.getManifest());
      return;
    }

    const edgeMatch = p.match(/^\/api\/edge\/([^/]+)$/);
    if (edgeMatch && req.method === 'GET') {
      const bc = store.getVenue(decodeURIComponent(edgeMatch[1]));
      if (!bc) return sendJson(res, 404, { error: 'unknown venue' });
      sendJson(res, 200, bc.edgeInfo(Date.now()));
      return;
    }

    const liveMatch = p.match(/^\/api\/live\/([^/]+)\/([^/]+)$/);
    if (liveMatch && req.method === 'GET') {
      const bc = store.getVenue(decodeURIComponent(liveMatch[1]));
      if (!bc) return sendJson(res, 404, { error: 'unknown venue' });
      void pumpLive(req, res, bc, decodeURIComponent(liveMatch[2]), url);
      return;
    }

    if (p === STATS_PATH && req.method === 'GET') {
      sendJson(res, 200, { viewers: stats.list() });
      return;
    }

    if (p === STATS_PATH && req.method === 'POST') {
      readJsonBody(req)
        .then((raw) => {
          const r = raw as Partial<ViewerReport>;
          if (!r || typeof r.sessionId !== 'string' || typeof r.venue !== 'string') {
            return sendJson(res, 400, { error: 'sessionId and venue required' });
          }
          const report: ViewerReport = {
            sessionId: r.sessionId.slice(0, 64),
            venue: r.venue.slice(0, 32),
            startAt: Number(r.startAt) || 0,
            firstFrameAt: Number(r.firstFrameAt) || 0,
            startupMs: Number(r.startupMs) || 0,
            stalls: Number(r.stalls) || 0,
            stallMs: Number(r.stallMs) || 0,
            latencyMs: Number(r.latencyMs) || 0,
            switches: Number(r.switches) || 0,
            venueSwitches: Number(r.venueSwitches) || 0,
            updatedAt: Date.now(),
          };
          stats.upsert(report);
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendJson(res, 400, { error: (err as Error).message }));
      return;
    }

    if (p.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    void serveStatic(res, p).then((ok) => {
      if (!ok) sendJson(res, 404, { error: 'not found (run vite build for web UI)' });
    });
  });

  server.keepAliveTimeout = 65_000;
  server.listen(PORT, () => {
    console.log(`[server] LL-CMAF origin on http://localhost:${PORT}`);
    console.log(`[server] ${store.venues().length} venues, each ${store.venues()[0]?.venue.renditions.length} renditions`);
  });

  const shutdown = (): void => {
    store.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
