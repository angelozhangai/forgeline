// An architecture-fitness test in the ArchUnit style: core code may not reach the Feishu raw layer (the
// feishu/* directory) or the lark SDK directly. Every IM transport detail lives behind the
// messaging/feishu.ts adapter, and the core depends only on the provider-neutral MessagingPort.
// This is the machine guard behind the README's claim that wiring up Slack changes no core line: the moment
// a feishu or lark import leaks back into the core, CI goes red.
//
// The point: the allowlist is keyed **file -> permitted specifier**, never a whole-file pass. Otherwise a
// file waved through for one legitimate import could later import the lark SDK directly and still be green.
//
// The allowlist is a **ratchet that may only get shorter**: daemon/listen.ts's entry (offline backfill
// reaching straight for feishu/backfill) was removed in Phase 0, and intake.ts's (reading feishu/doc
// directly) in Phase 1 -- reading documents moved into docs/feishu.ts, and the core only ever sees a DocRef.
// What is left is the one IM adapter, messaging/feishu.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

// The specifier substrings each file may import directly. Any file not listed here may not mention feishu/
// or larksuiteoapi at all.
const ALLOW: Record<string, string[]> = {
  'messaging/feishu.ts': ['feishu/', 'larksuiteoapi'], // the Feishu adapter: the lark long connection, feishu/* send/receive and rendering, channel history, and the IM probe
  'messaging/slack.ts': ['slack/'], // the Slack adapter: slack/*'s Web API, Socket Mode and modals
};
// The feishu/* directory is the Feishu provider layer itself: its files may import each other and use the
// lark SDK.
function allowedFor(rel: string): string[] {
  if (rel.startsWith('feishu/')) return ['feishu/', 'larksuiteoapi'];
  if (rel.startsWith('slack/')) return ['slack/']; // likewise slack/* is the Slack provider layer, whose files may import each other
  return ALLOW[rel] ?? [];
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else if (e.name.endsWith('.ts')) out.push(r);
  }
  return out;
}

// Pull out the imports that reach the raw layer directly -- a specifier containing the 'feishu/' directory or
// the 'larksuiteoapi' SDK.
// Every import form is covered, never just `from '...'`: dynamic import() genuinely occurs in this repo
// (index.ts awaits import of 'eval/*'), so a bypass like `await import('@larksuiteoapi/...')` has to be
// caught too, along with side-effect imports and require.
//  * static and re-export: import X from '...' / export ... from '...'
//  * dynamic: import('...'), with or without await and whitespace
//  * side-effect: import '...' with no from
//  * CJS: require('...')
// Only real import string literals match, so stray strings are not hit by mistake -- such as the
// node_modules path index.ts's doctor probes for.
// Note that 'messaging/feishu.ts' contains 'feishu.', not 'feishu/': that is the adapter's own path and does
// not count as reaching the raw layer.
// These are the directory prefixes of the provider raw layers. The core may never reach them directly, only
// through each provider's own messaging/<provider>.ts adapter.
// feishu/ and the lark SDK are handled by feishuImports; slack/ by slackImports -- two symmetric gates.
const SPEC_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import X from '...' / export ... from '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import('...')
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import '...'
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // cjs require('...')
];
function feishuImports(content: string): string[] {
  const specs = new Set<string>();
  for (const re of SPEC_RES) {
    for (const m of content.matchAll(re)) {
      const spec = m[1];
      if (spec.includes('feishu/') || spec.includes('larksuiteoapi')) specs.add(spec);
    }
  }
  return [...specs];
}

function boundaryOffenders(files: { rel: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const { rel, content } of files) {
    const allowed = allowedFor(rel);
    for (const spec of feishuImports(content)) {
      if (!allowed.some((a) => spec.includes(a))) offenders.push(`${rel} → ${spec}`);
    }
  }
  return offenders;
}

function srcFiles(): { rel: string; content: string }[] {
  const files: { rel: string; content: string }[] = [];
  for (const rel of walk(SRC)) {
    files.push({ rel, content: readFileSync(join(SRC, rel), 'utf8') });
  }
  return files;
}

test('architecture boundary: against the real src, the release gate refuses any core file reaching feishu/* or the lark SDK', () => {
  const offenders = boundaryOffenders(srcFiles());
  assert.deepEqual(
    offenders,
    [],
    `these imports reach the Feishu raw layer or the lark SDK and are not on that file's allowlist -- go through MessagingPort instead (startInbound / probe / outbound cards):\n  ${offenders.join('\n  ')}`,
  );
});

// Phase 0 closed the seam: listen no longer has even its one legitimate exemption, offline backfill. The
// backfill loop goes through messaging/backfill.ts and the single channel-history round trip lives inside the
// adapter (port.listHistorySince). This test pins the seam shut -- pull feishu/* back into listen, even the
// backfill that used to be legitimate, and the gate goes red.
test('architecture boundary: after Phase 0, listen may not reach feishu/* even for backfill', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'daemon/listen.ts',
      content: `
        import { backfillAll } from '../feishu/backfill.ts';
        export async function listen() {
          await backfillAll();
          await import('@larksuiteoapi/node-sdk');
        }
      `,
    },
  ]);
  assert.deepEqual(offenders, ['daemon/listen.ts → ../feishu/backfill.ts', 'daemon/listen.ts → @larksuiteoapi/node-sdk']);
});

