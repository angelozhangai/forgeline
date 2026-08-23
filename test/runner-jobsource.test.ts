// Unit tests: the JobSource seam (the control-plane / runner boundary - the jobs/port.ts interface, the
// jobs/index.ts selection point, and the localJobSource adapter).
// It holds two lines: (1) the `jobSource` at the selection point is localJobSource (which enumerates the DB);
// (2) claimDueJobs takes only sessions in a POLLER_DRIVEN state (the due jobs) - a state waiting on a human, or
// a terminal one, must never enter the job queue.
// FORGE_DB must be set before the imports (real node:sqlite, isolated with :memory:).
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../src/store/index.ts');
const { jobSource } = await import('../src/orchestrator/jobs/index.ts');
const { localJobSource } = await import('../src/orchestrator/jobs/local.ts');

function mk(id: string, state: string): void {
  store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

test('the jobSource selection point is localJobSource (the DB-enumerating adapter)', () => {
  assert.equal(jobSource, localJobSource);
  assert.equal(typeof jobSource.claimDueJobs, 'function');
});

test('claimDueJobs: takes only POLLER_DRIVEN states (the due jobs); states waiting on a human and terminal states never enter the queue', async () => {
  mk('due-intake', 'INTAKE'); // POLLER_DRIVEN
  mk('due-cloop', 'GATE_C_LOOP'); // POLLER_DRIVEN
  mk('wait-go', 'AWAITING_GO'); // waiting on a human - it must not enter the job queue
  mk('done', 'DONE'); // terminal - it must not enter the job queue

  const ids = (await jobSource.claimDueJobs(100)).map((s) => s.id).sort();
  assert.deepEqual(ids, ['due-cloop', 'due-intake'], 'only POLLER_DRIVEN states are listed');
  assert.ok(!ids.includes('wait-go') && !ids.includes('done'), 'states waiting on a human, and terminal states, never enter the queue');
});

test('claimDueJobs: everything it returns is POLLER_DRIVEN (no non-due state leaks through)', async () => {
  // The same database as the previous case (which left four rows): this asserts the returned set is a subset of
  // POLLER_DRIVEN, so no non-due state leaks.
  for (const s of await jobSource.claimDueJobs(100)) {
    assert.ok(['due-intake', 'due-cloop'].includes(s.id), `a non-due state leaked through: ${s.id}/${s.state}`);
  }
});
