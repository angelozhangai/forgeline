//! The WebSocket client against a local test server: heartbeats, the four close codes that stop it for good,
//! reconnecting after everything else, dead-connection detection, the handshake seam, and one job end to end.

mod common;

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{TempDir, device_id, fixture, key, keyring};
use forgeline_agent::client::{self, End, Established, Link, Options, State, Step, Ws};
use forgeline_agent::config::Config;
use forgeline_agent::daemon::CloudLink;
use forgeline_agent::device::Device;
use forgeline_agent::state::{self, StateDir};
use forgeline_agent::wire::Verifier;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

type ServerWs = WebSocketStream<TcpStream>;

struct Server {
    cloud: String,
    connections: Arc<AtomicUsize>,
    paths: Arc<Mutex<Vec<String>>>,
}

/// A server that runs `behaviour(n, ws)` for its n-th connection (from 0).
async fn server<F, Fut>(behaviour: F) -> Server
where
    F: Fn(usize, ServerWs) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cloud = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let connections = Arc::new(AtomicUsize::new(0));
    let paths = Arc::new(Mutex::new(Vec::new()));
    let (c, p) = (Arc::clone(&connections), Arc::clone(&paths));
    let behaviour = Arc::new(behaviour);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let p = Arc::clone(&p);
            // The callback's error type is fixed by tungstenite's API.
            #[allow(clippy::result_large_err)]
            let record = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                               resp| {
                p.lock().unwrap().push(req.uri().path().to_string());
                Ok(resp)
            };
            let Ok(ws) = tokio_tungstenite::accept_hdr_async(tcp, record).await else {
                continue;
            };
            let n = c.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(behaviour(n, ws));
        }
    });
    Server {
        cloud,
        connections,
        paths,
    }
}

async fn close(mut ws: ServerWs, code: u16) {
    let _ = ws
        .close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: "test".into(),
        }))
        .await;
    // Drain until the client's close arrives, so the close handshake completes.
    while let Some(Ok(_)) = ws.next().await {}
}

fn opts() -> Options {
    Options {
        heartbeat: Duration::from_millis(40),
        backoff_base: Duration::from_millis(5),
        backoff_cap: Duration::from_millis(20),
        reset_after: Duration::from_secs(300),
        connect_timeout: Duration::from_secs(2),
        sleep_check: Duration::from_secs(1),
        sleep_jump: Duration::from_secs(15),
    }
}

#[derive(Default)]
struct TestLink {
    frames: Vec<String>,
    opens: usize,
    halt_handshake: bool,
}

impl Link for TestLink {
    async fn handshake(&mut self, _ws: &mut Ws) -> Result<Established, End> {
        if self.halt_handshake {
            return Err(End::Halt("handshake refused".into()));
        }
        Ok(Established {
            heartbeat: Duration::from_millis(40),
        })
    }
    fn on_open(&mut self) -> Vec<String> {
        self.opens += 1;
        vec![format!("hello {}", self.opens)]
    }
    fn on_frame(&mut self, text: &str) -> Step {
        self.frames.push(text.to_string());
        if text == "close-me" {
            Step::Close {
                code: 4000,
                reason: "asked to".into(),
                send: vec!["bye".into()],
            }
        } else {
            Step::Send(vec![format!("seen {text}")])
        }
    }
}

async fn run_link<L: Link>(s: &Server, link: &mut L) -> (String, Vec<State>) {
    let url = client::connect_url(&s.cloud, &device_id()).unwrap();
    let mut states = Vec::new();
    let why = tokio::time::timeout(
        Duration::from_secs(10),
        client::run(&url, link, &opts(), &mut |st| states.push(st)),
    )
    .await
    .expect("the client did not stop");
    (why, states)
}

async fn settle() {
    // Long enough for a reconnect at the backoff cap to have happened, if the client were going to make one.
    tokio::time::sleep(Duration::from_millis(150)).await;
}

#[tokio::test]
async fn heartbeats_are_literal_ping_and_pong_and_revocation_stops_for_good() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let s = server(move |_, mut ws| {
        let log = Arc::clone(&log);
        async move {
            let mut pings = 0;
            while let Some(Ok(Message::Text(t))) = ws.next().await {
                log.lock().unwrap().push(t.to_string());
                if t.as_str() == "ping" {
                    pings += 1;
                    ws.send(Message::text("pong")).await.unwrap();
                    if pings == 3 {
                        return close(ws, 4003).await;
                    }
                }
            }
        }
    })
    .await;
    let (why, states) = run_link(&s, &mut TestLink::default()).await;
    settle().await;
    assert!(why.contains("revoked"), "{why}");
    assert_eq!(
        s.connections.load(Ordering::SeqCst),
        1,
        "no reconnect after 4003"
    );
    assert_eq!(*seen.lock().unwrap(), ["hello 1", "ping", "ping", "ping"]);
    assert_eq!(
        s.paths.lock().unwrap()[0],
        format!("/v1/devices/{}/connect", device_id())
    );
    assert!(matches!(states.last(), Some(State::Stopped { .. })));
    assert!(
        states
            .iter()
            .any(|st| matches!(st, State::Connected { .. }))
    );
}

#[tokio::test]
async fn each_halting_close_code_stops_the_client() {
    for code in [4001u16, 4003, 4004, 4009] {
        let s = server(move |_, ws| close(ws, code)).await;
        let (why, _) = run_link(&s, &mut TestLink::default()).await;
        settle().await;
        assert!(
            why.contains(&code.to_string()) || why.contains("revoked"),
            "{code}: {why}"
        );
        assert_eq!(
            s.connections.load(Ordering::SeqCst),
            1,
            "{code}: reconnected"
        );
    }
}

