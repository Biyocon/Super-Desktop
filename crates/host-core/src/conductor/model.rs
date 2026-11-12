use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const RUNS: &str = "conductor.runs.v1";
pub(super) const EVENTS: &str = "conductor.events.v1";
pub(super) const MAX_EVENTS: u64 = 2048;
pub(super) const MAX_RUN_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Lifecycle {
    Running,
    OwnerWaiting,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunIndex {
    pub schema: u32,
    pub run_id: String,
    pub session_id: String,
    #[serde(default)]
    pub request_id: Option<String>,
    pub project_path: String,
    pub version: u64,
    pub event_count: u64,
    pub bytes: u64,
    pub status: Lifecycle,
    pub checkpoint_hash: String,
    pub intake_hash: String,
    #[serde(default)]
    pub source_hash: Option<String>,
    #[serde(default)]
    pub source_revision: u64,
    pub runtime_id: String,
    // Not returned by list/load; only the admitted runtime receives a lease.
    pub lease: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub run_id: String,
    pub session_id: String,
    pub project_path: String,
    pub runtime_id: String,
    pub intake: Value,
    pub checkpoint: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Append {
    pub run_id: String,
    pub session_id: String,
    pub lease: String,
    pub expected_version: u64,
    pub event_id: String,
    pub event: Value,
    pub checkpoint: Option<Value>,
    pub status: Option<Lifecycle>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    pub event_id: String,
    pub version: u64,
    pub request_hash: String,
    pub payload_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resume {
    pub run_id: String,
    pub session_id: String,
    pub runtime_id: String,
    pub expected_version: u64,
    pub validated_checkpoint_hash: String,
}
