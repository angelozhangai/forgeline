// The "target project" abstraction: one project the Forge service works on (example-project by default).
// It encapsulates every **project-relative** path resolution (root, scripts, docs/delivery, the repos).
// Forge's own paths (SVC_DIR, state, logs, config, prompts) live in src/root.ts and have nothing to do with
// a project.
//
// Stage 1: the default project only, resolved from FORGE_PROJECT_ROOT or the sibling ../example-project, with
// behaviour identical to the old root.ts. Stage 2 introduces the projects registry and binds a project_id to
// each session.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/src
export const SVC_DIR = resolve(here, '..'); // the root of the Forge service's own repo (nothing to do with a target project)

// The default project id. From stage 2 there are more of them (the keys of the projects registry).
export const DEFAULT_PROJECT_ID = 'demo';

// How the default target project's root is resolved, in order:
//   the FORGE_PROJECT_ROOT environment variable
//   -> the sibling workspace/example-project
//   -> the fallback: the project root for when the service still sits in the "scripts/forge inside the
//      project" layout.
export function resolveDefaultRoot(): string {
  const explicit = process.env.FORGE_PROJECT_ROOT;
  if (explicit) return resolve(explicit);
  const sibling = resolve(SVC_DIR, '..', 'example-project'); // the default target project
  if (existsSync(resolve(sibling, 'CLAUDE.md'))) return sibling;
  const inRepo = resolve(here, '..', '..', '..'); // the fallback: the scripts/forge-inside-the-project layout
  if (existsSync(resolve(inRepo, 'CLAUDE.md'))) return inRepo;
  return sibling;
}

// One target project: an id and a root, from which every in-project path Forge needs is derived.
export interface Project {
  id: string;
  root: string;
  scriptsDir: string; // the mechanical-action scripts (review-req.sh / tech-design.sh / feishu-doc.js ...)
  deliveryDir: string; // docs/delivery: the deliverables (req-review.md / tech-design.md ...)
  repoPath(repo: string): string; // the absolute path of one code repo inside the project (Gate A's source of truth)
  looksValid(): boolean; // whether the project's layout looks right (used by doctor)
}

export function makeProject(id: string, root: string): Project {
  const scriptsDir = resolve(root, 'scripts');
  return {
    id,
    root,
    scriptsDir,
    deliveryDir: resolve(root, 'docs', 'delivery'),
    repoPath: (repo: string) => resolve(root, repo),
    looksValid: () =>
      existsSync(resolve(root, 'CLAUDE.md')) &&
      existsSync(resolve(scriptsDir, 'review-req.sh')) &&
      existsSync(resolve(scriptsDir, 'feishu-doc.js')),
  };
}

// Doctor's project-layout check. It has to know **which mechanical-action adapter** the project uses, because
// the two adapters need different things on disk: `demo` delegates to the target project's own scripts, so a
// missing review-req.sh really is a broken layout, while `native` calls gh directly and needs no scripts at
// all — that is the whole point of it. Checking for the scripts regardless leaves every open-source target
// with a red row nobody can ever clear, and a row nobody can clear is worse than no row: it teaches you to
// skim past the rest of the list.
export function layoutCheck(root: string, actions: 'demo' | 'native'): { label: string; ok: boolean; note: string } {
  const brief = existsSync(resolve(root, 'CLAUDE.md')); // the project brief both adapters read
  if (actions === 'native') {
    return {
      label: 'the project layout (CLAUDE.md)',
      ok: brief,
      note: brief ? 'actions=native — gh is called directly, so this project needs no scripts' : 'CLAUDE.md is missing (the gates read it as the project brief)',
    };
  }
  const scriptsDir = resolve(root, 'scripts');
  const ok = brief && existsSync(resolve(scriptsDir, 'review-req.sh')) && existsSync(resolve(scriptsDir, 'feishu-doc.js'));
  return {
    label: 'the project layout (CLAUDE.md + scripts)',
    ok,
    note: ok ? '' : 'actions=demo delegates to the project\'s own scripts: it needs CLAUDE.md + scripts/review-req.sh + scripts/feishu-doc.js (or set actions:native)',
  };
}

let _default: Project | undefined;
// The default target project (resolved lazily and cached). It reads the environment and the disk on the first
// call, at the same moment the old ROOT did (root.ts called it at import time).
export function defaultProject(): Project {
  if (!_default) _default = makeProject(DEFAULT_PROJECT_ID, resolveDefaultRoot());
  return _default;
}
