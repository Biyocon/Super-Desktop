//! Host-owned persistence only. Harness remains the sole gate/process engine.
mod blobs;
mod lifecycle;
pub use lifecycle::{remove_session, sweep};
mod model;
#[cfg(test)]
mod tests;
mod tool_access;
pub use tool_access::{validate_tool_access, ToolAccess};
pub mod resources;
pub mod source;

use crate::db::{now_ms, Database};
use anyhow::{ensure, Context, Result};
pub use model::{Append, Create, Lifecycle, Resume};
use model::{Receipt, RunIndex, EVENTS, MAX_EVENTS, MAX_RUN_BYTES, RUNS};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn get_index(conn: &Connection, run: &str) -> Result<RunIndex> {
    blobs::identifier(run)?;
    let raw: String = conn
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![RUNS, run],
            |r| r.get(0),
        )
        .optional()?
        .context("CONDUCTOR_RUN_NOT_FOUND")?;
    let index: RunIndex = serde_json::from_str(&raw)?;
    ensure!(
        index.schema == 1 && index.run_id == run,
        "CONDUCTOR_STORE_INCOMPATIBLE"
    );
    Ok(index)
}

fn save_index(conn: &Connection, index: &RunIndex) -> Result<()> {
    conn.execute("INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(ns,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![RUNS, index.run_id, serde_json::to_string(index)?, index.updated_at])?;
    Ok(())
}

fn project(db: &Database, session: &str) -> Result<String> {
    db.conn().query_row("SELECT p.path FROM sessions s JOIN projects p ON s.project_id=p.id WHERE s.id=?1 AND s.deleted_at IS NULL", [session], |r| r.get(0)).optional()?.context("CONDUCTOR_OWNER_PROJECT_REQUIRED")
}

fn own(db: &Database, index: &RunIndex, session: &str) -> Result<()> {
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session],
        |row| row.get(0),
    )?;
    ensure!(
        index.session_id == session && exists,
        "CONDUCTOR_OWNER_MISMATCH"
    );
    Ok(())
}

fn own_active(db: &Database, index: &RunIndex, session: &str) -> Result<()> {
    own(db, index, session)?;
    ensure!(
        project(db, session)? == index.project_path,
        "CONDUCTOR_PROJECT_CHANGED"
    );
    Ok(())
}

fn checkpoint_value(value: &Value) -> Result<std::borrow::Cow<'_, Value>> {
    Ok(match value.as_str() {
        Some(text) => std::borrow::Cow::Owned(serde_json::from_str(text)?),
        None => std::borrow::Cow::Borrowed(value),
    })
}

fn checkpoint(value: &Value, run: &str, session: &str) -> Result<()> {
    // Full semantic parsing is performed by the pinned engine before this RPC.
    let value = checkpoint_value(value)?;
    ensure!(
        value.get("recordFormatVersion").and_then(Value::as_u64) == Some(5)
            && value.get("runId").and_then(Value::as_str) == Some(run)
            && value.get("ownerSessionId").and_then(Value::as_str) == Some(session),
        "CONDUCTOR_CHECKPOINT_IDENTITY_INVALID"
    );
    Ok(())
}

fn public(index: &RunIndex) -> Result<Value> {
    let mut value = serde_json::to_value(index)?;
    value
        .as_object_mut()
        .context("CONDUCTOR_INDEX_INVALID")?
        .remove("lease");
    Ok(value)
}

