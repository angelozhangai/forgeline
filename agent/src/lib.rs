//! forgeline-agent: the resident half of forgeline Cloud (docs/cloud-agent.md, section 8).
//!
//! Everything lives in this library and `main.rs` only calls [`cli::main`], so the integration tests under
//! `tests/` drive the same code the binary runs instead of a copy of it.

pub mod actions;
pub mod b64;
pub mod cli;
pub mod client;
pub mod config;
pub mod daemon;
pub mod device;
pub mod doctor;
pub mod hook;
pub mod journal;
pub mod keystore;
pub mod local_api;
pub mod paths;
pub mod service;
pub mod spool;
pub mod state;
pub mod time;
pub mod trust;
pub mod wire;

/// The version reported in `auth.agent.version` and by `forgeline-agent version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
