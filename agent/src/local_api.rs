//! The local API (docs/cloud-agent.md section 8.3): a Unix socket in the 0700 state directory through which hooks
//! and the CLI talk to the daemon. The device's only listener -- there is no TCP port (D3).
//!
//! Two independent locks on the door (threat 9, another local user): the directory is 0700, and every connection's
//! peer credentials are checked against this process's uid before a byte is read. Either alone would do today;
//! both together survive someone loosening the directory by hand.
//!
//! Wire format: one JSON request line, one JSON response line, close.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::config::Agent;
use crate::paths;

/// Hook payloads are small (a few KiB); a bound keeps one confused client from holding a megabyte per connection.
pub const MAX_REQUEST: usize = 1024 * 1024 + 4096;
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// What a hook saw, handed to the daemon as is. Turning it into events and cards is P5; P3 records the session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookReport {
    pub agent: Agent,
    pub at: i64,
    /// The agent's name for the hook event (`Stop`, `agent-turn-complete`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The hook's JSON, or null if it was not JSON.
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Request {
    Hook { report: HookReport },
    Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub version: String,
    pub pid: u32,
    pub started_at: i64,
    /// `not_enrolled`, `connecting`, `connected`, `waiting`, `stopped`.
    pub connection: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DaemonStatus>,
}

impl Response {
    pub fn ok() -> Response {
        Response {
            ok: true,
            error: None,
            status: None,
        }
    }
    pub fn error(why: impl Into<String>) -> Response {
        Response {
            ok: false,
            error: Some(why.into()),
            status: None,
        }
    }
}

/// Client side, blocking: used by hooks and the CLI, which must not pay for an async runtime.
pub fn request(socket: &Path, req: &Request, timeout: Duration) -> std::io::Result<Response> {
    let mut stream = std::os::unix::net::UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut line = serde_json::to_vec(req).map_err(std::io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line)?;
    let mut reader = BufReader::new(stream).take(MAX_REQUEST as u64);
    let mut answer = String::new();
    reader.read_line(&mut answer)?;
    serde_json::from_str(&answer).map_err(std::io::Error::other)
}

/// Bind the socket, replacing a stale one. A socket that still answers belongs to a running daemon: refuse rather
/// than steal it, or two daemons would each hold half the hooks.
pub fn bind(socket: &Path) -> Result<tokio::net::UnixListener, String> {
    if std::os::unix::net::UnixStream::connect(socket).is_ok() {
        return Err(format!(
            "another forgeline-agent daemon is already listening on {}",
            socket.display()
        ));
    }
    match std::fs::remove_file(socket) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "cannot remove the stale socket {}: {e}",
                socket.display()
            ));
        }
    }
    let listener = tokio::net::UnixListener::bind(socket)
        .map_err(|e| format!("cannot listen on {}: {e}", socket.display()))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", socket.display()))?;
    Ok(listener)
}

/// Serve forever. Connections are handled one at a time: each is one short line in and one out, bounded by a read
/// timeout, and handling them in turn keeps the handler free of locking.
pub async fn serve(
    listener: tokio::net::UnixListener,
    mut handle: impl FnMut(Request) -> Response,
) {
    loop {
        let stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                eprintln!("forgeline-agent: local API accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        // Credentials first, before reading anything the peer sent.
        let peer = stream.peer_cred().map(|c| c.uid());
        if !peer_allowed(peer.as_ref().ok().copied(), paths::euid()) {
            match peer {
                Ok(uid) => {
                    eprintln!("forgeline-agent: refused a local API connection from uid {uid}")
                }
                Err(e) => eprintln!(
                    "forgeline-agent: refused a local API connection whose credentials could not be read: {e}"
                ),
            }
            continue;
        }
        let response = match tokio::time::timeout(READ_TIMEOUT, read_request(stream)).await {
            Ok(Ok((req, stream))) => Some((handle(req), stream)),
            Ok(Err(e)) => {
                eprintln!("forgeline-agent: bad local API request: {e}");
                None
            }
            Err(_) => None,
        };
        if let Some((resp, mut stream)) = response {
            let mut line = serde_json::to_vec(&resp).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
            line.push(b'\n');
            let _ = tokio::time::timeout(READ_TIMEOUT, stream.write_all(&line)).await;
        }
    }
}

/// Only this user may talk to the daemon; credentials that cannot be read fail closed. Not even root is let in:
/// root does not need the socket to act as this user, and nothing legitimate runs hooks as root on its behalf.
pub fn peer_allowed(peer_uid: Option<u32>, own_uid: u32) -> bool {
    peer_uid == Some(own_uid)
}

async fn read_request(
    stream: tokio::net::UnixStream,
) -> std::io::Result<(Request, tokio::net::UnixStream)> {
    let mut reader =
        tokio::io::AsyncReadExt::take(tokio::io::BufReader::new(stream), MAX_REQUEST as u64);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let req = serde_json::from_str(&line).map_err(std::io::Error::other)?;
    Ok((req, reader.into_inner().into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_have_a_stable_shape() {
        let r = Request::Hook {
            report: HookReport {
                agent: Agent::Codex,
                at: 1,
                hook: None,
                session: Some("t".into()),
                cwd: None,
                payload: serde_json::Value::Null,
            },
        };
        let text = serde_json::to_string(&r).unwrap();
        assert_eq!(
            text,
            r#"{"op":"hook","report":{"agent":"codex","at":1,"session":"t","payload":null}}"#
        );
        assert_eq!(serde_json::from_str::<Request>(&text).unwrap(), r);
        assert_eq!(
            serde_json::to_string(&Request::Status).unwrap(),
            r#"{"op":"status"}"#
        );
    }

    #[test]
    fn only_the_same_uid_is_let_in() {
        assert!(peer_allowed(Some(501), 501));
        assert!(!peer_allowed(Some(502), 501));
        assert!(!peer_allowed(Some(0), 501));
        assert!(!peer_allowed(None, 501));
    }

    #[tokio::test]
    async fn serves_same_uid_clients_and_refuses_a_live_socket() {
        let dir = std::env::temp_dir().join(format!(
            "fa-api-{}",
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("agent.sock");
        let listener = bind(&sock).unwrap();
        assert!(bind(&sock).unwrap_err().contains("already listening"));
        let server = tokio::spawn(serve(listener, |req| match req {
            Request::Status => Response::ok(),
            Request::Hook { .. } => Response::error("nope"),
        }));
        let sock2 = sock.clone();
        let resp = tokio::task::spawn_blocking(move || {
            request(&sock2, &Request::Status, Duration::from_secs(2))
        })
        .await
        .unwrap()
        .unwrap();
        assert!(resp.ok);
        server.abort();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
