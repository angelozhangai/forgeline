// Path anchors. Two kinds:
//   1. The Forge service itself (project-independent): SVC_DIR / config / prompts / state / logs / db /
//      heartbeat. Defined here.
//   2. Target-project related: ROOT / scripts / docs-delivery / sub-repos. Derived from
//      defaultProject() in src/project.ts.
// Stage 1: project-related anchors delegate to defaultProject() (the default project), behaving
// exactly as the old implementation did. From stage 2 on, call sites that need per-session resolution
// use project(s.project_id); these global default anchors remain for non-session cases.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SVC_DIR, defaultProject } from './project.ts';

export { SVC_DIR } from './project.ts';

const _proj = defaultProject();

// Environment variables used as directories: an empty or whitespace-only value counts as unset.
// Without this layer, an "exported but empty" form like `FORGE_HOME=` would anchor every path to the
// process cwd, and the symptom would be extremely hard to trace.
function envDir(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? resolve(v) : undefined;
}

// Deployment seam: move the service's own mutable state out of the checkout entirely.
// FORGE_HOME relocates config/state/logs in one go; the individual FORGE_CONFIG_DIR /
// FORGE_STATE_DIR / FORGE_LOGS_DIR take precedence. With none of them set, everything falls back
// inside the checkout — byte for byte identical to before, which makes this a purely additive,
// backward-compatible change.
//
// Why it is needed: a private deployment wants its own assignment.yaml / routing.yaml, and both files
// are **tracked** in this repo. Editing them in place makes the checkout permanently dirty and makes
// `git pull` conflict; pointing them outside the repo keeps it clean, so the core checkout can be
// read-only and can be deleted and re-cloned at any time.
const HOME = envDir('FORGE_HOME');
const svcDir = (env: string, name: string): string =>
  envDir(env) ?? (HOME ? resolve(HOME, name) : resolve(SVC_DIR, name));

// -- 2. Target-project related (the default project) --
export const ROOT = _proj.root;
export const SCRIPTS_DIR = _proj.scriptsDir;
export const DELIVERY_DIR = _proj.deliveryDir;
export function repoPath(repo: string): string {
  return _proj.repoPath(repo);
}
// -- 1. The Forge service itself (project-independent) --
/** The default config directory shipped in the repo. When an overlay directory is missing a file, resolution falls back here per file. */
export const CONFIG_REPO_DIR = resolve(SVC_DIR, 'config');
/** The effective config directory. With no overlay set, === CONFIG_REPO_DIR. */
export const CONFIG_DIR = svcDir('FORGE_CONFIG_DIR', 'config');
export const PROMPTS_DIR = resolve(SVC_DIR, 'prompts');
export const STATE_DIR = svcDir('FORGE_STATE_DIR', 'state');
export const LOGS_DIR = svcDir('FORGE_LOGS_DIR', 'logs');
/**
 * The extension pack directory (see src/ext/). A downstream product drops an `index.ts` here that
 * default-exports an ExtensionPack, and gains its own CLI commands and lifecycle hooks **without
 * forking and without editing a single core file**.
 *
 * Same seam rules as config/state/logs: an explicit `FORGE_EXT_DIR` > `$FORGE_HOME/ext` > `ext/`
 * inside the checkout (this repo ships none, so the default is "there is no extension" = pure-OSS
 * behaviour byte for byte unchanged).
 * It reuses FORGE_HOME rather than inventing a new convention: a downstream deployment root already
 * uses it to relocate config/state/logs.
 */
export const EXT_DIR = svcDir('FORGE_EXT_DIR', 'ext');

/**
 * The actual path of a config file: the overlay's copy if it has one, otherwise the repo default.
 * The resolution rule matches loadPrompt (see src/util/render.ts) — a private deployment overrides
 * only the few files it cares about, and everything else keeps upgrading with the repo, rather than
 * having to fork the whole of config/ to change one yaml.
 *
 * Warning: the fallback is silent. Mistype a filename in the overlay directory and it runs the repo
 * default without complaining. A private overlay repo should carry its own reconciliation check of
 * "overlay filenames vs this repo's config/ and prompts/ trees".
 */
export function configFile(name: string): string {
  if (CONFIG_DIR !== CONFIG_REPO_DIR) {
    const p = resolve(CONFIG_DIR, name);
    if (existsSync(p)) return p;
  }
  return resolve(CONFIG_REPO_DIR, name);
}

// FORGE_DB overrides the path for test isolation (:memory: or a temp file).
export const DB_PATH = process.env.FORGE_DB || resolve(STATE_DIR, 'service.db');
export const ENV_FILE = configFile('forge.env'); // gitignored on both sides
// Health / liveness: the daemon writes the heartbeat, the watchdog reads it. FORGE_* overrides exist
// for test isolation.
export const HEARTBEAT_PATH = process.env.FORGE_HEARTBEAT || resolve(STATE_DIR, 'heartbeat.json');
export const WATCHDOG_STATE_PATH = process.env.FORGE_WATCHDOG_STATE || resolve(STATE_DIR, 'watchdog.json');
export const LAUNCHD_LOG = resolve(LOGS_DIR, 'launchd.log'); // the combined log written by forge-daemon (the watchdog rotates it)

/**
 * Parse forge.env (`KEY=value`, supporting # comments and matched quotes). **It lives in root.ts
 * rather than config.ts** because the transport selection point (messaging/index.ts) has to read one
 * variable at module-load time to decide which IM to use, and it must not drag config.ts's entire
 * yaml + zod validation chain into every file that imports it. root.ts has no heavy dependencies,
 * which makes it the right home.
 * config.ts remains the **authoritative** entry point for env (it layers process.env overrides on top
 * of this); what lives here is only the plainest possible layer.
 */
export function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return env;
  for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val !== '') env[key] = val;
  }
  return env;
}
