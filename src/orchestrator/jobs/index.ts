// The control-plane / runner boundary - **the JobSource selection point (the only place it is wired)**.
// worker.tick only does `import { jobSource }` and never enumerates due jobs from the DB itself.
//
// The backend is chosen by FORGE_CONTROL_URL (the same style as root.ts reading the FORGE_* infrastructure
// variables, decided once at module load):
//   - set     -> this process is a **pure runner**: it pulls jobs from the remote control plane over HTTP
//                (remotePull).
//   - unset   -> **all-in-one**: enumerate the local DB (the status quo, behaviour unchanged).
import { localJobSource } from './local.ts';
import { makeRemoteJobSource } from './remote.ts';
import { RUNNER_ID } from './runner.ts';
import type { JobSource } from './port.ts';

const controlUrl = process.env.FORGE_CONTROL_URL;
// A pure runner pulls jobs carrying this machine's RUNNER_ID, so the control plane records the lease under
// this runner and hands different jobs to different runners.
export const jobSource: JobSource = controlUrl ? makeRemoteJobSource(controlUrl, process.env.FORGE_CONTROL_TOKEN, RUNNER_ID) : localJobSource;
export { makeRemoteJobSource, dueJobsPayload } from './remote.ts';
export { RUNNER_ID, leaseTtlMs } from './runner.ts';
export type { JobSource } from './port.ts';
