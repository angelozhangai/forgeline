# forgeline Cloud

The Cloudflare Worker that devices running `forgeline-agent` dial into: one `DeviceHub` Durable Object per
device holding its WebSocket, presence and job queue, and D1 for devices, jobs and the audit trail. The design,
threat model and wire protocol are in [../docs/cloud-agent.md](../docs/cloud-agent.md); this file covers running,
testing and deploying it.

## Status: P1 skeleton (#50)

| Here | Not yet |
| --- | --- |
| `GET /healthz`; `GET /v1/devices/<device_id>/connect` (WebSocket); everything else 404 | Enrolment and the challenge-response handshake (P2, #51) |
| `DeviceHub`: hibernatable socket, `ping`/`pong` auto-response, presence, newest connection replaces the older (4005) | Delivering jobs: a job goes out as a signed frame after `welcome`, which P2 brings |
| Per-device job queue in Durable Object storage: bound of 100, TTL, an alarm that marks expired jobs in D1 and audits them | Telling the owner in chat that a job expired (P4, #53) |
| D1 schema (`migrations/`), `audit()` used by every state change, structured JSON logs | The Slack ingress (P4) |
| Wire protocol v1 framing on WebCrypto Ed25519 (`src/wire/`), checked against every golden fixture | |

**Unauthenticated connections are accepted only when `FORGELINE_ENV` is exactly `dev`**, and refused for every
other value, `prod` and a missing one included ([src/admission.ts](src/admission.ts)). `test/connect.prod.test.ts`
proves it against the prod configuration as shipped. P2 replaces that file with the real handshake.

## Layout

```
wrangler.jsonc        dev and prod environments; no account-specific values (see "Deploying")
src/index.ts          Worker entry: routes
src/hub.ts            DeviceHub Durable Object
src/admission.ts      who may hold a socket -- the P1 seam P2 replaces
src/jobs.ts           job validation, limits, the kill switches
src/audit.ts          the audit helper; src/log.ts structured logs
src/wire/             canonical JSON, envelope verification and signing (docs/cloud-agent.md sections 5.2-5.4)
migrations/           D1 migrations (section 10.1)
test/                 vitest inside workerd; test/*.prod.test.ts run under the prod environment
tools/deploy.sh       the only way this is deployed
```

## Tests

```sh
cd cloud
npm ci
npm run ci          # typecheck + tests on workerd + a dry-run build of both environments (what CI runs)
npm test            # tests only
```

The tests run inside workerd, the runtime the Worker is deployed on, against the real `wrangler.jsonc`, as two
vitest projects: `dev` (everything) and `prod` (`test/*.prod.test.ts`, under the prod environment). D1 migrations
are applied from `migrations/` before every test file. `test/wire.test.ts` runs every case in
`../fixtures/wire/v1/` and re-signs every accepted frame with the test keys, requiring identical bytes -- this is
the protocol's second implementation, and the fixtures are the contract between it, the reference in
`tools/wire-fixtures.ts` and the agent.

The root suite (`npm run ci` at the repository root) does not run these; `.github/workflows/cloud.yml` does, on
every pull request. The root suite does guard the boundary: `src/` never imports `cloud/`, and `cloud/` never
imports `tools/` or anything from `src/` outside an (empty) allowlist (`test/arch-boundary.test.ts`).

## Dependencies

No runtime dependencies: Ed25519 is WebCrypto in workerd, and IM APIs will be plain `fetch`
(docs/cloud-agent.md section 11.2). Development only:

| Package | Why |
| --- | --- |
| `wrangler` | Bundles and deploys the Worker, applies D1 migrations, and parses `wrangler.jsonc` for the tests |
| `vitest` | The test runner. Pinned to 4.x: `@cloudflare/vitest-pool-workers` does not support 5 yet |
| `@cloudflare/vitest-pool-workers` | Runs the tests inside workerd with real Durable Objects, D1 and WebSockets, instead of mocks of them |
| `typescript` | `tsc --noEmit`; nothing is compiled -- wrangler and vitest strip types themselves |
| `@cloudflare/workers-types` | The runtime's API types. Used instead of `wrangler types`, whose output would have to be committed and regenerated on every wrangler bump; the bindings are in [src/env.ts](src/env.ts) |

`overrides` in `package.json` lifts the exact `wrangler` and `miniflare` versions that
`@cloudflare/vitest-pool-workers` pins up to the `wrangler` this package deploys with. Without it there are two
wranglers and two workerd binaries, the tests run on an older runtime than the one deployed, and the pinned
versions carry known advisories (undici, sharp). Upgrade `wrangler` and that override together, keep
`compatibility_date` no newer than the workerd in the lockfile, and run `npm run ci`.

## Configuration

| Variable | dev | prod | Meaning |
| --- | --- | --- | --- |
| `FORGELINE_ENV` | `dev` | `prod` | The environment. Only `dev` admits unauthenticated sockets; anything unknown fails `/healthz` |
| `FORGELINE_JOBS_ENABLED` | `true` | `false` | Deploy-time kill switch (section 10.3): no job is created unless it is exactly `true` |

The runtime kill switch is the `settings` row `jobs_enabled` in D1: no row means not paused, and any value but
`true` pauses job creation. Until the owner's `pause all` command exists (P4), set it by hand:

```sh
npx wrangler d1 execute DB --remote --env dev --command "INSERT INTO settings (key, value) VALUES ('jobs_enabled', 'false') ON CONFLICT (key) DO UPDATE SET value = excluded.value"
```

Secrets only ever go in with `npx wrangler secret put <NAME> --env <env>`. P1 has none; P2 adds the cloud signing
key. For `npm run dev`, local values go in `.dev.vars`, which is gitignored.

## Deploying

Nothing has been deployed yet: it waits for the dedicated Cloudflare account (decision D8 -- never inside a
product's infrastructure). This repository is public, so **nothing that identifies a deployment is committed**:

| Value | Where it comes from |
| --- | --- |
| Account id | `CLOUDFLARE_ACCOUNT_ID`, required by `tools/deploy.sh` -- so a deploy can never fall through to whichever account a login session happens to pick |
| Credentials | `CLOUDFLARE_API_TOKEN`, an API token scoped to the dedicated account only (also required) |
| D1 database ids | Not needed: `wrangler.jsonc` names the databases (`forgeline-dev`, `forgeline-prod`) and wrangler looks the ids up in the account |
| Hostname | The account's own `workers.dev` subdomain; custom domains are not configured in this file |
| Secrets | `wrangler secret put` |

`test/config.test.ts` fails if an account id, database id, route, email address or 32-hex id ever appears in
`wrangler.jsonc` -- `wrangler d1 create` and a first deploy that provisions a database both offer to write the
id back into that file, and one "yes" would publish it with the next commit.

Once the account exists:

1. In the dashboard, create an API token from the "Edit Cloudflare Workers" template, add **D1: Edit**, and limit
   it to the dedicated account (no zones). Keep it in your secret store, not in a file in this checkout.
2. Export both values in the shell you deploy from:
   ```sh
   export CLOUDFLARE_ACCOUNT_ID=<the dedicated account id>
   export CLOUDFLARE_API_TOKEN=<the scoped token>
   ```
3. Create the database once. `--update-config=false` keeps wrangler from writing its id into `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create forgeline-dev --update-config=false
   ```
4. Deploy. The script runs `npm run ci`, applies the D1 migrations, then deploys:
   ```sh
   npm run deploy:dev
   ```
5. Check it: `/healthz` on the Worker's `workers.dev` URL (printed by the deploy) answers
   `{"ok":true,"service":"forgeline-cloud","env":"dev","wire":[1]}`; a WebSocket client on
   `wss://<that host>/v1/devices/dev_<26-character ULID>/connect` gets `pong` for `ping`.

`prod` is the same with `forgeline-prod` and `npm run deploy:prod`. Until P2 it refuses every device connection,
and its jobs switch is off.