// The allowlist is a ratchet: adding an exemption punches a hole in the seam, so it has to be deliberate --
// changing this assertion -- rather than one more line added in passing.
test('architecture boundary: the allowlist holds nothing but the IM adapters themselves, one per provider', () => {
  assert.deepEqual(Object.keys(ALLOW).sort(), ['messaging/feishu.ts', 'messaging/slack.ts']);
});

// -- The third boundary, added in Phase 3: the symmetric guard over the Slack raw layer -----------------
// The Feishu gate was retrofitted, after the core had already been reaching feishu/backfill directly. Slack
// gets its gate from day one, so nobody repeats the "let it leak in, then spend a phase pulling it back"
// cycle.
function slackImports(content: string): string[] {
  const specs = new Set<string>();
  for (const re of SPEC_RES) {
    for (const m of content.matchAll(re)) {
      if (/(^|\/)slack\/[A-Za-z0-9_-]+\.ts$/.test(m[1])) specs.add(m[1]);
    }
  }
  return [...specs];
}
function slackOffenders(files: { rel: string; content: string }[]): string[] {
  const out: string[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith('slack/') || rel === 'messaging/slack.ts') continue;
    for (const spec of slackImports(content)) out.push(`${rel} → ${spec}`);
  }
  return out;
}

test('architecture boundary: in the real src, only messaging/slack.ts may touch slack/*', () => {
  const offenders = slackOffenders(srcFiles());
  assert.deepEqual(offenders, [], `these imports reach the Slack raw layer and should go through MessagingPort:\n  ${offenders.join('\n  ')}`);
});

test('architecture boundary: a core file reaching slack/web or slack/socket is caught, while the adapter itself passes', () => {
  assert.deepEqual(
    slackOffenders([
      { rel: 'daemon/listen.ts', content: `import { slackApi } from '../slack/web.ts';` },
      { rel: 'notify.ts', content: `await import('./slack/socket.ts');` },
      { rel: 'messaging/slack.ts', content: `import { slackApi } from '../slack/web.ts';` },
      { rel: 'slack/socket.ts', content: `import { appToken } from './web.ts';` },
    ]),
    ['daemon/listen.ts → ../slack/web.ts', 'notify.ts → ./slack/socket.ts'],
  );
});

test('architecture boundary: sneaking the lark SDK into a core file through a side-effect import or require turns the release gate red', () => {
  const offenders = boundaryOffenders([
    { rel: 'orchestrator/worker.ts', content: `import '@larksuiteoapi/node-sdk';` },
    { rel: 'notify.ts', content: `const lark = require('@larksuiteoapi/node-sdk');` },
  ]);
  assert.deepEqual(offenders, [
    'orchestrator/worker.ts → @larksuiteoapi/node-sdk',
    'notify.ts → @larksuiteoapi/node-sdk',
  ]);
});

// Phase 1 closed the seam: intake lost its exemption for reading Feishu documents too -- reading goes
// through the docs registry (DocSource.read).
test('architecture boundary: after Phase 1, intake may not reach feishu/* even to read a document', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'intake.ts',
      content: `
        import { readPrd } from './feishu/doc.ts';
        import { sendBotCard } from './feishu/dm.ts';
      `,
    },
  ]);
  assert.deepEqual(offenders, ['intake.ts → ./feishu/doc.ts', 'intake.ts → ./feishu/dm.ts']);
});

// -- The second boundary, added in Phase 1: document sources are used only through the registry -----------
// docs/<source>.ts is the **implementation**; docs/index.ts is where it is **wired in**. The moment the core
// imports one source directly, "adding a source is adding one line of registration" stops being true: that
// direct import rots along with the source, and it bypasses the fallback and deduplication rules in the
// resolver. There are only two exceptions: inside docs/ itself (the registry, and what the sources share)
// and the tests.
function docSourceOffenders(files: { rel: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith('docs/')) continue; // the registry itself, and the sources' own internals
    for (const re of SPEC_RES) {
      for (const m of content.matchAll(re)) {
        const spec = m[1];
        if (/(^|\/)docs\/[A-Za-z0-9_-]+\.ts$/.test(spec) && !spec.endsWith('/docs/index.ts')) {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
  }
  return offenders;
}

test('architecture boundary: in the real src, core files use document sources only through docs/index.ts, never a concrete source', () => {
  const offenders = docSourceOffenders(srcFiles());
  assert.deepEqual(offenders, [], `these imports reach a concrete document source and should go through docs/index.ts:\n  ${offenders.join('\n  ')}`);
});

test('architecture boundary: importing docs/feishu.ts directly is caught, while going through docs/index.ts passes', () => {
  assert.deepEqual(
    docSourceOffenders([
      { rel: 'intake.ts', content: `import { feishuDocs } from './docs/feishu.ts';` },
      { rel: 'gates/gateA.ts', content: `import { commentDoc } from '../docs/index.ts';` },
    ]),
    ['intake.ts → ./docs/feishu.ts'],
  );
});

test('architecture boundary: strings that are not imports -- doctor probes, documentation text -- are not hit by mistake', () => {
  const offenders = boundaryOffenders([
    {
      rel: 'index.ts',
      content: `
        const sdkPath = 'node_modules/@larksuiteoapi/node-sdk';
        const note = 'feishu/backfill.ts is documented in README';
      `,
    },
  ]);
  assert.deepEqual(offenders, []);
});
