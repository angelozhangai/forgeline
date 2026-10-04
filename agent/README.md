# forgeline-agent

The resident half of forgeline Cloud: a small binary on each developer machine that dials out to the cloud,
receives a **fixed set of typed actions**, and gates every one of them on a **local policy the cloud cannot
change**. The design, threat model and wire protocol are in [../docs/cloud-agent.md](../docs/cloud-agent.md);
this file covers the crate. Engineering rules are the repository's: [../AGENTS.md](../AGENTS.md).

## Status: P3 skeleton (#52)

| Works now | Arrives later |
| --- | --- |
| Wire protocol v1 framing: canonical JSON, Ed25519 sign/verify, the exact check order, held to `fixtures/wire/v1/` | The challenge/auth/welcome handshake and `enroll` (P2, #51). Until then the daemon stops right after a socket opens instead of processing frames from an unauthenticated connection |
| Config with everything off by default; the `auth.policy` summary (aliases, never paths) | `keys.update` and key rotation (P2) |
| State directory (0700) and files (0600); device key storage: Keychain on macOS, 0600 file on Linux | Turning hook reports into events and cards (P5) |
| WebSocket client: `ping`/`pong`, full-jitter backoff, the four close codes that stop it, sleep detection | `session.reply` and `wait claude` (P6), `session.start` (P7), `permission.answer` (P8) |
| Typed action framework with the gate order, `device.pause`, the job journal, the event spool | `install-hooks`, `rotate-key`, clock skew and workspace-trust checks in `doctor` |
| Local Unix-socket API with a peer-credential check; `hook <agent>`; `status`, `doctor`, `pause`, `resume`, `run`, `service` | Release artifacts (the workflow exists; nothing is tagged yet) |

## Build and test

```sh
cd agent
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests need no network, no Keychain and no service manager: the WebSocket tests run a local server, the CLI
tests run the binary in a throwaway `HOME`, and `service install --no-load` only writes the unit. One test touches
the real login Keychain and is opt-in: `cargo test -- --ignored keychain` (macOS).

`tests/wire_fixtures.rs` is the contract test. It runs every frame in `../fixtures/wire/v1/` through the verifier,
re-signs every accepted frame and requires the result to match the fixture byte for byte, and pins edge cases the
fixtures do not cover (each cross-checked against the reference in `tools/wire-fixtures.ts`).

## Layout

| Module | What |
| --- | --- |
| `wire` | Envelopes, the canonical form, signing, the verifier. `wire/json.rs` reads JSON exactly as `JSON.parse` does, which is what makes the rejection codes agree with the reference |
| `actions` | The action framework and the gate order; `actions/pause.rs` is `device.pause` |
| `device` | The job path on a live connection: verify, journal, ack, gates, execute, result, events |
| `client` | The WebSocket loop; `Link::handshake` is where P2 plugs in |
| `daemon` | `run`: local API, hook spool, connection |
| `hook` | `hook <agent>`: exit 0, empty stdout, milliseconds |
| `local_api` | The Unix socket and its peer-credential check |
| `config`, `state`, `journal`, `spool`, `keystore`, `trust`, `paths` | Section 8 of the design |
| `service` | launchd plist and systemd user unit |
| `doctor`, `cli` | The command line |

## Files

`$XDG_CONFIG_HOME/forgeline-agent/config.toml` (default `~/.config/...`, macOS included) is the policy; see the
design's section 8.2 for the format. A missing file allows nothing. A config file that another user can write
is refused, since whoever can write it can widen the policy.

`$XDG_STATE_HOME/forgeline-agent/` (default `~/.local/state/...`) holds `trust.json`, `paused`, `journal/`,
`spool/`, `sessions/`, `log/` (including `audit.jsonl`, the device's own record of what ran and why) and
`agent.sock`.

## Dependencies

Each one is here for a reason it could not reasonably do without. Adding one means adding a row.

| Crate | Why |
| --- | --- |
| `tokio` (`rt`, `net`, `time`, `macros`, `io-util`, `sync`) | The daemon's runtime: the WebSocket, timers, and the Unix socket, whose `peer_cred()` is the credential check with no extra crate. Current-thread only |
| `tokio-tungstenite` | The WebSocket client (and the test server) |
| `futures-util` (`sink`) | `StreamExt`/`SinkExt` to drive the socket; already required by `tokio-tungstenite` |
| `rustls` (`ring`, no default features) | TLS without OpenSSL. The provider is chosen explicitly: rustls's default, aws-lc-rs, needs cmake and a C toolchain per target, and with no explicit choice rustls panics at runtime if the graph ever enables two providers |
| `webpki-roots` | Mozilla's roots compiled in. Deliberately not the OS trust store: enrolment pins the cloud key on first use over TLS, and a locally installed interception CA should not sit in the middle of that |
| `serde`, `serde_json` | Config, state files, hook payloads, and building frame bodies. Not used to *read* frames: see `wire/json.rs` |
| `toml` (`parse`, `serde`) | The config file |
| `ed25519-dalek` | Signatures. Verification is the cofactorless check with canonical `S`, the same acceptance rule as OpenSSL/BoringSSL behind the reference and the Worker |
| `sha2` | Key ids (SHA-256). Already a dependency of `ed25519-dalek` |
| `getrandom` | OS randomness for keys, nonces, ids and jitter |
| `libc` | `geteuid` for the peer-credential and file-ownership checks. Already in the tree through `tokio` |
| `security-framework` (macOS only) | Keychain storage of the device key |

Not dependencies, on purpose: base64url, canonical JSON, ULIDs and the date format are a few dozen lines each here,
pinned by tests (section 11.1). Base64url in particular is local because the protocol depends on one exact
behaviour general-purpose decoders configure differently (see `b64.rs`). Argument parsing is by hand: a dozen
fixed commands, and the hook path must start as fast as a process can.

## MSRV

`rust-version = "1.85"` in `Cargo.toml`: edition 2024 requires it, and every locked dependency, for every release
target, declares 1.85 or lower (the MSRV-aware resolver chose them that way). CI builds on exactly that version.
Raising it is a deliberate change to `Cargo.toml` and `.github/workflows/agent.yml` together.

## Releases

Pushing a tag `agent-v<version>` (matching `version` in `Cargo.toml`) runs
[`agent-release.yml`](../.github/workflows/agent-release.yml): native builds for `darwin-arm64`, `darwin-x64`
(cross-compiled on an arm64 Mac, where Apple's toolchain targets both), `linux-x64` and `linux-arm64` (static,
musl), published as plain binaries with a `SHA256SUMS` file. Installers verify before running anything:

```sh
curl -fsSLO https://github.com/angelozhangai/forgeline/releases/download/agent-v0.1.0/forgeline-agent-darwin-arm64
curl -fsSLO https://github.com/angelozhangai/forgeline/releases/download/agent-v0.1.0/SHA256SUMS
shasum -a 256 --ignore-missing -c SHA256SUMS
```

macOS binaries are not signed with a Developer ID yet. That matters for the Keychain: an item's access list is
bound to the signature of the binary that created it, so after an upgrade macOS asks before releasing the device
key, and a launchd daemon cannot answer. Until releases are signed, `key_store = "file"` avoids it.
