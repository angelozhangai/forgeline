//! The WebSocket client (docs/cloud-agent.md sections 5.1 and 5.9): dial out, keep the connection alive, and come
//! back after every kind of failure except the ones where coming back cannot help.
//!
//! - **Heartbeat**: the literal text frame `ping` every `heartbeat`; the cloud answers `pong` from a Durable Object
//!   auto-response without waking. Silence for 2.5 heartbeats means the connection is dead, whatever TCP thinks.
//! - **Reconnect**: full-jitter exponential backoff, 1 s doubling to a 60 s cap, reset after a connection that
//!   lasted 5 minutes (so a flapping link backs off, and a long-lived one that drops retries quickly).
//! - **Stop**: after close codes 4001 (authentication failed), 4003 (revoked), 4004 (unknown device) and 4009
//!   (unsupported version) the client stops for good and says why. Retrying cannot fix any of them, and a revoked
//!   device hammering the cloud is noise in the audit log at best.
//! - **Sleep**: timers run on the monotonic clock, which stops while a laptop sleeps. After waking, the socket is
//!   almost certainly dead but nothing has noticed. The client compares wall-clock and monotonic progress every few
//!   seconds; a jump means the machine slept, and it reconnects at once instead of waiting out the heartbeat.
//!
//! What runs on an open socket is a [`Link`]. The handshake is its first method -- the seam where P2's
//! challenge/auth/welcome goes. Until then the daemon's link refuses to proceed (see `daemon.rs`).

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::wire::MAX_FRAME_BYTES;

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Close codes after which the agent does not reconnect (section 5.9), with what `status` says about each.
pub fn halting_close(code: u16) -> Option<&'static str> {
    match code {
        4001 => Some("the cloud refused this device's authentication (4001)"),
        4003 => Some("this device was revoked (4003); enrol it again to reconnect"),
        4004 => Some("the cloud does not know this device (4004); enrol it again"),
        4009 => Some(
            "the cloud does not speak this agent's protocol version (4009); upgrade forgeline-agent",
        ),
        _ => None,
    }
}

/// What the connection should do after a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Send(Vec<String>),
    /// Send these frames (typically a signed `error`), then close with `code`, then reconnect.
    Close {
        code: u16,
        reason: String,
        send: Vec<String>,
    },
}

/// What the handshake established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Established {
    pub heartbeat: Duration,
}

/// Why a connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum End {
    /// Do not reconnect; the string is for `status`.
    Halt(String),
    Retry(String),
    /// Reconnect without waiting (the machine just woke up).
    RetryNow(String),
}

/// What runs on an open socket.
pub trait Link {
    /// Runs first on every connection, before any other frame is read. P2 implements challenge/auth/welcome here.
    fn handshake(&mut self, ws: &mut Ws) -> impl Future<Output = Result<Established, End>>;
    /// Frames to send once the handshake is done (spooled events).
    fn on_open(&mut self) -> Vec<String>;
    fn on_frame(&mut self, text: &str) -> Step;
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Until the handshake says otherwise.
    pub heartbeat: Duration,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    pub reset_after: Duration,
    pub connect_timeout: Duration,
    pub sleep_check: Duration,
    /// Wall-clock progress beyond monotonic progress that counts as "the machine slept".
    pub sleep_jump: Duration,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            heartbeat: Duration::from_secs(30),
            backoff_base: Duration::from_secs(1),
            backoff_cap: Duration::from_secs(60),
            reset_after: Duration::from_secs(300),
            connect_timeout: Duration::from_secs(15),
            sleep_check: Duration::from_secs(5),
            sleep_jump: Duration::from_secs(15),
        }
    }
}

/// Full-jitter exponential backoff: the n-th consecutive failure waits a uniformly random time in
/// `[0, min(cap, base * 2^n)]`. Jitter matters because every device of an owner loses the cloud at the same moment
/// (a deploy, an outage) and would otherwise come back in lockstep.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    failures: u32,
}

impl Backoff {
    pub fn new(base: Duration, cap: Duration) -> Backoff {
        Backoff {
            base,
            cap,
            failures: 0,
        }
    }

    /// The ceiling for the next wait.
    pub fn ceiling(&self) -> Duration {
        self.base
            .saturating_mul(1u32.checked_shl(self.failures.min(31)).unwrap_or(u32::MAX))
            .min(self.cap)
    }

