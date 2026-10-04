// Types for the test side only (test/tsconfig.json): what `env` and `exports` from cloudflare:workers carry in
// tests -- the Worker's own bindings plus the migrations vitest.config.ts injects, and the Worker's exports --
// and Vite's import.meta.glob, which the fixture tests use to load ../fixtures/wire/v1 at build time (workerd
// has no filesystem to read them from at run time).
import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends ForgelineEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../src/index.ts');
      durableNamespaces: 'DeviceHub';
    }
  }
  interface ImportMeta {
    glob<T = unknown>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>;
    // For vitest.config.ts, which runs in Node. Declared here rather than by installing @types/node, which
    // would only be found by accident locally (in a parent node_modules) and not at all in CI.
    url: string;
  }
}

type ForgelineEnv = Env;
