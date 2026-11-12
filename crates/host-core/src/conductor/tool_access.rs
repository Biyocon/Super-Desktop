//! A narrowing host capability check, never a gate evaluator or permission grant.
use super::{blobs, get_index, model::Receipt, own_active, Lifecycle};
use crate::{db::Database, workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAccess {
    pub run_id: String,
    pub lease: String,
    pub dispatch_id: String,
    pub worker_id: String,
    pub stage: String,
}

pub(super) fn validate_dispatch(
    db: &Database,
    session: &str,
    binding: &ToolAccess,
) -> Result<Value> {
    let index = get_index(db.conn(), &binding.run_id)?;
    own_active(db, &index, session)?;
    ensure!(
        index.status == Lifecycle::Running
            && !index.lease.is_empty()
            && index.lease == binding.lease,
        "CONDUCTOR_STALE_LEASE"
    );
    let mut stmt = db.conn().prepare("SELECT value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 ORDER BY json_extract(value_json,'$.version') DESC")?;
    let rows = stmt.query_map(
        params![super::model::EVENTS, format!("{}:", binding.run_id)],
        |r| r.get::<_, String>(0),
    )?;
    for row in rows {
        let receipt: Receipt = serde_json::from_str(&row?)?;
        let payload = blobs::get(db.data_dir(), &binding.run_id, &receipt.payload_hash)?;
        let event = &payload["event"];
        if event["dispatchId"].as_str() != Some(&binding.dispatch_id) {
            continue;
        }
        ensure!(event["type"] != "dispatch-end", "CONDUCTOR_DISPATCH_CLOSED");
        if event["type"] == "dispatch-start" {
            ensure!(
                event["workerId"].as_str() == Some(&binding.worker_id)
                    && event["stage"].as_str() == Some(&binding.stage),
                "CONDUCTOR_DISPATCH_IDENTITY_INVALID"
            );
            return Ok(event.clone());
        }
    }
    anyhow::bail!("CONDUCTOR_DISPATCH_NOT_FOUND")
}

fn resolve(root: &Path, path: &str) -> Result<PathBuf> {
    workspace::resolve_in_workspace(root, path).map_err(anyhow::Error::msg)
}

/// Rechecked under the host state lock after permission/budget waits. The lock
/// remains held through confined file execution, so interruption/project moves
/// cannot race a newly admitted filesystem effect.
pub fn validate_tool_access(
    db: &Database,
    session: &str,
    binding: &ToolAccess,
    tool: &str,
    args: &Value,
) -> Result<PathBuf> {
    let index = get_index(db.conn(), &binding.run_id)?;
    let start = validate_dispatch(db, session, binding)?;
    ensure!(
        matches!(tool, "Read" | "Glob" | "Grep" | "Write" | "Edit"),
        "CONDUCTOR_TOOL_DENIED"
    );
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .context("CONDUCTOR_TOOL_PATH_REQUIRED")?;
    ensure!(
        args.get("file_path").and_then(Value::as_str) == Some(path),
        "CONDUCTOR_TOOL_PATH_AMBIGUOUS"
    );
    ensure!(
        [
            "filepath",
            "filePath",
            "filename",
            "fileName",
            "file",
            "old_string",
            "new_string"
        ]
        .iter()
        .all(|key| args.get(key).is_none()),
        "CONDUCTOR_TOOL_ARGUMENTS_INVALID"
    );
    let root = PathBuf::from(&index.project_path);
    let target = resolve(&root, path)?;

    // The shared acknowledged dispatch check narrows both files and resources.
    if matches!(tool, "Write" | "Edit") {
        let input = &start["input"];
        ensure!(
            input["runId"].as_str() == Some(&binding.run_id)
                && input["ownerSessionId"].as_str() == Some(session)
                && input["currentStage"].as_str() == Some(&binding.stage)
                && input["admission"]["purpose"] == "implementation"
                && input["executionAuthorization"]["effectProfile"]["filesystem"]
                    == "workspace-write"
                && matches!(binding.stage.as_str(), "headsman" | "integrator"),
            "CONDUCTOR_WRITE_NOT_AUTHORIZED"
        );
        let baseline = &input["baseline"];
        let allowed = baseline["allowedPaths"]
            .as_array()
            .context("CONDUCTOR_BASELINE_PATHS_MISSING")?;
        let excluded = baseline["excludedPaths"]
            .as_array()
            .context("CONDUCTOR_BASELINE_PATHS_MISSING")?;
        let roots = |values: &[Value]| -> Result<Vec<PathBuf>> {
            values
                .iter()
                .map(|value| {
                    let captured = value.as_str().context("CONDUCTOR_BASELINE_PATH_INVALID")?;
                    let current = resolve(&root, captured)?;
                    ensure!(
                        Path::new(captured).is_absolute() && current == Path::new(captured),
                        "CONDUCTOR_SCOPE_CHANGED"
                    );
                    Ok(current)
                })
                .collect()
        };
        ensure!(
            roots(allowed)?.iter().any(|path| target.starts_with(path))
                && !roots(excluded)?.iter().any(|path| target.starts_with(path)),
            "CONDUCTOR_WRITE_OUTSIDE_SCOPE"
        );
        ensure!(
            !target.components().any(|part| part
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")),
            "CONDUCTOR_GIT_WRITE_DENIED"
        );
        if binding.stage == "integrator" {
            let relative = target.strip_prefix(workspace::simple_canonicalize(&root)?)?;
            let components: Vec<_> = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
                .collect();
            ensure!(
                components.iter().any(|c| c == "docs")
                    || components
                        .windows(2)
                        .any(|pair| pair == [".agents", "notes"]),
                "CONDUCTOR_INTEGRATOR_WRITE_DENIED"
            );
        }
        if tool == "Edit" {
            let ops = args["ops"]
                .as_str()
                .context("CONDUCTOR_EDIT_OPS_REQUIRED")?;
            ensure!(
                !ops.split(['\r', '\n']).any(|line| {
                    let header = line.trim_start().to_ascii_uppercase();
                    header.starts_with("MV ")
                        || header == "MV"
                        || header.starts_with("PUT") && header.contains('@')
                }),
                "CONDUCTOR_EDIT_RENAME_DENIED"
            );
        }
        super::source::validate(db, session, &binding.run_id)?;
    }
    Ok(root)
}
