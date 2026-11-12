use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BLOB: u64 = 8 * 1024 * 1024;

pub(super) fn identifier(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "CONDUCTOR_INVALID_ID"
    );
    Ok(())
}

pub(super) fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn directory(data: &Path, run: &str, create: bool) -> Result<PathBuf> {
    identifier(run)?;
    let root = data.canonicalize()?;
    let mut dir = root.clone();
    for part in ["conductor", run] {
        dir.push(part);
        match fs::symlink_metadata(&dir) {
            Ok(meta) => ensure!(
                !meta.file_type().is_symlink() && meta.is_dir(),
                "CONDUCTOR_UNSAFE_STORE"
            ),
            Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&dir)?
            }
            Err(error) => return Err(error.into()),
        }
        ensure!(
            dir.canonicalize()?.starts_with(&root),
            "CONDUCTOR_UNSAFE_STORE"
        );
    }
    Ok(dir)
}

fn blob_path(data: &Path, run: &str, digest: &str, create: bool) -> Result<PathBuf> {
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "CONDUCTOR_INVALID_HASH"
    );
    Ok(directory(data, run, create)?.join(format!("{digest}.json")))
}

pub(super) fn put(data: &Path, run: &str, value: &Value) -> Result<(String, u64)> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() as u64 <= MAX_BLOB, "CONDUCTOR_PAYLOAD_LIMIT");
    let digest = hash(&bytes);
    let target = blob_path(data, run, &digest, true)?;
    if target.try_exists()? {
        get(data, run, &digest)?;
        return Ok((digest, bytes.len() as u64));
    }
    let temporary = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // The host serializes journal writers. Never replace existing payloads.
        ensure!(!target.try_exists()?, "CONDUCTOR_BLOB_COLLISION");
        fs::rename(&temporary, &target)?;
        Ok(())
    })();
    if let Err(error) = result {
        if let Err(cleanup) = fs::remove_file(&temporary) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                return Err(error.context(format!("Conductor temp cleanup failed: {cleanup}")));
            }
        }
        return Err(error);
    }
    Ok((digest, bytes.len() as u64))
}

pub(super) fn get(data: &Path, run: &str, digest: &str) -> Result<Value> {
    let path = blob_path(data, run, digest, false)?;
    let meta = fs::symlink_metadata(&path).context("CONDUCTOR_PAYLOAD_MISSING")?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_BLOB,
        "CONDUCTOR_UNSAFE_PAYLOAD"
    );
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(MAX_BLOB + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_BLOB, "CONDUCTOR_PAYLOAD_LIMIT");
    if hash(&bytes) != digest {
        bail!("CONDUCTOR_PAYLOAD_CORRUPT");
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// Prune only recognized, regular host files; never recurse into foreign data.
pub(super) fn prune(
    data: &Path,
    run: &str,
    keep: &std::collections::HashSet<String>,
) -> Result<()> {
    let dir = directory(data, run, false)?;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().context("CONDUCTOR_UNSAFE_STORE")?;
        let parts: Vec<_> = name.split('.').collect();
        let digest = parts.first().copied().unwrap_or("");
        let valid_hash = digest.len() == 64
            && digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
        let recognized = valid_hash
            && (parts.len() == 2 && parts[1] == "json"
                || parts.len() == 3
                    && uuid::Uuid::parse_str(parts[1]).is_ok()
                    && parts[2] == "tmp");
        ensure!(
            recognized && entry.file_type()?.is_file(),
            "CONDUCTOR_UNSAFE_STORE"
        );
        if parts.last() == Some(&"tmp") || !keep.contains(digest) {
            fs::remove_file(entry.path())?;
        }
    }
    if keep.is_empty() {
        fs::remove_dir(dir)?;
    }
    Ok(())
}
