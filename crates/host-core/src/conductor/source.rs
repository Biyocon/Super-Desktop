//! Bounded, ignore-aware source anchors. No Git process, filters, hooks or file contents leave the host.
use super::{blobs, get_index, model::RunIndex, own_active, save_index};
use crate::{db::Database, tools::ignore_rules, workspace};
use anyhow::{ensure, Context, Result};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_FILES: usize = 8192;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileAnchor {
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    schema: u32,
    root: String,
    explicit_paths: Vec<String>,
    root_identity: String,
    files: BTreeMap<String, FileAnchor>,
}

fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn open(path: &Path, directory: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        !reparse(&metadata)
            && if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            },
        "CONDUCTOR_SOURCE_LINK_DENIED"
    );
    Ok(file)
}

fn identity(file: &File) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // The handle is owned and live; Windows initializes the complete struct on success.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } != 0,
            "CONDUCTOR_SOURCE_IDENTITY_UNAVAILABLE"
        );
        let info = unsafe { info.assume_init() };
        Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}

pub(super) fn capture(root: &Path, explicit_paths: &[String]) -> Result<Snapshot> {
    let started = Instant::now();
    let canonical = workspace::simple_canonicalize(root)?;
    ensure!(canonical == root, "CONDUCTOR_SOURCE_ROOT_CHANGED");
    let root_handle = open(root, true)?;
    let root_identity = identity(&root_handle)?;
    ensure!(explicit_paths.len() <= 128, "CONDUCTOR_SOURCE_SCOPE_LIMIT");
    let mut roots = vec![(root.to_path_buf(), false)];
    let mut canonical_paths = Vec::new();
    for declared in explicit_paths {
        let path = workspace::resolve_in_workspace(root, declared).map_err(anyhow::Error::msg)?;
        ensure!(
            path != root
                && !path.components().any(|part| part
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(".git"))
                && !ignore_rules::is_sensitive_path(&path),
            "CONDUCTOR_SOURCE_SCOPE_DENIED"
        );
        canonical_paths.push(
            path.to_str()
                .context("CONDUCTOR_SOURCE_PATH_INVALID")?
                .to_owned(),
        );
        if path.try_exists()? {
            roots.push((path, true));
        }
    }
    let mut files = BTreeMap::new();
    let mut total_bytes = 0;
    for (search_root, scoped) in roots {
        let mut walker = WalkBuilder::new(&search_root);
        walker
            .hidden(false)
            .parents(false)
            .git_global(false)
            .git_exclude(false)
            .git_ignore(!scoped)
            .ignore(!scoped)
            .require_git(false)
            .follow_links(false);
        ignore_rules::configure_walker(&mut walker, root, scoped);
        for entry in walker.build() {
            ensure!(
                started.elapsed() < Duration::from_secs(10),
                "CONDUCTOR_SOURCE_TIME_LIMIT"
            );
            let entry = entry.context("CONDUCTOR_SOURCE_WALK_FAILED")?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(path)?;
            ensure!(!reparse(&metadata), "CONDUCTOR_SOURCE_LINK_DENIED");
            if metadata.is_dir() {
                continue;
            }
            ensure!(metadata.is_file(), "CONDUCTOR_SOURCE_SPECIAL_FILE_DENIED");
            if ignore_rules::is_sensitive_path(path) {
                continue;
            }
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("CONDUCTOR_SOURCE_PATH_INVALID")?
                .replace('\\', "/");
            if files.contains_key(&relative) {
                continue;
            }
            ensure!(
                files.len() < MAX_FILES && metadata.len() <= MAX_FILE_BYTES,
                "CONDUCTOR_SOURCE_SIZE_LIMIT"
            );
            total_bytes += metadata.len();
            ensure!(
                total_bytes <= MAX_SOURCE_BYTES,
                "CONDUCTOR_SOURCE_SIZE_LIMIT"
            );
            ensure!(
                workspace::simple_canonicalize(path)? == path,
                "CONDUCTOR_SOURCE_LINK_DENIED"
            );
            let file = open(path, false)?;
            let before = file.metadata()?;
            let file_identity = identity(&file)?;
            let mut bytes = Vec::new();
            (&file).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            ensure!(
                bytes.len() as u64 <= MAX_FILE_BYTES
                    && before.len() == after.len()
                    && before.modified()? == after.modified()?
                    && bytes.len() as u64 == after.len()
                    && identity(&open(path, false)?)? == file_identity,
                "CONDUCTOR_SOURCE_CHANGED_DURING_CAPTURE"
            );
            files.insert(
                relative,
                FileAnchor {
                    sha256: blobs::hash(&bytes),
                    bytes: bytes.len() as u64,
                },
            );
        }
    }
    ensure!(
        workspace::simple_canonicalize(root)? == root
            && identity(&open(root, true)?)? == root_identity,
        "CONDUCTOR_SOURCE_ROOT_CHANGED"
    );
    Ok(Snapshot {
        schema: 1,
        root: root
            .to_str()
            .context("CONDUCTOR_SOURCE_PATH_INVALID")?
            .into(),
        root_identity,
        explicit_paths: canonical_paths,
        files,
    })
}

