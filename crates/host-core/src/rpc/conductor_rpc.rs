use crate::conductor;
use crate::db::Database;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

/// Private host persistence RPCs, not model tools or renderer gate controls.
pub(super) fn handle(db: &Database, method: &str, params: Value) -> Result<Value> {
    let string = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .context("CONDUCTOR_INVALID_REQUEST")
    };
    match method {
        "conductorStore.createQuality" => {
            conductor::resources::create(db, serde_json::from_value(params)?)
        }
        "conductorStore.releaseQuality" => conductor::resources::release(
            db,
            string("sessionId")?,
            string("runId")?,
            string("resourceId")?,
        ),
        "conductorStore.create" => conductor::create(db, serde_json::from_value(params)?),
        "conductorStore.append" => conductor::append(db, serde_json::from_value(params)?),
        "conductorStore.resume" => conductor::resume(db, serde_json::from_value(params)?),
        "conductorStore.interruptRun" => {
            conductor::interrupt_run(db, string("sessionId")?, string("runId")?)
        }
        "conductorStore.captureSource" => {
            let paths = serde_json::from_value::<Vec<String>>(
                params
                    .get("allowedPaths")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )?;
            conductor::source::capture_for_session(db, string("sessionId")?, &paths)
        }
        "conductorStore.validateSource" => {
            conductor::source::validate(db, string("sessionId")?, string("runId")?)
        }
        "conductorStore.load" => conductor::load(db, string("sessionId")?, string("runId")?),
        "conductorStore.list" => conductor::list(db, string("sessionId")?),
        "conductorStore.events" => conductor::events(
            db,
            string("sessionId")?,
            string("runId")?,
            params.get("after").and_then(Value::as_u64).unwrap_or(0),
        ),
        "conductorStore.interrupt" => {
            Ok(json!({"interrupted": conductor::interrupt(db, Some(string("runtimeId")?))?}))
        }
        _ => bail!("CONDUCTOR_UNKNOWN_METHOD"),
    }
}
