// remoteApi - a runner reads and writes **control-plane** state over HTTP (the GitHub-runner model: the state
// lives centrally and runners read and write it remotely).
// It implements the same `SessionStore` interface as localSqliteStore (store/sessions.ts); the selection point
// (store/index.ts) switches on FORGE_CONTROL_URL (set = a pure runner going over HTTP; unset = the all-in-one
// status quo). It follows the same client/server wire pattern as jobs/remote.ts.
//
// The wire contract: a single RPC envelope, `POST <base>/store` with body `{method, args}`, returning
// `{ok:true,result}` or `{ok:false,error}`.
//   - An RPC envelope rather than per-resource REST: SessionStore is an **internal control/runner RPC
//     interface** (nineteen methods, not a public resource model), and one dispatch point keeps client and
//     server in strict lockstep with no routing drift; adding or changing a method touches the interface in one
//     place instead of hand-wiring another endpoint.
//   - Any 2xx means "the server processed it" (both a result and a business error travel inside the envelope);
//     only a non-2xx is a genuine transport failure or a server crash. So business errors (an illegal
//     transition, a UNIQUE index collision) come back as `ok:false` plus the original message, **not** as an
//     HTTP 4xx - which is what lets the client rebuild the Error and still classify it with a pure predicate.
//
// No silent failures: a network error, a non-2xx, broken JSON, a malformed envelope, or a server-side error all
// **throw** (so the runner knows "reading or writing the control plane failed" and never silently continues as
// though there were no state). The **original error message is preserved**, which is what lets pure predicates
// like isDuplicate*Error still classify a rejected error on the client side (they only run a regex over the
// message and do no IO) - they never go over the wire and run locally on the client.
//
// Authentication and network exposure are a **deployment concern** handled separately: this slice is the
// client, a mountable handler, and the round-trip tests, and the default path (FORGE_CONTROL_URL unset) is
// unchanged. Mounting it into a production control-plane server with authentication is covered in
// docs/architecture-control-plane-split.md.
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';
import type { SessionStore, NewSession, EventRow } from './port.ts';
import { isDuplicateDocRefError, isDuplicateIssueRefError } from './sessions.ts';

const TIMEOUT_MS = 30_000;

// The allowlist of IO methods that may be dispatched over the network (the server rejects any other method,
// which is what stops arbitrary-method injection; the pure predicates isDuplicate*Error never go over the wire,
// so they are not listed).
export const REMOTE_METHODS = [
  'create', 'findByIssueRef',
  'get', 'getBySlug', 'findByPrdUrl', 'findByDocRef', 'resolve',
  'listByStates', 'listAll', 'distinctProjects', 'countByState', 'countByStates',
  'patch', 'transition', 'appendEvent', 'events', 'lastEventTs',
  'leaseClaim',
] as const;

interface Envelope {
  ok?: boolean;
  result?: unknown;
  error?: string;
}

// The runner client: send one RPC call and return its result (or throw - no silent failures, and the original
// message is preserved).
async function call(base: string, headers: Record<string, string>, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${base}/store`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`control plane /store returned HTTP ${res.status}`);
  let env: Envelope;
  try {
    env = JSON.parse(await res.text()) as Envelope;
  } catch {
    throw new Error('control plane /store returned invalid JSON');
  }
  if (!env || typeof env !== 'object') throw new Error('control plane /store returned an invalid envelope');
  if (env.ok === false) throw new Error(env.error ?? 'control plane /store reported an unknown error');
  if (env.ok !== true) throw new Error('control plane /store returned an invalid envelope (no ok field)');
  return env.result;
}

// The runner client factory: trailing slashes on baseUrl are normalised away (so it never builds `//store`).
// When a token is given it sends `Authorization: Bearer <token>` (the control plane's authentication boundary,
// a shared secret).
export function makeRemoteStore(baseUrl: string, token?: string): SessionStore {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const rpc = <T>(method: string, ...args: unknown[]): Promise<T> => call(base, headers, method, args) as Promise<T>;
  return {
    create: (s: NewSession) => rpc<Session>('create', s),
    findByIssueRef: (ref: string) => rpc<Session | null>('findByIssueRef', ref),
    isDuplicateDocRefError, // a pure predicate: it runs a regex over a rejected error's message, locally on the client (never over the wire).
    isDuplicateIssueRefError,
    get: (id: string) => rpc<Session | null>('get', id),
    getBySlug: (slug: string) => rpc<Session | null>('getBySlug', slug),
    findByPrdUrl: (url: string) => rpc<Session | null>('findByPrdUrl', url),
    findByDocRef: (ref: string) => rpc<Session | null>('findByDocRef', ref),
    resolve: (idOrSlug: string) => rpc<Session | null>('resolve', idOrSlug),
    listByStates: (states: State[]) => rpc<Session[]>('listByStates', states),
    listAll: (projectId?: string) => rpc<Session[]>('listAll', projectId),
    distinctProjects: () => rpc<string[]>('distinctProjects'),
    countByState: () => rpc<Record<string, number>>('countByState'),
    countByStates: (states: State[]) => rpc<number>('countByStates', states),
    patch: (id: string, fields: Partial<Session>) => rpc<Session>('patch', id, fields),
    transition: (id: string, to: State, fields?: Partial<Session>) => rpc<Session>('transition', id, to, fields),
    appendEvent: (id: string, kind: string, detail?: unknown) => rpc<void>('appendEvent', id, kind, detail),
    events: (id: string) => rpc<EventRow[]>('events', id),
    lastEventTs: (id: string, kind: string) => rpc<number | null>('lastEventTs', id, kind),
    leaseClaim: (states: State[], runnerId: string, ttlMs: number, limit: number) => rpc<Session[]>('leaseClaim', states, runnerId, ttlMs, limit),
  };
}

// The control-plane side: dispatch one store RPC call to the local implementation `impl` and emit the wire
// envelope as JSON (always 2xx - business errors travel inside the envelope too).
// External input is never trusted: the JSON must parse; the method must be on the allowlist (otherwise this is
// arbitrary-method and prototype-chain injection); and args must be an array.
export async function handleStoreCall(impl: SessionStore, body: string): Promise<string> {
  let req: { method?: unknown; args?: unknown };
  try {
    req = (JSON.parse(body) ?? {}) as { method?: unknown; args?: unknown };
  } catch {
    return JSON.stringify({ ok: false, error: 'control plane /store received invalid JSON' });
  }
  const { method, args } = req;
  if (typeof method !== 'string' || !(REMOTE_METHODS as readonly string[]).includes(method)) {
    return JSON.stringify({ ok: false, error: `control plane /store received an invalid method: ${String(method)}` });
  }
  if (!Array.isArray(args)) {
    return JSON.stringify({ ok: false, error: 'control plane /store received args that are not an array' });
  }
  try {
    const fn = impl[method as keyof SessionStore] as unknown as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    return JSON.stringify({ ok: true, result });
  } catch (e) {
    // Business errors (an illegal transition, a UNIQUE index collision) return their message verbatim, so the
    // client can rebuild the Error and isDuplicate*Error can still classify it.
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
