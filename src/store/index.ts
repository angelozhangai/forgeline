// The thin seam over the state layer - **the storage-backend selection point (the only place it is wired)**.
// The core (gates, worker, actions, daemon, ...) only does `import { store } from './store/index.ts'` and never
// depends on store/sessions.ts directly.
//
// The backend is chosen by FORGE_CONTROL_URL, decided once at module load:
//   - set     -> this process is a **pure runner**: it reads and writes remote control-plane state over HTTP
//                (remoteApi).
//   - unset   -> **all-in-one**: local sqlite (the status quo, behaviour unchanged).
//
// The chosen backend is then wrapped in an **extension-hook decorator** (withTransitionHook): all forty
// `.transition(` call sites in this repo already funnel through this one method, so installing the lifecycle
// hook here covers every one of them without touching a single call site.
import { localSqliteStore } from './sessions.ts';
import { makeRemoteStore } from './remote.ts';
import { hooks, fireTransition } from '../ext/index.ts';
import type { SessionStore } from './port.ts';

/**
 * Attach the extension hook to transition. **With no extension installed this is a zero-overhead
 * pass-through** - not even the read of the previous state happens, so the plain open-source path is
 * byte-for-byte what it was before this decorator existed (against a remote backend that read would be a
 * wasted HTTP round trip, which must not be paid for nothing).
 *
 * The hook fires only **after** a transition succeeds: a failed transition (the state machine throwing at the
 * gate) produces no event, because otherwise downstream would be told about a transition that never happened.
 * A failed lookup of the previous state is treated as from=null and never blocks the transition itself.
 *
 * It is exported so these three semantics can be tested directly against a fake store (fires only after
 * success / zero overhead with no hook / a missing previous state does not block). Testing through real sqlite
 * would tangle them up with table migrations and the state machine's own gating, so a failure would not say
 * which part broke.
 */
export function withTransitionHook(inner: SessionStore): SessionStore {
  return {
    ...inner,
    async transition(id, to, fields) {
      if (!hooks()?.onTransition) return inner.transition(id, to, fields);
      const before = await inner.get(id).catch(() => null);
      const s = await inner.transition(id, to, fields);
      await fireTransition({ id, from: before?.state ?? null, to, at: Date.now() });
      return s;
    },
  };
}

const controlUrl = process.env.FORGE_CONTROL_URL;
export const store: SessionStore = withTransitionHook(
  controlUrl ? makeRemoteStore(controlUrl, process.env.FORGE_CONTROL_TOKEN) : localSqliteStore,
);
export { makeRemoteStore, handleStoreCall, REMOTE_METHODS } from './remote.ts';
export type { SessionStore, NewSession, EventRow } from './port.ts';
