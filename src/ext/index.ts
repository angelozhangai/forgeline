// Extension seam — **the load point (single wiring point)**.
// The core only does `import { fireTransition, extCommands, ... } from './ext/index.ts'` and never
// imports downstream code directly.
//
// Load order (see EXT_DIR in root.ts):
//   · `FORGE_EXT_DIR` set explicitly -> use it
//   · otherwise `$FORGE_HOME/ext`    -> the conventional location under a downstream deployment root
//                                       (auto-discovered)
//   · neither                        -> **empty pack**, pure-OSS behaviour byte for byte unchanged
//
// -- Present means it must load --
// No `index.ts` in the directory = "there is no extension", silently treated as an empty pack; that is
// the normal pure-OSS path.
// But a **file that exists and fails to load (syntax error / wrong export shape / unresolvable import)
// always throws, never silently falls back**. The reason is that silent fallback is this
// architecture's number one risk: mistype an overlay filename and the core does not complain, it runs
// the generic default, and there is no symptom at all. Extension packs are worse than prompts — a
// billing hook that did not load gives no sign whatsoever, until someone reconciles and finds two
// weeks of empty data.
//
// -- Hooks notify, they do not intercept --
// Each hook gets its own try/catch and its own timeout (FORGE_EXT_HOOK_TIMEOUT_MS, default 5s). A
// throw or a timeout is logged as a warning and the core carries on regardless. This follows the
// precedent of the drift loop in worker.tick: **a subsystem failure never interrupts gate progress**.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT_DIR } from '../root.ts';
import { log } from '../util/log.ts';
import type { ExtensionPack, ExtCommand, LifecycleHooks, TransitionEvent, TickEvent } from './port.ts';
import type { DocSource } from '../docs/index.ts';

const HOOK_TIMEOUT_MS = Number(process.env.FORGE_EXT_HOOK_TIMEOUT_MS) || 5000;

const EMPTY: ExtensionPack = { name: '(none)' };

let active: ExtensionPack = EMPTY;
let loaded = false;

/** Name of the loaded extension pack; `(none)` when none is loaded. Used by doctor and the startup log to answer "did it actually load". */
export function activePackName(): string {
  return active.name;
}

/** CLI commands provided by the loaded extension (not loaded, or an empty pack -> empty array). */
export function extCommands(): ExtCommand[] {
  return active.commands ?? [];
}

/** Lifecycle hooks provided by the loaded extension (not loaded, or an empty pack -> undefined). */
export function hooks(): LifecycleHooks | undefined {
  return active.hooks;
}

// Return the **same** empty array when there are no extension sources: docs/index.ts uses reference
// equality as its memo key, and building a fresh array each call would defeat that memoisation
// entirely (recomputing the merge and re-emitting the warnings on every incoming message).
const NO_SOURCES: DocSource[] = [];

/** Document sources registered by the loaded extension (not loaded, or an empty pack -> empty array). Merged into the registry by docs/index.ts. */
export function extDocSources(): DocSource[] {
  return active.docSources ?? NO_SOURCES;
}

