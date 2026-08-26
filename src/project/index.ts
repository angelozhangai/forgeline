// The ProjectActions selection point (the one place it is wired). The core only ever does
// `import { projectActions } from './project/index.ts'` and never calls an adapter directly. Choosing
// nativeGithub (which calls gh and the API directly) by project needs no change in the core at all — the
// same shape as the provider selection point in messaging/index.ts.
//
// The argument is an already-resolved ProjectFull (the caller has one in hand from projectForSession(s)), so
// this module has **no** runtime dependency on projects.ts — which avoids the "a test mocks projects.ts,
// leaves out the project export, and it explodes at import time" fragility (the lesson from 0.1b).
import { makeDemoScriptActions } from './actions.ts';
import { makeNativeGithubActions } from './github.ts';
import { makeRehearsalActions } from './rehearsal.ts';
import { rehearsalOn } from '../rehearsal.ts';
import type { ProjectActions } from './actions.ts';
import type { ProjectFull } from '../projects.ts'; // type-only, erased at runtime

export function projectActions(proj: ProjectFull): ProjectActions {
  // The rehearsal wins over the project's own choice, and it is checked here rather than in each adapter:
  // this is the single place the core resolves "how do I act on the target project", so one branch covers
  // every caller and no gate has to know the mode exists.
  if (rehearsalOn()) return makeRehearsalActions(proj);
  return proj.actions === 'native' ? makeNativeGithubActions(proj) : makeDemoScriptActions(proj);
}

export type { ProjectActions, ScriptResult, IssueWriteResult, PublishResult } from './actions.ts';
