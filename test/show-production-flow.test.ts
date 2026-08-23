// Integration: when an operator lists the open questions through the real CLI, both the old and the new
// option shapes have to read as plain business language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.FORGE_DB = resolve(tmpdir(), `forge-show-${process.pid}.db`);

const sessions = await import('../src/store/sessions.ts');

test('./forge show: gate B\'s open questions handle both the old string[] and the newer recommended/impact options, and never print a stringified object', () => {
  const id = 'show-human-asks';
  sessions.create({ id, slug: id, title: 'where the refund goes', branch: 'main' });
  sessions.patch(id, {
    gate_b_round: 2,
    gate_b_human_asks: JSON.stringify([
      { id: 'x', question: 'Where does the refund go?', options: ['back the original way', 'to the balance'], severity: 'high' },
      {
        id: 'dup',
        question: 'Is a delay in the money arriving acceptable?',
        options: [
          { label: 'accept the delay', recommended: true, impact: 'the cleanest to reconcile' },
          { label: 'expedite it', recommended: false, impact: 'costs more to build' },
        ],
        severity: 'med',
      },
    ]),
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'show', id], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /Gate B's revision escalated, waiting on the maintainer/);
  assert.match(text, /Where does the refund go\? \(options: back the original way \/ to the balance\)/);
  assert.match(text, /Is a delay in the money arriving acceptable\? \(options: \u2605accept the delay \/ expedite it\)/);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /forge gateb-answer show-human-asks/);
});

test('./forge show: when an operator looks at one requirement, the downstream gate C and gate D costs have to be part of the visible total', () => {
  const id = 'show-downstream-cost';
  sessions.create({ id, slug: id, title: 'downstream implementation cost is visible', branch: 'main' });
  sessions.patch(id, {
    gate_a_cost_usd: 0,
    gate_b_cost_usd: 0,
    gate_c_cost_usd: 8.25,
    gate_d_cost_usd: 2.75,
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'show', id], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /state:\s+INTAKE/);
  assert.match(text, /cost:\s+\$11\.0000/);
  assert.doesNotMatch(text, /cost:\s+\$0\.0000/);
});

test('./forge cost: the management view reads the real database and breaks out gate C and gate D, so downstream spending cannot stay hidden', () => {
  const id = 'cost-dashboard-downstream';
  sessions.create({ id, slug: id, title: 'the downstream cost view', branch: 'main' });
  sessions.patch(id, {
    gate_a_cost_usd: 1,
    gate_b_cost_usd: 2,
    gate_c_cost_usd: 8,
    gate_d_cost_usd: 4,
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'cost'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /REQ\s+STATE\s+GATE A\s+GATE B\s+GATE C\s+GATE D\s+TOTAL\s+SLUG/);
  assert.match(text, /cost-dashboard-downstream/);
  assert.match(text, /\$1\.0000\s+\$2\.0000\s+\$8\.0000\s+\$4\.0000\s+\$15\.0000/);
  assert.match(text, /Total .*Gate A .*Gate B .*Gate C .*Gate D /);
  assert.match(text, /private, management-facing/);
});
