// wrangler.jsonc is committed to a public repository. These tests keep it free of anything that identifies a
// real deployment, and keep the bindings the code relies on in place.
//
// Why a test and not just a comment: the leak would be silent. `wrangler d1 create` offers to write the new
// database's id into this file, and so does a first deploy that provisions one -- a single "yes" and the next
// commit publishes it. The vars check is the same idea for secrets: anything secret goes in with
// `wrangler secret put`, so the vars are a closed list.
import { describe, expect, test } from 'vitest';
import raw from '../wrangler.jsonc?raw';

// JSONC -> JSON: drop // and /* */ comments outside strings, and trailing commas. Enough for this one file;
// the point is to read it the way wrangler does, not to be a general parser.
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const config = parseJsonc(raw) as {
  name: string;
  main: string;
  compatibility_flags: string[];
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  env: Record<string, Record<string, unknown>>;
};

// Keys that only make sense for one particular Cloudflare account.
const ACCOUNT_SPECIFIC = ['account_id', 'database_id', 'preview_database_id', 'id', 'preview_id', 'routes', 'route', 'zone_id', 'zone_name', 'custom_domain', 'pattern'];

function keysDeep(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysDeep(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysDeep(v, `${path}.${k}`)]);
  return [];
}

describe('wrangler.jsonc', () => {
  test('names no account, database id, route or custom domain -- those are supplied at deploy time', () => {
    const offending = keysDeep(config).filter((p) => ACCOUNT_SPECIFIC.includes(p.split('.').pop()!.replace(/\[\d+\]$/, '')));
    expect(offending).toEqual([]);
  });

  test('carries nothing that looks like an email address or a 32-hex Cloudflare id anywhere, comments included', () => {
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(raw).not.toMatch(/\b[0-9a-f]{32}\b/i);
    expect(raw).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  });

  test('has exactly the dev and prod environments, and their vars are exactly the two non-secret switches', () => {
    expect(Object.keys(config.env).sort()).toEqual(['dev', 'prod']);
    expect(config.env.dev.vars).toEqual({ FORGELINE_ENV: 'dev', FORGELINE_JOBS_ENABLED: 'true' });
    expect(config.env.prod.vars).toEqual({ FORGELINE_ENV: 'prod', FORGELINE_JOBS_ENABLED: 'false' });
    expect((config as Record<string, unknown>).vars).toBeUndefined();
  });

  test('binds the DeviceHub Durable Object and D1 in both environments, and DeviceHub is SQLite-backed', () => {
    for (const name of ['dev', 'prod']) {
      expect(config.env[name].durable_objects, name).toEqual({ bindings: [{ name: 'DEVICE_HUB', class_name: 'DeviceHub' }] });
      expect(config.env[name].d1_databases, name).toEqual([{ binding: 'DB', database_name: `forgeline-${name}`, migrations_dir: 'migrations' }]);
    }
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['DeviceHub'] }]);
  });

  test('does not enable nodejs_compat: the Worker is web APIs only', () => {
    expect(config.compatibility_flags).toEqual([]);
  });
});
