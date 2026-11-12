use super::{
    blobs, get_index,
    model::{Receipt, RunIndex, EVENTS, RUNS},
};
use crate::db::Database;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::HashSet;
use std::fs;

pub fn remove_session(db: &Database, session: &str) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    let runs = {
        let mut stmt = tx.prepare(
            "SELECT value_json FROM kv WHERE ns=?1 AND json_extract(value_json,'$.sessionId')=?2",
        )?;
        let rows = stmt
            .query_map(params![RUNS, session], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|raw| serde_json::from_str::<RunIndex>(&raw))
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    for run in &runs {
        super::resources::recover(db, None, Some(&run.run_id))?;
    }
    for run in &runs {
        tx.execute(
            "DELETE FROM kv WHERE ns=?1 AND key>=?2 AND key<?3",
            params![
                EVENTS,
                format!("{}:", run.run_id),
                format!("{};", run.run_id)
            ],
        )?;
        tx.execute(
            "DELETE FROM kv WHERE ns=?1 AND key=?2",
            params![RUNS, run.run_id],
        )?;
    }
    tx.commit()?;
    // Failed file cleanup is observable; the boot sweep retries unindexed files.
    for run in runs {
        let path = db.data_dir().join("conductor").join(&run.run_id);
        if path.try_exists()? {
            blobs::prune(db.data_dir(), &run.run_id, &HashSet::new())?;
        }
    }
    Ok(())
}

/// Runs only while opening the host, before any writer is admitted.
pub fn sweep(db: &Database) -> Result<()> {
    let root = db.data_dir().join("conductor");
    if !root.try_exists()? {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "CONDUCTOR_UNSAFE_STORE"
    );
    let orphan_sessions = {
        let mut stmt = db.conn().prepare("SELECT DISTINCT json_extract(value_json,'$.sessionId') FROM kv WHERE ns=?1 AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=json_extract(value_json,'$.sessionId'))")?;
        let rows = stmt
            .query_map([RUNS], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for session in orphan_sessions {
        remove_session(db, &session)?;
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        ensure!(entry.file_type()?.is_dir(), "CONDUCTOR_UNSAFE_STORE");
        let name = entry.file_name();
        let run = name.to_str().context("CONDUCTOR_UNSAFE_STORE")?;
        blobs::identifier(run)?;
        let exists: Option<i64> = db
            .conn()
            .query_row(
                "SELECT 1 FROM kv WHERE ns=?1 AND key=?2",
                params![RUNS, run],
                |r| r.get(0),
            )
            .optional()?;
        let mut keep = HashSet::new();
        if exists.is_some() {
            let index = get_index(db.conn(), run)?;
            super::source::retain_chain(db, &index, &mut keep)?;
            keep.insert(index.intake_hash);
            keep.insert(index.checkpoint_hash);
            let mut stmt = db
                .conn()
                .prepare("SELECT value_json FROM kv WHERE ns=?1 AND key>=?2 AND key<?3")?;
            let raw = stmt
                .query_map(params![EVENTS, format!("{run}:"), format!("{run};")], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for row in raw {
                keep.insert(serde_json::from_str::<Receipt>(&row)?.payload_hash);
            }
        }
        blobs::prune(db.data_dir(), run, &keep)?;
    }
    Ok(())
}