pub fn create(db: &Database, request: Create) -> Result<Value> {
    blobs::identifier(&request.run_id)?;
    blobs::identifier(&request.runtime_id)?;
    let project_path = project(db, &request.session_id)?;
    ensure!(
        crate::db::canonical_project_path(&request.project_path).as_deref() == Some(&project_path),
        "CONDUCTOR_PROJECT_MISMATCH"
    );
    checkpoint(&request.checkpoint, &request.run_id, &request.session_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM kv WHERE ns=?1 AND key=?2)",
        params![RUNS, request.run_id],
        |r| r.get(0),
    )?;
    ensure!(!exists, "CONDUCTOR_RUN_EXISTS");
    let request_id = request
        .intake
        .get("request")
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(id) = &request_id {
        ensure!(
            uuid::Uuid::parse_str(id).is_ok(),
            "CONDUCTOR_REQUEST_ID_INVALID"
        );
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM kv WHERE ns=?1 AND json_extract(value_json,'$.sessionId')=?2 AND json_extract(value_json,'$.requestId')=?3)", params![RUNS, request.session_id, id], |row| row.get(0))?;
        ensure!(!duplicate, "CONDUCTOR_REQUEST_EXISTS");
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM kv WHERE ns=?1 AND json_extract(value_json,'$.sessionId')=?2",
        params![RUNS, request.session_id],
        |r| r.get(0),
    )?;
    ensure!(count < 128, "CONDUCTOR_SESSION_RUN_LIMIT");
    let (intake_hash, intake_bytes) = blobs::put(db.data_dir(), &request.run_id, &request.intake)?;
    let (checkpoint_hash, checkpoint_bytes) =
        blobs::put(db.data_dir(), &request.run_id, &request.checkpoint)?;
    let (source_hash, source_bytes) = source::initial(
        db,
        &request.run_id,
        &project_path,
        &request.intake,
        &serde_json::from_value::<Vec<String>>(
            checkpoint_value(&request.checkpoint)?
                .get("allowedPaths")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?,
    )?;
    let index = RunIndex {
        schema: 1,
        run_id: request.run_id,
        session_id: request.session_id,
        request_id,
        project_path,
        version: 0,
        event_count: 0,
        bytes: intake_bytes + checkpoint_bytes + source_bytes,
        status: Lifecycle::Running,
        checkpoint_hash,
        intake_hash,
        source_hash: Some(source_hash),
        source_revision: 0,
        runtime_id: request.runtime_id,
        lease: uuid::Uuid::new_v4().to_string(),
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    save_index(&tx, &index)?;
    tx.commit()?;
    Ok(json!({"run": public(&index)?, "lease": index.lease}))
}

pub fn append(db: &Database, request: Append) -> Result<Value> {
    blobs::identifier(&request.event_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let mut index = get_index(&tx, &request.run_id)?;
    own_active(db, &index, &request.session_id)?;
    ensure!(
        !index.lease.is_empty() && index.lease == request.lease,
        "CONDUCTOR_STALE_LEASE"
    );
    let key = format!("{}:{}", request.run_id, request.event_id);
    let request_hash = blobs::hash(&serde_json::to_vec(&request)?);
    let previous: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![EVENTS, key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = previous {
        let receipt: Receipt = serde_json::from_str(&raw)?;
        ensure!(
            receipt.request_hash == request_hash,
            "CONDUCTOR_EVENT_CONFLICT"
        );
        return Ok(
            json!({"version": receipt.version, "currentVersion": index.version, "duplicate": true}),
        );
    }
    ensure!(
        index.version == request.expected_version,
        "CONDUCTOR_STALE_VERSION"
    );
    ensure!(
        matches!(index.status, Lifecycle::Running | Lifecycle::OwnerWaiting),
        "CONDUCTOR_RUN_NOT_ACTIVE"
    );
    ensure!(index.event_count < MAX_EVENTS, "CONDUCTOR_EVENT_LIMIT");
    if let Some(value) = &request.checkpoint {
        checkpoint(value, &request.run_id, &request.session_id)?;
    }
    ensure!(
        request.event.is_object()
            && request.event.get("runId").and_then(Value::as_str) == Some(&request.run_id),
        "CONDUCTOR_EVENT_IDENTITY_INVALID"
    );
    ensure!(
        !matches!(request.status, Some(Lifecycle::Interrupted)),
        "CONDUCTOR_INVALID_STATUS"
    );
    let payload = json!({"event": request.event, "checkpoint": request.checkpoint});
    let bytes = serde_json::to_vec(&payload)?.len() as u64;
    ensure!(
        index.bytes + bytes <= MAX_RUN_BYTES,
        "CONDUCTOR_RUN_SIZE_LIMIT"
    );
    let (payload_hash, stored_bytes) = blobs::put(db.data_dir(), &request.run_id, &payload)?;
    index.bytes += stored_bytes;
    if let Some(value) = &request.checkpoint {
        let size = serde_json::to_vec(value)?.len() as u64;
        ensure!(
            index.bytes + size <= MAX_RUN_BYTES,
            "CONDUCTOR_RUN_SIZE_LIMIT"
        );
        let (digest, stored) = blobs::put(db.data_dir(), &request.run_id, value)?;
        index.checkpoint_hash = digest;
        index.bytes += stored;
    }
    index.version += 1;
    index.event_count += 1;
    index.updated_at = now_ms();
    if let Some(status) = request.status {
        index.status = status;
    }
    let receipt = Receipt {
        event_id: request.event_id,
        version: index.version,
        request_hash,
        payload_hash,
    };
    tx.execute(
        "INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4)",
        params![EVENTS, key, serde_json::to_string(&receipt)?, now_ms()],
    )?;
    save_index(&tx, &index)?;
    tx.commit()?;
    Ok(json!({"version": index.version, "currentVersion": index.version, "duplicate": false}))
}

pub fn load(db: &Database, session: &str, run: &str) -> Result<Value> {
    let index = get_index(db.conn(), run)?;
    own(db, &index, session)?;
    Ok(
        json!({"run": public(&index)?, "resources": resources::snapshot(db, run)?, "resourceIssues": resources::issues(db, run)?, "intake": blobs::get(db.data_dir(), run, &index.intake_hash)?, "checkpoint": blobs::get(db.data_dir(), run, &index.checkpoint_hash)?}),
    )
}

pub fn list(db: &Database, session: &str) -> Result<Value> {
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session],
        |row| row.get(0),
    )?;
    ensure!(exists, "CONDUCTOR_OWNER_MISMATCH");
    let mut stmt = db.conn().prepare("SELECT value_json FROM kv WHERE ns=?1 AND json_extract(value_json,'$.sessionId')=?2 ORDER BY updated_at DESC,key LIMIT 128")?;
    let raw = stmt
        .query_map(params![RUNS, session], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut runs = Vec::new();
    for row in raw {
        let index: RunIndex = serde_json::from_str(&row)?;
        own(db, &index, session)?;
        runs.push(public(&index)?);
    }
    Ok(json!({"runs": runs}))
}

pub fn events(db: &Database, session: &str, run: &str, after: u64) -> Result<Value> {
    let index = get_index(db.conn(), run)?;
    own(db, &index, session)?;
    let mut stmt = db.conn().prepare("SELECT value_json FROM kv WHERE ns=?1 AND key>=?2 AND key<?3 ORDER BY CAST(json_extract(value_json,'$.version') AS INTEGER) LIMIT 2048")?;
    let raw = stmt
        .query_map(params![EVENTS, format!("{run}:"), format!("{run};")], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    let mut page_bytes = 0;
    for row in raw {
        let receipt: Receipt = serde_json::from_str(&row)?;
        if receipt.version > after {
            let payload = blobs::get(db.data_dir(), run, &receipt.payload_hash)?;
            let bytes = serde_json::to_vec(&payload)?.len();
            if !out.is_empty() && page_bytes + bytes > 8 * 1024 * 1024 {
                break;
            }
            page_bytes += bytes;
            out.push(json!({"eventId": receipt.event_id, "version": receipt.version, "payloadHash": receipt.payload_hash, "payload": payload}));
            if out.len() == 64 {
                break;
            }
        }
    }
    Ok(json!({"events": out, "version": index.version}))
}

/// Called on host startup or explicit sidecar loss, never by history reads.
/// It fences old callbacks without inventing a Harness decision or replaying work.
pub fn interrupt(db: &Database, runtime: Option<&str>) -> Result<u64> {
    let tx = db.conn().unchecked_transaction()?;
    let raw = {
        let mut stmt = tx.prepare("SELECT value_json FROM kv WHERE ns=?1")?;
        let rows = stmt
            .query_map([RUNS], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut count = 0;
    for row in raw {
        let mut index: RunIndex = serde_json::from_str(&row)?;
        if runtime.is_none_or(|id| index.runtime_id == id)
            && matches!(index.status, Lifecycle::Running | Lifecycle::OwnerWaiting)
        {
            index.status = Lifecycle::Interrupted;
            index.lease.clear();
            index.version += 1;
            index.updated_at = now_ms();
            save_index(&tx, &index)?;
            count += 1;
        }
    }
    tx.commit()?;
    // Startup retains failures for history instead of disabling ordinary chat.
    if let Err(error) = resources::recover(db, runtime, None) {
        if runtime.is_some() {
            return Err(error);
        }
        eprintln!("[conductor] CONDUCTOR_CONTAINER_CLEANUP_FAILED");
    }
    Ok(count)
}

pub fn interrupt_run(db: &Database, session: &str, run: &str) -> Result<Value> {
    let mut index = get_index(db.conn(), run)?;
    own(db, &index, session)?;
    if matches!(index.status, Lifecycle::Running | Lifecycle::OwnerWaiting) {
        index.status = Lifecycle::Interrupted;
        index.lease.clear();
        index.version += 1;
        index.updated_at = now_ms();
        save_index(db.conn(), &index)?;
    }
    resources::recover(db, None, Some(run))?;
    public(&index)
}

/// The caller must first parse the checkpoint with Harness and validate the
/// current workspace baseline. This is a lease acquisition, NOT gate approval.
pub fn resume(db: &Database, request: Resume) -> Result<Value> {
    blobs::identifier(&request.runtime_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let mut index = get_index(&tx, &request.run_id)?;
    own_active(db, &index, &request.session_id)?;
    ensure!(
        index.version == request.expected_version
            && index.checkpoint_hash == request.validated_checkpoint_hash,
        "CONDUCTOR_STALE_VERSION"
    );
    ensure!(
        index.status == Lifecycle::Interrupted,
        "CONDUCTOR_RESUME_NOT_ALLOWED"
    );
    source::validate(db, &request.session_id, &request.run_id)?;
    ensure!(
        resources::issues(db, &request.run_id)?
            .as_array()
            .is_some_and(Vec::is_empty),
        "CONDUCTOR_RESOURCE_RECOVERY_REQUIRED"
    );
    blobs::get(db.data_dir(), &index.run_id, &index.checkpoint_hash)?;
    index.lease = uuid::Uuid::new_v4().to_string();
    index.runtime_id = request.runtime_id;
    index.status = Lifecycle::Running;
    index.version += 1;
    index.updated_at = now_ms();
    save_index(&tx, &index)?;
    tx.commit()?;
    Ok(json!({"run": public(&index)?, "lease": index.lease}))
}
