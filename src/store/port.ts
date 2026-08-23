// The thin seam over the state layer - **SessionStore**: the single interface between the core and a concrete
// storage backend (local sqlite today, a control-plane HTTP API later).
// It follows the MessagingPort pattern: the interface (this file) + a single selection point (`store` in
// store/index.ts) + an adapter (localSqlite = sessions.ts).
// Core code never imports store/sessions.ts directly; it only does `import { store } from './store/index.ts'`,
// so swapping the backend is a one-line change at the selection point.
//
// The only implementation today is local sqlite (`localSqliteStore` in store/sessions.ts). Once the control
// plane and the runner are separated there will be a `remoteApi` implementation (a runner reading and writing
// control-plane state over HTTP).
//
// **The async contract**: the IO methods (reads, writes, queries, events) return Promises - which is what makes
// a remoteApi (inherently asynchronous over HTTP) possible later. The local sqlite implementation is
// synchronous underneath (node:sqlite) and is simply wrapped as async (no side effects, identical semantics);
// every consumer writes `await store.*`.
// The exception: `isDuplicate*Error` are **pure predicates** (they classify an error object and do no IO), so
// they stay synchronous - classifying an HTTP 409 in remoteApi does no IO either.
// Note: the seam was first introduced with a **synchronous** interface (zero behaviour change); this is the
// stage that made it async (see docs/architecture-control-plane-split.md).
import type { Session } from '../types.ts';
import type { State } from '../statemachine/states.ts';

// The create() argument: the minimum required to create a session plus the optional initial fields (everything
// else is written afterwards through patch / transition).
export interface NewSession {
  id: string;
  slug: string;
  title: string;
  project_id?: string; // the target project id (defaults to 'demo', so migrations and older tests need not pass it)
  branch: string;
  state?: State; // the starting state (defaults to INTAKE; a standalone bare issue starts directly at GATE_C_REQUESTED)
  prd_url?: string | null;
  prd_text_path?: string | null;
  chat_id?: string | null;
  doc_ref?: string | null; // '<source>:<token>'
  poster_id?: string | null;
  intake_msg_id?: string | null;
  source_kind?: string | null; // 'prd' | 'issue'
  issue_ref?: string | null; // the standalone deduplication key
}

export interface EventRow {
  ts: number;
  kind: string;
  detail: string | null;
}

// The session-state read/write surface (get / create / patch / transition / events / aggregate queries).
// localSqlite is the implementation today; a remote HTTP one comes later.
export interface SessionStore {
  // -- Create / deduplicate --
  create(s: NewSession): Promise<Session>;
  findByIssueRef(ref: string): Promise<Session | null>; // the deduplication key for standalone implementation tasks
  isDuplicateDocRefError(e: unknown): boolean; // create hit the doc_ref unique index (a concurrent race) -> fall back to deduplication [a pure, synchronous predicate]
  isDuplicateIssueRefError(e: unknown): boolean; // create hit the issue_ref unique index (a concurrent race) -> fall back to deduplication [a pure, synchronous predicate]

  // -- Reads --
  get(id: string): Promise<Session | null>;
  getBySlug(slug: string): Promise<Session | null>;
  findByPrdUrl(url: string): Promise<Session | null>;
  findByDocRef(ref: string): Promise<Session | null>; // the source of truth for PRD-level deduplication ('<source>:<token>', with URL variants already normalised)
  resolve(idOrSlug: string): Promise<Session | null>; // the CLI addresses sessions by id or slug

  // -- Lists / aggregates --
  listByStates(states: State[]): Promise<Session[]>;
  // The full list. With projectId given it returns only that project (query isolation); without it, the whole
  // database (**a red line**: the daemon's global actions must never pass a projectId).
  listAll(projectId?: string): Promise<Session[]>;
  distinctProjects(): Promise<string[]>; // the project ids that appear in the database (for the panel and CLI filter dropdowns)
  countByState(): Promise<Record<string, number>>;
  countByStates(states: State[]): Promise<number>;

  // -- Writes / state machine --
  patch(id: string, fields: Partial<Session>): Promise<Session>;
  transition(id: string, to: State, fields?: Partial<Session>): Promise<Session>; // an illegal transition throws (the state machine is the gate)

  // -- Event log --
  appendEvent(id: string, kind: string, detail?: unknown): Promise<void>;
  events(id: string): Promise<EventRow[]>;
  lastEventTs(id: string, kind: string): Promise<number | null>; // when an event of this kind last happened (for debouncing and reconciliation); null if never

  // -- Leases (so several runners cannot claim the same job) --
  // An atomic claim: jobs whose state is in `states` and that are unowned, expired, or already held by this
  // runner, taken FIFO up to `limit`, leased for ttlMs, and returned.
  // `limit` is this runner's concurrency capacity for this round - it must never lease the whole backlog at
  // once (see the leaseClaim notes in sessions.ts). Leases another runner still holds are excluded.
  leaseClaim(states: State[], runnerId: string, ttlMs: number, limit: number): Promise<Session[]>;
}
