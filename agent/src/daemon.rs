//! `forgeline-agent run`: the resident process (docs/cloud-agent.md section 8.1). It serves the local API for
//! hooks, drains the hook spool, and -- once the device is enrolled -- holds the connection to the cloud.
//!
//! One thread, one current-thread runtime: the local API, the connection and the maintenance timer are three
//! futures polled together, so shared state is a `RefCell` and nothing needs a lock.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use crate::client::{self, End, Established, Link, State, Step, Ws};
use crate::config::Config;
use crate::device::Device;
use crate::keystore;
use crate::local_api::{self, DaemonStatus, HookReport, Request, Response};
use crate::paths::Dirs;
use crate::spool::{Item, Spool};
use crate::state::{self, SessionRecord, StateDir};
use crate::time::{self, DAY_MS};
use crate::trust::Trust;

const MAINTENANCE_EVERY: Duration = Duration::from_secs(30);

/// The P3 link: everything but the handshake. Until P2 (#51) implements challenge/auth/welcome, connecting stops
/// right after the socket opens -- the daemon never processes frames from a connection on which the cloud has not
/// proven its key, and it does not loop reconnecting to a cloud it cannot authenticate to.
pub struct CloudLink {
    pub device: Device,
}

impl Link for CloudLink {
    async fn handshake(&mut self, _ws: &mut Ws) -> Result<Established, End> {
        Err(End::Halt("the challenge/auth/welcome handshake arrives with device authentication (P2, #51); nothing was exchanged".into()))
    }
    fn on_open(&mut self) -> Vec<String> {
        self.device.on_open()
    }
    fn on_frame(&mut self, text: &str) -> Step {
        self.device.on_frame(text)
    }
}

struct Shared {
    started_at: i64,
    connection: String,
    detail: Option<String>,
    since: Option<i64>,
}

/// Run until killed. Returns only on a startup error (as text for stderr), so launchd / systemd restart it.
pub fn run(dirs: &Dirs) -> Result<(), String> {
    let (config, _) = Config::load(&dirs.config_file(), &dirs.home)?;
    let state = StateDir::open(&dirs.state)
        .map_err(|e| format!("state directory {}: {e}", dirs.state.display()))?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(serve(config, state))
}

async fn serve(config: Config, state: StateDir) -> Result<(), String> {
    let listener = local_api::bind(&state.socket())?;
    let shared = Rc::new(RefCell::new(Shared {
        started_at: time::now_ms(),
        connection: "not_enrolled".into(),
        detail: None,
        since: None,
    }));
    log(&format!(
        "started (pid {}), local API at {}",
        std::process::id(),
        state.socket().display()
    ));
    drain_hook_spool(&state, &config);

    let api = {
        let shared = Rc::clone(&shared);
        let state = state.clone();
        let config = config.clone();
        local_api::serve(listener, move |req| {
            handle(req, &state, &config, &shared.borrow())
        })
    };
    let maintenance = {
        let state = state.clone();
        let config = config.clone();
        async move {
            let mut tick = tokio::time::interval(MAINTENANCE_EVERY);
            loop {
                tick.tick().await;
                drain_hook_spool(&state, &config);
                state::prune_sessions(&state, time::now_ms() - DAY_MS);
            }
        }
    };
    let connection = connect(config.clone(), state.clone(), Rc::clone(&shared));
    tokio::join!(api, maintenance, connection);
    Ok(())
}

fn handle(req: Request, state: &StateDir, config: &Config, shared: &Shared) -> Response {
    match req {
        Request::Hook { report } => match record(state, config, &report) {
            Ok(()) => Response::ok(),
            Err(e) => Response::error(e),
        },
        Request::Status => Response {
            ok: true,
            error: None,
            status: Some(DaemonStatus {
                version: crate::VERSION.into(),
                pid: std::process::id(),
                started_at: shared.started_at,
                connection: shared.connection.clone(),
                detail: shared.detail.clone(),
                since: shared.since,
            }),
        },
    }
}

/// What a hook report does in P3: remember the session (the fact `session.reply` will gate on). Reports from an
/// agent the policy does not enable are accepted and ignored -- off means off, including bookkeeping.
fn record(state: &StateDir, config: &Config, report: &HookReport) -> Result<(), String> {
    if !config.agent_enabled(report.agent) {
        return Ok(());
    }
    let Some(session) = &report.session else {
        return Ok(());
    };
    let rec = SessionRecord {
        agent: report.agent,
        session: session.clone(),
        cwd: report.cwd.clone(),
        hook: report.hook.clone(),
        last_report_at: report.at,
    };
    state::record_session(state, &rec).map_err(|e| e.to_string())
}

fn drain_hook_spool(state: &StateDir, config: &Config) {
    let spool = Spool::new(&state.spool_dir());
    let Ok((items, bad)) = spool.list() else {
        return;
    };
    for id in bad {
        log(&format!("spool item {id} is unreadable; left in place"));
    }
    for (id, item) in items {
        if let Item::Hook(report) = item {
            if let Err(e) = record(state, config, &report) {
                log(&format!("spooled hook report {id}: {e}"));
            }
            let _ = spool.remove(&id);
        }
    }
}

async fn connect(config: Config, state: StateDir, shared: Rc<RefCell<Shared>>) {
    let set = |connection: &str, detail: Option<String>, since: Option<i64>| {
        let mut s = shared.borrow_mut();
        s.connection = connection.into();
        s.detail = detail;
        s.since = since;
    };
    let ready = (|| -> Result<Option<(String, Device)>, String> {
        let Some(trust) = Trust::load(&state)? else {
            return Ok(None);
        };
        let cloud = config
            .cloud
            .clone()
            .ok_or("enrolled, but config.toml has no `cloud`")?;
        if crate::config::normalize_cloud(&trust.cloud)? != cloud {
            return Err(format!(
                "config.toml says cloud = {cloud}, but this device is enrolled with {}; enrol it again to move it",
                trust.cloud
            ));
        }
        let key = keystore::for_platform(config.key_store, &state)?
            .load()?
            .ok_or("enrolled, but the device key is missing; enrol it again")?;
        let url = client::connect_url(&cloud, &trust.device_id)?;
        let device = Device::new(
            &trust.device_id,
            key,
            trust.keyring()?,
            state.clone(),
            config.clone(),
            Box::new(time::now_ms),
        )
        .map_err(|e| e.to_string())?;
        Ok(Some((url, device)))
    })();
    let (url, device) = match ready {
        Ok(Some(x)) => x,
        Ok(None) => {
            log("not enrolled; serving the local API only");
            return;
        }
        Err(why) => {
            log(&format!("not connecting: {why}"));
            set("stopped", Some(why), Some(time::now_ms()));
            return;
        }
    };
    let mut link = CloudLink { device };
    let why = client::run(&url, &mut link, &client::Options::default(), &mut |s| {
        let now = time::now_ms();
        match s {
            State::Connecting => set("connecting", None, Some(now)),
            State::Connected { since_ms } => {
                log("connected");
                set("connected", None, Some(since_ms));
            }
            State::Waiting { why, retry_in } => {
                log(&format!("{why}; retrying in {} ms", retry_in.as_millis()));
                set("waiting", Some(why), Some(now));
            }
            State::Stopped { why } => set("stopped", Some(why), Some(now)),
        }
    })
    .await;
    log(&format!("stopped connecting: {why}"));
}

fn log(line: &str) {
    eprintln!("{} forgeline-agent: {line}", time::fmt_utc(time::now_ms()));
}