pub(super) fn fingerprint(snapshot: &Snapshot) -> Result<String> {
    Ok(format!(
        "sha256:{}",
        blobs::hash(&serde_json::to_vec(snapshot)?)
    ))
}

pub fn capture_for_session(
    db: &Database,
    session: &str,
    explicit_paths: &[String],
) -> Result<Value> {
    let snapshot = capture(Path::new(&super::project(db, session)?), explicit_paths)?;
    Ok(
        json!({"fingerprint": fingerprint(&snapshot)?, "fileCount": snapshot.files.len(), "policy": "host-visible-source-v1"}),
    )
}

pub(super) fn initial(
    db: &Database,
    run: &str,
    root: &str,
    intake: &Value,
    explicit_paths: &[String],
) -> Result<(String, u64)> {
    let snapshot = capture(Path::new(root), explicit_paths)?;
    if let Some(expected) = intake.get("sourceFingerprint") {
        ensure!(
            expected.as_str() == Some(&fingerprint(&snapshot)?),
            "CONDUCTOR_SOURCE_CHANGED"
        );
    }
    blobs::put(
        db.data_dir(),
        run,
        &json!({"snapshot": snapshot, "previous": null, "effect": null}),
    )
}

pub(super) fn expected(db: &Database, index: &RunIndex) -> Result<Snapshot> {
    let hash = index
        .source_hash
        .as_deref()
        .context("CONDUCTOR_SOURCE_ANCHOR_MISSING")?;
    let payload = blobs::get(db.data_dir(), &index.run_id, hash)?;
    Ok(serde_json::from_value(payload["snapshot"].clone())?)
}

pub fn validate(db: &Database, session: &str, run: &str) -> Result<Value> {
    let index = get_index(db.conn(), run)?;
    own_active(db, &index, session)?;
    let snapshot = expected(db, &index)?;
    ensure!(
        capture(Path::new(&index.project_path), &snapshot.explicit_paths)? == snapshot,
        "CONDUCTOR_SOURCE_CHANGED"
    );
    Ok(json!({"fingerprint": fingerprint(&snapshot)?, "revision": index.source_revision}))
}

/// Called under the same host lock as the confined executor. Only the executed
/// target may differ; unrelated changes are never adopted as this run's output.
pub fn record_effect(
    db: &Database,
    session: &str,
    binding: &super::ToolAccess,
    tool: &str,
    args: &Value,
) -> Result<()> {
    let mut index = get_index(db.conn(), &binding.run_id)?;
    own_active(db, &index, session)?;
    let before = expected(db, &index)?;
    let after = capture(Path::new(&index.project_path), &before.explicit_paths)?;
    let path = args["path"]
        .as_str()
        .context("CONDUCTOR_TOOL_PATH_REQUIRED")?;
    let target = workspace::resolve_in_workspace(Path::new(&index.project_path), path)
        .map_err(anyhow::Error::msg)?;
    let relative = target
        .strip_prefix(&index.project_path)?
        .to_str()
        .context("CONDUCTOR_SOURCE_PATH_INVALID")?
        .replace('\\', "/");
    let mut comparable = after.clone();
    if let Some(original) = before.files.get(&relative) {
        comparable.files.insert(relative.clone(), original.clone());
    } else {
        comparable.files.remove(&relative);
    }
    ensure!(comparable == before, "CONDUCTOR_UNEXPECTED_SOURCE_CHANGE");
    ensure!(
        index.source_revision < super::model::MAX_EVENTS,
        "CONDUCTOR_SOURCE_EFFECT_LIMIT"
    );
    let payload = json!({"snapshot": after, "previous": index.source_hash,
        "effect": {"path": relative, "tool": tool, "dispatchId": binding.dispatch_id, "workerId": binding.worker_id}});
    let size = serde_json::to_vec(&payload)?.len() as u64;
    ensure!(
        index.bytes + size <= super::model::MAX_RUN_BYTES,
        "CONDUCTOR_RUN_SIZE_LIMIT"
    );
    let (hash, bytes) = blobs::put(db.data_dir(), &index.run_id, &payload)?;
    index.source_hash = Some(hash);
    index.source_revision += 1;
    index.bytes += bytes;
    save_index(db.conn(), &index)
}

pub(super) fn retain_chain(
    db: &Database,
    index: &RunIndex,
    keep: &mut HashSet<String>,
) -> Result<()> {
    let mut current = index.source_hash.clone();
    let mut count = 0;
    while let Some(hash) = current {
        ensure!(
            count <= super::model::MAX_EVENTS && keep.insert(hash.clone()),
            "CONDUCTOR_SOURCE_CHAIN_INVALID"
        );
        let payload = blobs::get(db.data_dir(), &index.run_id, &hash)?;
        current = match &payload["previous"] {
            Value::Null => None,
            Value::String(value) => Some(value.clone()),
            _ => anyhow::bail!("CONDUCTOR_SOURCE_CHAIN_INVALID"),
        };
        count += 1;
    }
    Ok(())
}
