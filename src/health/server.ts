// 本地健康服务（仅 127.0.0.1）：看门狗探针 + 人看的状态页。
//   GET /healthz        → 200 'ok'（极简，证明 event loop + http 还活着；看门狗廉价探针）
//   GET /health         → 实时健康 JSON（evaluateHealth）
//   GET  /api/board     → PRD 流水线看板（按状态分组 + 需关注 session 列表）
//   GET  /api/sessions  → 全量需求列表（?state= 过滤）   GET /api/session?id= → 单条详情 + 事件流
//   GET  /api/history   → 近 N 小时滚动历史（在线率 + 宕机/恢复事件）
//   POST /api/action    → 面板写动作（{action,slug}；本机 + 同源闸 + application/json；走真 action 权限闸）
//   GET  /              → 自包含状态页 HTML（类 status.claude.ai）
// 嵌在 listen() 守护进程内：claude/codex 是 async spawn 不堵 event loop，故 gate 跑期间本服务仍响应。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { hours } from '../util/time.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../util/log.ts';
import { evaluateHealth } from './check.ts';
import { history } from './history.ts';
import { boardPayload, sessionsPayload, sessionDetail } from './board.ts';
import { runPanelAction } from './action-gateway.ts';

const JSONT = 'application/json; charset=utf-8';

const PAGE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'page.html');

let pageCache: string | null = null;
function page(): string {
  if (pageCache != null) return pageCache;
  try {
    pageCache = readFileSync(PAGE_PATH, 'utf8');
  } catch {
    pageCache = '<!doctype html><meta charset=utf-8><title>Forge</title><body>状态页资源缺失，见 /health</body>';
  }
  return pageCache;
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// 严格同源闸：有 Origin 时要求其与本次请求的 Host **完全同源**（scheme+host+port），且主机是本机回环。
// 只比 hostname 不够（旧实现注释承诺「同源」却只看 hostname，跨端口/跨 scheme 会漏放）。防恶意网页 drive-by
// POST 到 localhost 触发 forge 动作。无 Origin = 同机非浏览器工具（curl/CLI），已由「绑 127.0.0.1 + 要 application/json」兜底。
function isSameLocalOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const o = new URL(origin);
    if (o.origin !== `http://${host}`) return false;
    const h = o.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

// POST /api/action：面板写动作。安全闸 = 绑 127.0.0.1（startHealthServer host）+ 同源 Origin + 要求 application/json
// （跨域 JSON 触发预检，普通表单设不了该 content-type）。真权限/lint/红线由被调 action 自身把关（见 action-gateway）。
function handleAction(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && !isSameLocalOrigin(origin, req.headers.host)) {
    send(res, 403, JSONT, JSON.stringify({ ok: false, msg: '跨源请求被拒（面板仅限本机同源）' }));
    return;
  }
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, JSONT, JSON.stringify({ ok: false, msg: '需 application/json' }));
    return;
  }
  let body = '';
  let aborted = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 10_000) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    void (async () => {
      try {
        const { action, slug } = JSON.parse(body || '{}') as { action?: string; slug?: string };
        const r = await runPanelAction(String(action ?? ''), String(slug ?? ''));
        send(res, r.ok ? 200 : 400, JSONT, JSON.stringify(r));
      } catch (e) {
        send(res, 400, JSONT, JSON.stringify({ ok: false, msg: `请求处理失败：${String(e).slice(0, 120)}` }));
      }
    })();
  });
}

export function startHealthServer(port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const now = Date.now();
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname;
        if (req.method === 'POST') {
          if (path === '/api/action') return handleAction(req, res);
          return send(res, 404, JSONT, JSON.stringify({ ok: false, msg: 'not found' }));
        }
        if (path === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
        if (path === '/health') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await evaluateHealth(now)));
        if (path === '/api/board') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await boardPayload(url.searchParams.get('project'))));
        if (path === '/api/sessions') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await sessionsPayload(url.searchParams.get('state'), url.searchParams.get('project'))));
        if (path === '/api/session') {
          const detail = await sessionDetail(url.searchParams.get('id') ?? '', url.searchParams.get('project'));
          if (!detail) return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: '找不到该需求' }));
          return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(detail));
        }
        if (path === '/api/history') {
          const rangeHours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 72));
          return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(history(now - hours(rangeHours), now)));
        }
        if (path === '/' || path === '/index.html') return send(res, 200, 'text/html; charset=utf-8', page());
        return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      } catch (e) {
        try {
          send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(e).slice(0, 200) }));
        } catch {
          /* 响应已发出 */
        }
      }
    })();
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') log.warn(`健康服务端口 ${port} 被占用 → 状态页/探针不可用（其余照常）`);
    else log.warn(`健康服务出错：${String(e).slice(0, 160)}`);
  });
  server.listen(port, host, () => {
    log.ok(`本地状态页已起：http://${host}:${port}/（/healthz /health /api/board /api/history）`);
  });
  return server;
}
