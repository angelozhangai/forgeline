// Extension seam — **ExtensionPack**: the one interface between Forgeline and a downstream product
// built on top of it.
//
// Follows the pattern already used in this repo: the interface (this file) + a single selection point
// (ext/index.ts `loadExtensions`/`hooks`/`commands`) + the adapter (downstream's own
// `$FORGE_HOME/ext/index.ts`). Structurally identical to MessagingPort / SessionStore / JobSource.
//
// **Why it exists**: the core turns the governance pipeline (PRD review -> tech design ->
// implementation -> PR) into a generic capability. Downstream — private deployments, commercial
// layers, team customisations — needs to add things on top without forking and without editing core
// files: its own CLI commands, mirroring state transitions into its own systems, running its own
// reconciliation around each tick. Without this seam those needs can only be met by patching core
// files, and the two sides fork permanently (the GitLab CE/EE bill). With it, downstream is a
// **consumer** of the core rather than a branch of it.
//
// -- Loading --
// See ext/index.ts: an explicit `FORGE_EXT_DIR` -> otherwise auto-discovery of
// `$FORGE_HOME/ext/index.ts` -> neither present means an **empty pack** (pure-OSS behaviour, byte for
// byte unchanged). An extension pack default-exports an ExtensionPack.
//
// -- Only plain data and functions cross this boundary --
// An extension pack lives in **another repository with its own node_modules** (a peer checkout). The
// same library (zod / yaml / an SDK) exists as two independent instances, one per side, so
// `instanceof`, private `Symbol` markers and prototype-chain checks **all stop working** — and they
// stop working silently: nothing throws, the branch is simply taken wrongly. Every field on this
// interface must therefore be JSON-serialisable plain data or an ordinary function:
//   OK:  string / number / boolean / null / plain objects / arrays / functions
//   NOT: zod schemas, class instances, Error subclasses, library objects other than Date, anything
//        carrying prototype semantics
// The cost of getting this wrong is a wrong decision rather than a crash, which is harder to find
// than a crash. This is a hard constraint, not advice.
//
// -- Non-goals (deliberately absent; do not add) --
// · **No MessagingPort override.** The messaging selection point is evaluated synchronously at module
//   load (messaging/index.ts), while an extension pack is loaded by an asynchronous `import()`, so
//   the timing simply does not line up. The right way to swap IM provider is to write an adapter
//   under messaging/ implementing MessagingPort — which already requires no core change at all.
//   Forcing in an override that "sometimes applies" would be worse than having none.
//   (**Document sources are not in this category**: the docs registry is consulted on every call, so
//   the timing problem does not arise -> see docSources below.)
// · **No state machine rewriting.** The states and the legal transition table (statemachine/) are
//   this pipeline's public contract and its safety red lines (for example: GATE_C_STALLED can only go
//   back to GATE_C_REVISION_REQUESTED — a red CI never gets to open a PR). Letting downstream edit
//   that is letting downstream remove the guardrails. New gates go through an issue upstream.
import type { State } from '../statemachine/states.ts';
// Types come via docs/index.ts (the single wiring point of the document layer; the architecture gate
// forbids the core from importing a concrete source directly).
import type { DocSource } from '../docs/index.ts';

// Execution context of an extension command: arguments the core has already parsed, carrying no core
// internals whatsoever (see "only plain data" above).
export interface ExtCommandContext {
  argv: string[]; // raw arguments after the command name (unparsed, for packs that parse their own)
  pos: string[]; // positional arguments
  flags: Record<string, string | boolean>; // `--k v` -> string; `--k` -> true
}

// One extension CLI command. The name must not collide with a core command (on collision the core
// always wins — see the de-duplication in ext/index.ts).
export interface ExtCommand {
  name: string;
  summary: string; // the one-line description shown by `forge help`
  run(ctx: ExtCommandContext): Promise<void> | void;
}

// One state transition. The core emits it **after SessionStore.transition() succeeds** (a failed
// transition emits nothing).
export interface TransitionEvent {
  id: string; // session id
  from: State | null; // state before the transition; null when the old state is not in the DB (a race, or a first-time record)
  to: State;
  at: number; // epoch ms
}

export interface TickEvent {
  at: number; // epoch ms
  processed?: number; // onTickEnd only: how many sessions this round actually advanced
  ok?: boolean; // onTickEnd only: whether the tick ended normally (false when it threw)
}

// Lifecycle hooks. **All of them notify; none of them intercept** — return values are ignored, a
// throw is swallowed and logged as a warning, and core behaviour never changes as a result.
// That is deliberate: the moment a hook can veto a core action, downstream can switch the governance
// guardrails off, and the seam has lost its point.
// Each hook has its own timeout (see HOOK_TIMEOUT_MS in ext/index.ts), so a hung hook cannot hold up
// gate progress.
export interface LifecycleHooks {
  onTransition?(e: TransitionEvent): Promise<void> | void;
  onTickStart?(e: TickEvent): Promise<void> | void;
  onTickEnd?(e: TickEvent): Promise<void> | void;
}

// The default export of a downstream extension pack.
export interface ExtensionPack {
  name: string; // shown by `forge doctor`, so "did it actually load" is answerable
  commands?: ExtCommand[];
  hooks?: LifecycleHooks;
  // Downstream's own document sources (Notion / Confluence / an internal wiki / markdown on GitHub…).
  // The core ships only the Feishu document source and the plaintext fallback; without this opening,
  // plugging in your own document system means editing that array in docs/index.ts — precisely the
  // thing this seam exists to eliminate.
  //
  // Three rules (see mergeSources in docs/index.ts; each has a test guarding it):
  //  · **Core sources always win**: an id colliding with a core one means the extension's copy is
  //    ignored (the same rule as "core commands always win").
  //  · Fallback sources (`fallback:true`) are ordered by registration with core first — two live
  //    fallback sources emit a warning.
  //  · The persisted `doc_ref` is `<source>:<token>` and **outlives the pack**: once the pack is
  //    removed, readDoc reports "unregistered document source" faithfully and never degrades into a
  //    silent read failure. So do not change a source id once it has shipped.
  docSources?: DocSource[];
}
