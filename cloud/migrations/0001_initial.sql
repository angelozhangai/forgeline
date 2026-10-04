-- forgeline Cloud, initial schema: docs/cloud-agent.md section 10.1, as drafted there.
--
-- Applied with `wrangler d1 migrations apply DB --remote --env <env>` (tools/deploy.sh does it before every
-- deploy) and by the test suite before every run (test/setup.ts), so the tests always run against exactly
-- these files. Never edit a migration that has been applied anywhere: add the next numbered file instead.
--
-- Bodies -- turn summaries, reply text, prompts -- are never stored here (threat 11). Jobs keep a SHA-256 of
-- their params; the params themselves live in the device's Durable Object until delivered or expired.
-- Every table carries an owner id directly or through `devices`, but tenant isolation is not a security
-- boundary yet (docs/architecture-control-plane-split.md, red lines).

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- The IM identities that are the owner. Only these are ever obeyed (D7).
CREATE TABLE identities (
  provider TEXT NOT NULL,
  workspace TEXT NOT NULL,
  user TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, workspace, user)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  agent_version TEXT,
  policy TEXT,
  created_at INTEGER NOT NULL,
  enrolled_at INTEGER,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  UNIQUE (owner_id, name)
);

-- kid = first 16 characters of base64url(SHA-256(raw public key)) (section 5.2).
CREATE TABLE device_keys (
  kid TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

-- One-time enrolment codes, stored hashed; 10 minutes, 5 attempts, single use (section 3.6).
CREATE TABLE enrollments (
  code_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER
);

CREATE TABLE sessions (
  device_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  title TEXT,
  last_event_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, agent, session)
);

-- An IM message the cloud posted, and the session it stands for. A reply in its thread is routed through here.
CREATE TABLE cards (
  provider TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  kind TEXT NOT NULL,
  conversation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, channel, message)
);
CREATE INDEX cards_by_session ON cards (device_id, agent, session);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  params_sha256 TEXT NOT NULL,
  origin TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'acked', 'done', 'rejected', 'failed', 'expired', 'unknown')),
  result_code TEXT,
  updated_at INTEGER NOT NULL
);
-- Not in the section 10.1 draft: "which of this device's jobs are expired / unknown and not yet reported" is the
-- query P4 runs to tell the owner, and the one a device page will run.
CREATE INDEX jobs_by_device ON jobs (device_id, status);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

-- IM retries are deduplicated here.
CREATE TABLE inbound (
  provider TEXT NOT NULL,
  id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (provider, id)
);

-- Written by src/audit.ts, and by nothing else.
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  owner_id TEXT,
  device_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
  reason TEXT,
  ref TEXT,
  meta TEXT
);
-- Not in the section 10.1 draft: "what happened to this device" is the audit trail's main question.
CREATE INDEX audit_by_device ON audit (device_id, seq);

-- Runtime settings. `jobs_enabled` is the owner's pause-all switch (section 10.3); no row means not paused.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