    /// The next wait, given a uniform random number in [0, 1).
    pub fn next(&mut self, unit: f64) -> Duration {
        let d = self.ceiling().mul_f64(unit.clamp(0.0, 1.0));
        self.failures = self.failures.saturating_add(1);
        d
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

pub fn random_unit() -> f64 {
    let n = u64::from_le_bytes(crate::wire::random_bytes());
    (n >> 11) as f64 / (1u64 << 53) as f64
}

/// `wss://host/v1/devices/<id>/connect` from the configured cloud (`ws://` only for a loopback http cloud,
/// which config validation already restricted).
pub fn connect_url(cloud: &str, device_id: &str) -> Result<String, String> {
    let cloud = crate::config::normalize_cloud(cloud)?;
    if !crate::wire::is_party(device_id) || !device_id.starts_with("dev_") {
        return Err(format!("not a device id: {device_id:?}"));
    }
    let ws = if let Some(rest) = cloud.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        format!("ws://{}", cloud.trim_start_matches("http://"))
    };
    Ok(format!("{ws}/v1/devices/{device_id}/connect"))
}

/// TLS with an explicit provider (ring) and Mozilla's roots compiled in. Not the OS trust store: enrolment pins the
/// cloud's key on first use over this connection, and a locally installed interception CA should not be able to
/// sit in the middle of that (T6).
fn tls() -> Result<Connector, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

fn ws_config() -> WebSocketConfig {
    // Section 5.11 caps frames at 64 KiB, and the verifier refuses anything larger as `malformed` (with a signed
    // error and close 4000, as for any malformed frame). The transport allows twice that so a slightly oversized
    // frame reaches the verifier and gets that answer; beyond it the connection is dropped without reading more.
    WebSocketConfig::default()
        .max_message_size(Some(2 * MAX_FRAME_BYTES))
        .max_frame_size(Some(2 * MAX_FRAME_BYTES))
}

/// Connection state, as `status` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Connecting,
    Connected { since_ms: i64 },
    Waiting { why: String, retry_in: Duration },
    Stopped { why: String },
}

/// Connect and stay connected until a halting condition. Returns why it stopped.
pub async fn run<L: Link>(
    url: &str,
    link: &mut L,
    opts: &Options,
    report: &mut dyn FnMut(State),
) -> String {
    let mut backoff = Backoff::new(opts.backoff_base, opts.backoff_cap);
    loop {
        report(State::Connecting);
        let (end, lasted) = match tokio::time::timeout(opts.connect_timeout, connect(url)).await {
            Ok(Ok(ws)) => session(ws, link, opts, report).await,
            Ok(Err(e)) => (
                End::Retry(format!("could not connect: {e}")),
                Duration::ZERO,
            ),
            Err(_) => (
                End::Retry(format!(
                    "could not connect within {} s",
                    opts.connect_timeout.as_secs()
                )),
                Duration::ZERO,
            ),
        };
        if lasted >= opts.reset_after {
            backoff.reset();
        }
        let (why, wait) = match end {
            End::Halt(why) => {
                report(State::Stopped { why: why.clone() });
                return why;
            }
            End::Retry(why) => (why, backoff.next(random_unit())),
            End::RetryNow(why) => {
                backoff.reset();
                (why, Duration::ZERO)
            }
        };
        report(State::Waiting {
            why,
            retry_in: wait,
        });
        tokio::time::sleep(wait).await;
    }
}

async fn connect(url: &str) -> Result<Ws, String> {
    let connector = if url.starts_with("wss://") {
        Some(tls()?)
    } else {
        None
    };
    let (ws, _) =
        tokio_tungstenite::connect_async_tls_with_config(url, Some(ws_config()), true, connector)
            .await
            .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// One connection. Returns how it ended and how long it was established.
async fn session<L: Link>(
    mut ws: Ws,
    link: &mut L,
    opts: &Options,
    report: &mut dyn FnMut(State),
) -> (End, Duration) {
    let est = match link.handshake(&mut ws).await {
        Ok(est) => est,
        Err(end) => {
            let _ = ws.close(None).await;
            return (end, Duration::ZERO);
        }
    };
    let opened = Instant::now();
    report(State::Connected {
        since_ms: crate::time::now_ms(),
    });
    let end = live(&mut ws, link, opts, est.heartbeat).await;
    (end, opened.elapsed())
}

async fn send_all(ws: &mut Ws, frames: Vec<String>) -> Result<(), End> {
    for f in frames {
        ws.send(Message::text(f))
            .await
            .map_err(|e| End::Retry(format!("send failed: {e}")))?;
    }
    Ok(())
}

async fn live<L: Link>(ws: &mut Ws, link: &mut L, opts: &Options, heartbeat: Duration) -> End {
    if let Err(end) = send_all(ws, link.on_open()).await {
        return end;
    }
    let dead_after = heartbeat.mul_f64(2.5);
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
    let mut check = tokio::time::interval_at(
        tokio::time::Instant::now() + opts.sleep_check,
        opts.sleep_check,
    );
    let mut last_rx = Instant::now();
    let mut clocks = (SystemTime::now(), Instant::now());
    loop {
        tokio::select! {
            msg = ws.next() => {
                let msg = match msg {
                    None => return End::Retry("the connection closed".into()),
                    Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(e))) => {
                        let _ = ws.close(Some(CloseFrame { code: CloseCode::from(4000), reason: "oversized frame".into() })).await;
                        return End::Retry(format!("the cloud sent an oversized frame: {e}"));
                    }
                    Some(Err(e)) => return End::Retry(format!("the connection failed: {e}")),
                    Some(Ok(m)) => m,
                };
                last_rx = Instant::now();
                match msg {
                    Message::Text(t) if t.as_str() == "pong" => {}
                    Message::Text(t) => match link.on_frame(t.as_str()) {
                        Step::Send(frames) => {
                            if let Err(end) = send_all(ws, frames).await {
                                return end;
                            }
                        }
                        Step::Close { code, reason, send } => {
                            let _ = send_all(ws, send).await;
                            let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.clone().into() })).await;
                            return End::Retry(format!("closed by this device ({code}): {reason}"));
                        }
                    },
                    Message::Close(frame) => {
                        let code = frame.as_ref().map_or(1005, |f| u16::from(f.code));
                        let reason = frame.map(|f| f.reason.to_string()).unwrap_or_default();
                        return match halting_close(code) {
                            Some(why) => End::Halt(why.to_string()),
                            None => End::Retry(format!("the cloud closed the connection ({code}) {reason}").trim_end().to_string()),
                        };
                    }
                    // The protocol is text frames only; a binary frame means the other end is not speaking it.
                    Message::Binary(_) => {
                        let _ = ws.close(Some(CloseFrame { code: CloseCode::from(4000), reason: "text frames only".into() })).await;
                        return End::Retry("the cloud sent a binary frame".into());
                    }
                    // WebSocket-level pings are answered by the library; any traffic counts as liveness.
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if last_rx.elapsed() > dead_after {
                    return End::Retry(format!("no traffic for {} s; the connection is dead", last_rx.elapsed().as_secs()));
                }
                if let Err(end) = send_all(ws, vec!["ping".into()]).await {
                    return end;
                }
            }
            _ = check.tick() => {
                let (wall, mono) = (SystemTime::now(), Instant::now());
                if slept(clocks, (wall, mono), opts.sleep_jump) {
                    return End::RetryNow("the machine was asleep; reconnecting".into());
                }
                clocks = (wall, mono);
            }
        }
    }
}