// Shape validation: an extension pack comes from another repository, so a wrong shape must blow up at
// load time rather than when some hook is first invoked.
// Only the parts the core will actually touch are validated; whatever else downstream puts in the pack
// is its own business.
function validate(pack: unknown, from: string): ExtensionPack {
  const bad = (why: string): never => {
    throw new Error(`Invalid extension pack shape (${from}): ${why} — see ExtensionPack in src/ext/port.ts`);
  };
  if (typeof pack !== 'object' || pack === null) bad('the default export is not an object');
  const p = pack as Partial<ExtensionPack>;
  if (typeof p.name !== 'string' || p.name.trim() === '') bad('missing a non-empty name');
  if (p.commands !== undefined) {
    if (!Array.isArray(p.commands)) bad('commands is not an array');
    for (const [i, c] of p.commands.entries()) {
      if (typeof c?.name !== 'string' || c.name.trim() === '') bad(`commands[${i}] is missing a non-empty name`);
      if (typeof c?.summary !== 'string') bad(`commands[${i}].summary is not a string`);
      if (typeof c?.run !== 'function') bad(`commands[${i}].run is not a function`);
    }
  }
  if (p.hooks !== undefined && (typeof p.hooks !== 'object' || p.hooks === null)) bad('hooks is not an object');
  if (p.docSources !== undefined) {
    if (!Array.isArray(p.docSources)) bad('docSources is not an array');
    for (const [i, d] of p.docSources.entries()) {
      // A wrong shape must blow up **at load time**, not when a message first reaches claim() — by
      // then the only symptom is "the bot ignored me".
      if (typeof d?.id !== 'string' || d.id.trim() === '') bad(`docSources[${i}] is missing a non-empty id`);
      for (const fn of ['claim', 'parseRef', 'read'] as const) {
        if (typeof d?.[fn] !== 'function') bad(`docSources[${i}].${fn} is not a function`);
      }
      for (const fn of ['comment', 'probe'] as const) {
        if (d[fn] !== undefined && typeof d[fn] !== 'function') bad(`docSources[${i}].${fn} is present but is not a function`);
      }
    }
  }
  return p as ExtensionPack;
}

/**
 * Load the extension pack. **Idempotent**: it only really loads the first time and returns the
 * already-loaded pack afterwards.
 * Called once by the CLI entry point and once by daemon startup; the `dir` parameter is for tests
 * only, production always goes through EXT_DIR.
 */
export async function loadExtensions(dir: string = EXT_DIR): Promise<ExtensionPack> {
  if (loaded) return active;
  loaded = true;
  const entry = resolve(dir, 'index.ts');
  if (!existsSync(entry)) return active; // no extension — the normal pure-OSS path, silent
  // The file exists at this point: failing to load it means something is genuinely wrong, so throw to
  // main().catch and exit non-zero. Never degrade silently to an empty pack.
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  active = validate(mod.default, entry);
  log.info(`Extension pack loaded: ${active.name} (${entry})`);
  return active;
}

/** Test-only: reset the load state so the same process can reload from a different directory. Do not call from production code. */
export function resetExtensionsForTest(): void {
  active = EMPTY;
  loaded = false;
}

// One wrapper for every hook call: a synchronous throw, an asynchronous rejection, and a hang that
// never returns all turn into a single warning.
async function safely<E>(label: string, fn: ((e: E) => Promise<void> | void) | undefined, e: E): Promise<void> {
  if (!fn) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = (async () => fn(e))(); // wrap it so a synchronous throw in fn becomes a rejected promise and cannot escape the race
  // After the timeout has already lost the race the hook is still running, and when it rejects later
  // nobody is awaiting it -> that becomes an unhandledRejection and kills the whole process. Attach an
  // empty catch first. The race still takes the original promise, so a normal failure path still
  // reaches the catch below.
  running.catch(() => {});
  try {
    await Promise.race([
      running,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log.warn(`Extension hook ${label} failed (ignored, the core is unaffected): ${String(err).slice(0, 200)}`);
  } finally {
    if (timer) clearTimeout(timer); // clear the timer when the hook finishes first, or the process hangs until the timeout before exiting
  }
}

/** Emitted after a state transition succeeds. Installed on the SessionStore seam's decorator, covering every transition call site. */
export async function fireTransition(e: TransitionEvent): Promise<void> {
  await safely('onTransition', hooks()?.onTransition, e);
}

export async function fireTickStart(e: TickEvent): Promise<void> {
  await safely('onTickStart', hooks()?.onTickStart, e);
}

export async function fireTickEnd(e: TickEvent): Promise<void> {
  await safely('onTickEnd', hooks()?.onTickEnd, e);
}

export type { ExtensionPack, ExtCommand, ExtCommandContext, LifecycleHooks, TransitionEvent, TickEvent } from './port.ts';
