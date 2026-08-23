// The local health service (127.0.0.1 only): the watchdog's probe, plus a status page for humans.
//   GET  /healthz       -> 200 'ok' (as simple as possible, proving the event loop and http are still alive;
//                          the watchdog's cheap probe)
//   GET  /health        -> live health as JSON (evaluateHealth)
//   GET  /api/board     -> the PRD pipeline board (grouped by state, plus the sessions needing attention)
//   GET  /api/sessions  -> the full requirement list (filtered by ?state=)
//   GET  /api/session?id= -> one requirement's detail and its event stream
//   GET  /api/history   -> the rolling history over the last N hours (uptime, plus outages and recoveries)
//   POST /api/action    -> a panel write action ({action,slug}; local, same-origin gated, application/json;
//                          it goes through the real action's permission gate)
//   GET  /              -> the self-contained status page HTML (in the style of status.claude.ai)
// It is embedded inside the listen() daemon process: claude and codex are spawned asynchronously and do not
// block the event loop, so this service still responds while a gate is running.
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
    pageCache = '<!doctype html><meta charset=utf-8><title>Forge</title><body>the status page asset is missing; see /health</body>';
  }
  return pageCache;
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// The strict same-origin gate: when an Origin is present it must be **exactly the same origin** as this
// request's Host (scheme + host + port), and the host must be local loopback.
// Comparing the hostname alone is not enough — the old implementation's comment promised "same origin" but
// only looked at the hostname, which let a different port or scheme through. This is what stops a malicious
// web page drive-by POSTing to localhost to trigger a forge action. No Origin means a non-browser tool on the
// same machine (curl, the CLI), which is already covered by binding to 127.0.0.1 and requiring
// application/json.
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

// POST /api/action: a panel write action. The security gate is: bound to 127.0.0.1 (startHealthServer's
// host), a same-origin Origin, and application/json required (cross-origin JSON triggers a preflight, and an
// ordinary form cannot set that content type). The real permissions, lint and red lines are enforced by the
// action being called (see action-gateway).
function handleAction(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && !isSameLocalOrigin(origin, req.headers.host)) {
    send(res, 403, JSONT, JSON.stringify({ ok: false, msg: 'cross-origin request refused (the panel is local same-origin only)' }));
    return;
  }
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, JSONT, JSON.stringify({ ok: false, msg: 'application/json is required' }));
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
        send(res, 400, JSONT, JSON.stringify({ ok: false, msg: `the request could not be handled: ${String(e).slice(0, 120)}` }));
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
          if (!detail) return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'no such requirement' }));
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
          /* the response has already been sent */
        }
      }
    })();
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') log.warn(`the health service's port ${port} is already in use, so the status page and the probe are unavailable (everything else carries on)`);
    else log.warn(`the health service errored: ${String(e).slice(0, 160)}`);
  });
  server.listen(port, host, () => {
    log.ok(`the local status page is up: http://${host}:${port}/ (/healthz /health /api/board /api/history)`);
  });
  return server;
}
