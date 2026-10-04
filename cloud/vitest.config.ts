// Tests run inside workerd, the runtime the Worker is deployed on (@cloudflare/vitest-pool-workers), against
// the real wrangler.jsonc -- once per environment:
//  * `dev`  -- everything, under the dev environment exactly as wrangler.jsonc defines it;
//  * `prod` -- test/*.prod.test.ts, under the prod environment exactly as wrangler.jsonc defines it. This is
//    what makes "unauthenticated connections are refused in prod" a fact about the shipped configuration
//    rather than about a hand-built test env.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The same migration files `wrangler d1 migrations apply` uses, read once here (Node side) and applied inside
// workerd by test/setup.ts, so every test runs against the schema that is deployed.
const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

function project(environment: 'dev' | 'prod', include: string[], exclude: string[] = []) {
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    // Every state change writes a structured log line; print them only for a test that failed, where they
    // are the trail of what happened.
    test: { name: environment, include, exclude, setupFiles: ['./test/setup.ts'], silent: 'passed-only' as const },
  };
}

export default defineConfig({
  test: {
    projects: [project('dev', ['test/**/*.test.ts'], ['test/**/*.prod.test.ts']), project('prod', ['test/**/*.prod.test.ts'])],
  },
});
