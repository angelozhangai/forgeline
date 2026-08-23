// The control-plane HTTP server - it serves the wire endpoints a runner uses to pull jobs (/jobs) and to read
// and write state (/store).
// This is the minimum runnable **control-plane process** in the control-plane / runner split: a runner (one
// with FORGE_CONTROL_URL set) pulls its due jobs and reads and writes central session state through it. It is
// **separate from** health/server.ts, which is the runner's own local 127.0.0.1 status page and probe.
//
//   GET  /healthz                  -> 200 'ok' (a cheap liveness probe, **unauthenticated**, for a load
//                                     balancer or a runner)
//   GET  /jobs?runner=<id>&limit=N -> atomically claim that runner's due jobs (a lease; FIFO, at most N)
//                                     [authentication required]
//   POST /store                    -> the SessionStore RPC envelope (handleStoreCall(store, body))
//                                     [authentication required]
//
// **The authentication boundary (a shared secret)**: when a token is configured, /jobs and /store require
// `Authorization: Bearer <token>` (compared with timingSafeEqual at a fixed length, which guards against a
// timing side channel), and anything else gets a 401. /healthz is unauthenticated (it is purely a liveness
// probe).
// **Two fail-closed guards**:
//   1. binding a **non-loopback** address with **no token** throws at startup (exposing read/write access to
//      every session's state on the network without authentication would be a disaster). Loopback allows no
//      token, for local development.
//   2. the process having **FORGE_CONTROL_URL** set (the runner marker) throws at startup: a control-plane
//      process must connect directly to the local sqlite and never proxy its reads and writes elsewhere
//      (otherwise the store and jobSource selection points would resolve to a remote, and the control plane
//      would be serving thin air). This guard is what guarantees `store` and `jobSource` are always the local
//      implementations.
//
// **The lease (so several runners cannot claim the same job)**: /jobs claims atomically through
// `store.leaseClaim([...POLLER_DRIVEN], runner, ttl)`, leasing due jobs to the runner identified by
// `?runner=<id>`. Another runner pulling at the same moment can only get jobs that are unowned or expired, and
// never claims the same one. If a runner dies, another may re-claim its jobs once the lease expires. Without
// `?runner` the control plane uses its own RUNNER_ID (the loopback / single-runner fallback).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../util/log.ts';
import { loadConfig } from '../config.ts';
import { store, handleStoreCall } from '../store/index.ts';
import { POLLER_DRIVEN } from '../statemachine/states.ts';
import { RUNNER_ID, leaseTtlMs } from '../orchestrator/jobs/index.ts';

const JSONT = 'application/json; charset=utf-8';
const MAX_BODY = 1_000_000; // the /store request-body cap: a session patch envelope is a few KB at most, so 1MB is very generous (it exists to prevent a memory blow-up).
const MAX_CLAIM = 512; // the cap on one /jobs claim: it stops a buggy or malicious runner leasing the entire backlog in one go.

// The requesting runner's concurrency capacity for this round (?limit). Missing or invalid falls back to the
// control plane's own max_parallel, and it is always clamped to [1, MAX_CLAIM].
function claimLimit(raw: string | null): number {
  const n = Number(raw);
  const want = Number.isFinite(n) && n >= 1 ? Math.floor(n) : loadConfig().runtime.max_parallel;
  return Math.min(Math.max(1, want), MAX_CLAIM);
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Authentication: only checked when a token is configured (with no token, only loopback is allowed, which
// fail-closed guard 1 in startControlServer enforces).
// Fixed-length timingSafeEqual: unequal lengths short-circuit first (the length itself is not a secret), and
// equal lengths are compared in constant time, which prevents brute-forcing the token byte by byte through
// timing.
function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Accumulate the request body, destroying the request once it exceeds the cap (never buffer without bound).
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!aborted) resolve(body);
    });
    req.on('error', reject);
  });
}

export interface ControlServerOpts {
  port: number;
  host?: string; // defaults to 127.0.0.1 (the safe loopback default)
  token?: string; // the shared secret; required when binding a non-loopback address
}

// It returns a **Promise<Server>**: it resolves once the socket is listening, and **rejects if binding fails
// before that (EADDRINUSE and friends)**. The control-plane HTTP surface is the entire reason a control-plane
// process exists, so failing to bind means a half-start (the tick and health page look alive, but /jobs and
// /store are unavailable to every other runner). It must fail fast so the caller exits when it cannot get the
// HTTP surface, rather than silently living on with no control plane. Runtime errors after it is listening only
// warn, and do not tear down a running service. Both fail-closed guards **throw synchronously**, before the
// Promise is returned: a misconfiguration blows up immediately, the caller's `await` sees a synchronous throw,
// and a test can catch it with `assert.throws`.
export function startControlServer(opts: ControlServerOpts): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token || undefined;
  // Fail-closed guard 2: a control-plane process must not be a runner - with FORGE_CONTROL_URL set, the store
  // and jobSource selection points would resolve to a remote.
  if (process.env.FORGE_CONTROL_URL) {
    throw new Error('a control-plane process must not set FORGE_CONTROL_URL (that is the runner marker): it would proxy store/jobSource elsewhere, leaving the control plane serving thin air');
  }
  // Fail-closed guard 1: a non-loopback address with no token refuses to start (read/write access to all state
  // must never be exposed on the network without authentication).
  if (!isLoopback(host) && !token) {
    throw new Error(`refusing to start the control plane unauthenticated on the non-loopback address ${host}: /store can read and write every session's state, so FORGE_CONTROL_TOKEN must be configured`);
  }
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname;
        if (req.method === 'GET' && path === '/healthz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
        // The endpoints below require authentication.
        if (!authorized(req, token)) return send(res, 401, JSONT, JSON.stringify({ ok: false, error: 'unauthorized (the Bearer token is missing or wrong)' }));
        if (req.method === 'GET' && path === '/jobs') {
          const runner = url.searchParams.get('runner') || RUNNER_ID; // absent -> the control plane's own id (the loopback / single-runner fallback)
          const limit = claimLimit(url.searchParams.get('limit')); // this runner's capacity for the round (FIFO, at most `limit`)
          const jobs = await store.leaseClaim([...POLLER_DRIVEN], runner, leaseTtlMs(), limit);
          return send(res, 200, JSONT, JSON.stringify(jobs));
        }
        if (req.method === 'POST' && path === '/store') return send(res, 200, JSONT, await handleStoreCall(store, await readBody(req)));
        return send(res, 404, JSONT, JSON.stringify({ ok: false, error: 'not found' }));
      } catch (e) {
        try {
          send(res, 500, JSONT, JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
        } catch {
          /* the response has already been sent */
        }
      }
    })();
  });
  return new Promise<Server>((resolve, reject) => {
    let listening = false;
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (listening) {
        log.warn(`the control-plane server errored at runtime: ${String(e).slice(0, 160)}`); // an error after start-up does not tear the service down
        return;
      }
      const why = e.code === 'EADDRINUSE' ? `port ${opts.port} is already in use` : String(e).slice(0, 160);
      reject(new Error(`the control-plane HTTP bind failed (${why}) -> refusing to start with no control plane`));
    });
    server.listen(opts.port, host, () => {
      listening = true;
      log.ok(`Control plane started: http://${host}:${opts.port}/ (/jobs /store /healthz) - ${token ? 'authentication on' : 'loopback, unauthenticated'}`);
      resolve(server);
    });
  });
}