#[tokio::test]
async fn every_other_ending_reconnects() {
    let s = server(|n, mut ws| async move {
        match n {
            0 => close(ws, 4000).await,
            1 => close(ws, 4005).await,
            2 => close(ws, 1011).await,
            // Drop the TCP connection without a close frame.
            3 => {
                let _ = ws.next().await;
                drop(ws);
            }
            _ => close(ws, 4003).await,
        }
    })
    .await;
    let (why, states) = run_link(&s, &mut TestLink::default()).await;
    assert!(why.contains("revoked"), "{why}");
    assert_eq!(s.connections.load(Ordering::SeqCst), 5);
    let waits: Vec<String> = states
        .iter()
        .filter_map(|st| {
            if let State::Waiting { why, .. } = st {
                Some(why.clone())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(waits.len(), 4, "{waits:?}");
    assert!(
        waits[0].contains("4000") && waits[1].contains("4005") && waits[2].contains("1011"),
        "{waits:?}"
    );
}

#[tokio::test]
async fn a_silent_connection_is_declared_dead_and_replaced() {
    let s = server(|n, mut ws| async move {
        if n == 0 {
            // Read the pings, never answer, never close.
            while let Some(Ok(_)) = ws.next().await {}
        } else {
            close(ws, 4003).await;
        }
    })
    .await;
    let (_, states) = run_link(&s, &mut TestLink::default()).await;
    assert_eq!(s.connections.load(Ordering::SeqCst), 2);
    assert!(
        states
            .iter()
            .any(|st| matches!(st, State::Waiting { why, .. } if why.contains("no traffic"))),
        "{states:?}"
    );
}

#[tokio::test]
async fn frames_reach_the_link_and_a_link_close_closes_with_its_code() {
    let got = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&got);
    let s = server(move |n, mut ws| {
        let log = Arc::clone(&log);
        async move {
            if n > 0 {
                return close(ws, 4003).await;
            }
            ws.send(Message::text("hello")).await.unwrap();
            ws.send(Message::text("close-me")).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                match m {
                    Message::Text(t) if t.as_str() != "ping" => {
                        log.lock().unwrap().push(t.to_string())
                    }
                    Message::Close(Some(f)) => log
                        .lock()
                        .unwrap()
                        .push(format!("close {}", u16::from(f.code))),
                    _ => {}
                }
            }
        }
    })
    .await;
    let mut link = TestLink::default();
    run_link(&s, &mut link).await;
    assert_eq!(link.frames, ["hello", "close-me"]);
    assert_eq!(
        *got.lock().unwrap(),
        ["hello 1", "seen hello", "bye", "close 4000"]
    );
    assert_eq!(
        link.opens, 2,
        "a close the device initiated (4000) is followed by a reconnect"
    );
}

#[tokio::test]
async fn the_handshake_runs_first_and_can_stop_everything() {
    let s = server(|_, mut ws| async move { while let Some(Ok(_)) = ws.next().await {} }).await;
    let mut link = TestLink {
        halt_handshake: true,
        ..TestLink::default()
    };
    let (why, _) = run_link(&s, &mut link).await;
    settle().await;
    assert_eq!(why, "handshake refused");
    assert_eq!((link.opens, s.connections.load(Ordering::SeqCst)), (0, 1));
}

const NOW: i64 = 1_791_072_000_000;

fn device(dir: &TempDir) -> (Device, StateDir) {
    let state = StateDir::open(&dir.path().join("state")).unwrap();
    (
        Device::new(
            &device_id(),
            key("device").signing(),
            keyring(&["cloud"]),
            state.clone(),
            Config::default(),
            Box::new(|| NOW),
        )
        .unwrap(),
        state,
    )
}

#[tokio::test]
async fn the_p3_daemon_link_stops_at_the_handshake_instead_of_looping() {
    let dir = TempDir::new("cl");
    let s = server(|_, mut ws| async move { while let Some(Ok(_)) = ws.next().await {} }).await;
    let (dev, _) = device(&dir);
    let (why, _) = run_link(&s, &mut CloudLink { device: dev }).await;
    settle().await;
    assert!(why.contains("P2"), "{why}");
    assert_eq!(s.connections.load(Ordering::SeqCst), 1);
}

struct DeviceLink(Device);

impl Link for DeviceLink {
    async fn handshake(&mut self, _ws: &mut Ws) -> Result<Established, End> {
        Ok(Established {
            heartbeat: Duration::from_secs(30),
        })
    }
    fn on_open(&mut self) -> Vec<String> {
        self.0.on_open()
    }
    fn on_frame(&mut self, text: &str) -> Step {
        self.0.on_frame(text)
    }
}

#[tokio::test]
async fn a_pause_job_end_to_end_over_a_socket() {
    let dir = TempDir::new("e2e");
    let job = fixture("job-device-pause").frames[0].clone();
    let received = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&received);
    let s = server(move |_, mut ws| {
        let (job, log) = (job.clone(), Arc::clone(&log));
        async move {
            ws.send(Message::text(job)).await.unwrap();
            while let Some(Ok(Message::Text(t))) = ws.next().await {
                let done = {
                    let mut l = log.lock().unwrap();
                    l.push(t.to_string());
                    l.len() == 3
                };
                if done {
                    return close(ws, 4003).await;
                }
            }
        }
    })
    .await;
    let (dev, state) = device(&dir);
    run_link(&s, &mut DeviceLink(dev)).await;
    let mut cloud = Verifier::new("cloud", keyring(&["device"]));
    let kinds: Vec<String> = received
        .lock()
        .unwrap()
        .iter()
        .map(|f| cloud.verify(f, NOW).unwrap().kind)
        .collect();
    assert_eq!(kinds, ["ack", "result", "event"]);
    assert!(state::pause_state(&state).is_paused());
}