/// Whether the wall clock advanced more than `jump` beyond the monotonic clock between two samples -- the monotonic
/// clock stops during sleep and the wall clock does not.
pub fn slept(before: (SystemTime, Instant), after: (SystemTime, Instant), jump: Duration) -> bool {
    let wall = after.0.duration_since(before.0).unwrap_or(Duration::ZERO);
    let mono = after.1.duration_since(before.1);
    wall.saturating_sub(mono) > jump
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_cap_and_resets() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let ceilings: Vec<u64> = (0..9)
            .map(|_| {
                let c = b.ceiling().as_secs();
                b.next(0.5);
                c
            })
            .collect();
        assert_eq!(ceilings, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        b.reset();
        assert_eq!(b.ceiling(), Duration::from_secs(1));
        for _ in 0..100 {
            b.next(0.0);
        }
        assert_eq!(
            b.ceiling(),
            Duration::from_secs(60),
            "no overflow after many failures"
        );
    }

    #[test]
    fn backoff_is_full_jitter() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        for _ in 0..6 {
            b.next(0.0);
        }
        assert_eq!(b.clone().next(0.0), Duration::ZERO);
        assert_eq!(b.clone().next(0.5), Duration::from_secs(30));
        assert!(b.clone().next(0.999_999) < Duration::from_secs(60));
        for _ in 0..1000 {
            let u = random_unit();
            assert!((0.0..1.0).contains(&u));
        }
    }

    #[test]
    fn only_the_four_codes_halt() {
        for code in [4001, 4003, 4004, 4009] {
            assert!(halting_close(code).is_some(), "{code}");
        }
        for code in [1000, 1001, 1006, 1011, 4000, 4005] {
            assert!(halting_close(code).is_none(), "{code}");
        }
    }

    #[test]
    fn builds_the_connect_url() {
        let id = "dev_01M3ZGYZ00MZDA2E2C003XDNC6";
        assert_eq!(
            connect_url("https://agent.example.com", id).unwrap(),
            format!("wss://agent.example.com/v1/devices/{id}/connect")
        );
        assert_eq!(
            connect_url("http://127.0.0.1:8787/", id).unwrap(),
            format!("ws://127.0.0.1:8787/v1/devices/{id}/connect")
        );
        assert!(connect_url("http://agent.example.com", id).is_err());
        assert!(connect_url("https://agent.example.com", "cloud").is_err());
        assert!(connect_url("https://agent.example.com", "dev_../x").is_err());
    }

    #[test]
    fn detects_sleep_from_clock_divergence() {
        let t0 = (SystemTime::now(), Instant::now());
        let awake = (t0.0 + Duration::from_secs(5), t0.1 + Duration::from_secs(5));
        let woke = (
            t0.0 + Duration::from_secs(3600),
            t0.1 + Duration::from_secs(5),
        );
        let jump = Duration::from_secs(15);
        assert!(!slept(t0, awake, jump));
        assert!(slept(t0, woke, jump));
        // A wall clock stepped backwards is not sleep.
        assert!(!slept((t0.0 + Duration::from_secs(60), t0.1), awake, jump));
    }

    #[test]
    fn the_tls_provider_is_compiled_in() {
        // rustls panics at runtime when no provider was compiled in; this fails the build's tests instead.
        tls().unwrap();
    }
}
