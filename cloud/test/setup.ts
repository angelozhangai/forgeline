// Applies cloud/migrations/ to the test D1 database before each test file (see vitest.config.ts). Already
// applied migrations are skipped, so this is cheap when storage persists between files.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
