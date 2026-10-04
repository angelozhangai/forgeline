// src/admission.ts: the one place that decides whether an unauthenticated socket may be held (P1 only).
import { describe, expect, test } from 'vitest';
import { admit } from '../src/admission.ts';
import { environmentOf } from '../src/env.ts';

describe('admit', () => {
  test('admits an unauthenticated connection when FORGELINE_ENV is exactly "dev"', () => {
    expect(admit({ FORGELINE_ENV: 'dev' })).toEqual({ ok: true, mode: 'unauthenticated-dev' });
  });

  test('refuses everything else: prod, near-misses, and a missing value (fail closed)', () => {
    for (const value of ['prod', 'Dev', 'DEV', 'dev ', ' dev', 'development', 'devel', 'test', 'staging', '', 'true', undefined]) {
      const a = admit({ FORGELINE_ENV: value });
      expect(a.ok, JSON.stringify(value)).toBe(false);
      if (!a.ok) expect(a.reason).toMatch(/only in the dev environment/);
    }
  });
});

describe('environmentOf', () => {
  test('knows exactly dev and prod, and nothing else', () => {
    expect(environmentOf({ FORGELINE_ENV: 'dev' })).toBe('dev');
    expect(environmentOf({ FORGELINE_ENV: 'prod' })).toBe('prod');
    for (const value of ['Prod', 'production', '', undefined]) expect(environmentOf({ FORGELINE_ENV: value })).toBeNull();
  });
});
