//! Preserve session-owned inputs without inheriting arbitrary scratch outputs.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::scratch;
use crate::transcripts::{CompactionRecord, MessageRecord};

/// Roll back copied inputs if transcript/index publication fails.
pub(super) struct ForkFiles {
    destination: PathBuf,
    committed: bool,
}

impl ForkFiles {
    pub(super) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for ForkFiles {
    fn drop(&mut self) {
        if !self.committed && self.destination.exists() {
            if let Err(error) = fs::remove_dir_all(&self.destination) {
                tracing::warn!(%error, "fork attachment rollback failed");
            }
        }
    }
}

// A file name must not match a prefix of another file name. Inline references
// may be quoted, Markdown links, or plain paths in model/context text.
fn reference_end(tail: &str) -> bool {
    tail.chars().next().is_none_or(|c| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | ']' | '}' | ',' | ';')
    })
}

fn reference_start(prefix: &str) -> bool {
    prefix.chars().next_back().is_none_or(|c| {
        c.is_whitespace() || matches!(c, '@' | '"' | '\'' | '`' | '(' | '[' | '{' | '=' | ':')
    })
}

fn replace_reference(text: &mut String, source: &str, target: &str) -> bool {
    // Windows accepts mixed separators, including paths assembled by Path::join.
    // ASCII separator substitution preserves byte offsets into the original text.
    #[cfg(windows)]
    let (matching_text, matching_source) = (text.replace('\\', "/"), source.replace('\\', "/"));
    #[cfg(windows)]
    let matches = matching_text.match_indices(matching_source.as_str());
    #[cfg(not(windows))]
    let matches = text.match_indices(source);
    let mut result = String::new();
    let mut start = 0;
    let mut changed = false;
    for (offset, _) in matches {
        let end = offset + source.len();
        if reference_start(&text[..offset]) && reference_end(&text[end..]) {
            result.push_str(&text[start..offset]);
            if cfg!(windows) && !text[offset..end].contains('\\') {
                // Keep renderer references in their existing forward-slash style.
                result.push_str(&target.replace('\\', "/"));
            } else {
                result.push_str(target);
            }
            start = end;
            changed = true;
        }
    }
    if changed {
        result.push_str(&text[start..]);
        *text = result;
    }
    changed
}

fn rewrite_value(value: &mut Value, source: &str, target: &str) -> bool {
    match value {
        Value::String(text) => replace_reference(text, source, target),
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= rewrite_value(value, source, target);
            }
            changed
        }
        Value::Object(values) => {
            let mut changed = false;
            for value in values.values_mut() {
                changed |= rewrite_value(value, source, target);
            }
            changed
        }
        _ => false,
    }
}

fn rewrite(
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
    source: &str,
    target: &str,
) -> bool {
    let mut changed = false;
    for record in records {
        changed |= rewrite_value(&mut record.blocks, source, target);
        if let Some(meta) = &mut record.meta {
            changed |= rewrite_value(meta, source, target);
        }
    }
    for record in compactions {
        changed |= replace_reference(&mut record.summary, source, target);
        for value in [&mut record.retained_tail, &mut record.details]
            .into_iter()
            .flatten()
        {
            changed |= rewrite_value(value, source, target);
        }
    }
    changed
}

pub(super) fn preserve(
    data_dir: &Path,
    source_id: &str,
    child_id: &str,
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
) -> Result<ForkFiles> {
    let source = scratch::session_dir(data_dir, source_id)
        .ok_or_else(|| anyhow!("invalid source session id"))?;
    let destination = scratch::session_dir(data_dir, child_id)
        .ok_or_else(|| anyhow!("invalid child session id"))?;
    if destination.try_exists()? {
        return Err(anyhow!("fork scratch directory already exists"));
    }
    let guard = ForkFiles {
        destination,
        committed: false,
    };
    let pasted = source.join("pasted");
    // Scratch is disposable: historical inputs that have already expired do
    // not prevent branching. Never follow a link out of the owned input tree.
    for directory in [scratch::base_dir(data_dir), source, pasted.clone()] {
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(anyhow!("fork input directory is not a regular directory")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(guard),
            Err(error) => return Err(error.into()),
        }
    }
    for entry in fs::read_dir(&pasted)? {
        let entry = entry?;
        let path = entry.path();
        let target = guard.destination.join("pasted").join(entry.file_name());
        let source_path = path.to_string_lossy();
        let target_path = target.to_string_lossy();
        let mut referenced = rewrite(records, compactions, &source_path, &target_path);
        if entry.file_type()?.is_file() {
            let canonical = path.canonicalize()?;
            let canonical_path = canonical.to_string_lossy();
            if canonical_path != source_path {
                referenced |= rewrite(records, compactions, &canonical_path, &target_path);
            }
        }
        if !referenced {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(anyhow!("referenced fork input is not a regular file"));
        }
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
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let mut input = options.open(&path).context("open fork input")?;
        let metadata = input.metadata()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(anyhow!("referenced fork input is not a regular file"));
        }
        fs::create_dir_all(guard.destination.join("pasted"))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .context("create fork input copy")?;
        std::io::copy(&mut input, &mut output).context("copy fork input")?;
        output.sync_all()?;
    }
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(blocks: Value) -> MessageRecord {
        MessageRecord {
            id: "message".into(),
            role: "user".into(),
            tool_name: None,
            is_error: false,
            blocks,
            meta: None,
            created_at: "2026-09-21T00:00:00Z".into(),
        }
    }

    #[test]
    fn copies_structured_and_compacted_inputs_and_rolls_back_until_committed() {
        let dir = tempfile::tempdir().unwrap();
        let pasted = dir.path().join("scratch/source/pasted");
        fs::create_dir_all(&pasted).unwrap();
        let file = pasted.join("input.txt");
        fs::write(&file, "bytes").unwrap();
        let canonical = file.canonicalize().unwrap();
        let mut records = vec![message(json!([{"type":"attachment", "ref": file}]))];
        let mut compactions: Vec<CompactionRecord> = vec![serde_json::from_value(json!({
            "id":"checkpoint", "summary":format!("Read @\"{}\"", canonical.display()),
            "throughMessageId":"message", "tokensBefore":10, "createdAt":"now",
            "retainedTail":[{"blocks":[{"ref": file}]}], "details":{"file": file}
        }))
        .unwrap()];
        let guard = preserve(
            dir.path(),
            "source",
            "child",
            &mut records,
            &mut compactions,
        )
        .unwrap();
        let target = dir
            .path()
            .join("scratch")
            .join("child")
            .join("pasted")
            .join("input.txt");
        assert_eq!(fs::read_to_string(&target).unwrap(), "bytes");
        assert_eq!(
            records[0].blocks[0]["ref"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(
            compactions[0].summary,
            format!("Read @\"{}\"", target.display())
        );
        assert_eq!(
            compactions[0].retained_tail.as_ref().unwrap()[0]["blocks"][0]["ref"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(
            compactions[0].details.as_ref().unwrap()["file"],
            target.to_string_lossy().as_ref()
        );
        drop(guard);
        assert!(!dir.path().join("scratch/child").exists());
        assert_eq!(fs::read_to_string(file).unwrap(), "bytes");
    }

    #[cfg(windows)]
    #[test]
    fn copies_windows_references_with_native_forward_and_mixed_separators() {
        let dir = tempfile::tempdir().unwrap();
        let pasted = scratch::session_dir(dir.path(), "source")
            .unwrap()
            .join("pasted");
        fs::create_dir_all(&pasted).unwrap();
        let file = pasted.join("first note.txt");
        fs::write(&file, "owned bytes").unwrap();
        let target = scratch::session_dir(dir.path(), "child")
            .unwrap()
            .join("pasted")
            .join("first note.txt");
        let native = file.to_string_lossy().into_owned();
        let canonical = file.canonicalize().unwrap().to_string_lossy().into_owned();
        let target_native = target.to_string_lossy().into_owned();
        let target_forward = target_native.replace('\\', "/");
        let variants = [
            (native.clone(), target_native.clone()),
            (native.replace('\\', "/"), target_forward.clone()),
            (
                format!(
                    "{}/scratch/source\\pasted/first note.txt",
                    dir.path().display()
                ),
                target_native.clone(),
            ),
            (canonical.clone(), target_native),
            (canonical.replace('\\', "/"), target_forward),
        ];
        let mut records: Vec<_> = variants
            .iter()
            .map(|(reference, _)| {
                let mut record = message(json!({
                    "ref": reference,
                    "text": format!("π Read @\"{reference}\" twice @{reference}"),
                    "suffix": format!("{reference}.bak"),
                    "prefix": format!("x{reference}"),
                    "unrelated": "C:\\keep\\this"
                }));
                record.meta = Some(json!({"path": reference}));
                record
            })
            .collect();
        preserve(dir.path(), "source", "child", &mut records, &mut [])
            .unwrap()
            .commit();
        assert_eq!(fs::read_to_string(&target).unwrap(), "owned bytes");
        for (record, (reference, expected)) in records.iter().zip(&variants) {
            assert_eq!(record.blocks["ref"], expected.as_str());
            assert_eq!(
                record.blocks["text"],
                format!("π Read @\"{expected}\" twice @{expected}")
            );
            assert_eq!(record.meta.as_ref().unwrap()["path"], expected.as_str());
            assert_eq!(record.blocks["suffix"], format!("{reference}.bak"));
            assert_eq!(record.blocks["prefix"], format!("x{reference}"));
            assert_eq!(record.blocks["unrelated"], "C:\\keep\\this");
        }
        assert_eq!(fs::read_to_string(file).unwrap(), "owned bytes");
    }

    #[cfg(not(windows))]
    #[test]
    fn backslashes_are_not_path_separators_on_unix() {
        let mut text = "Read /scratch/source/pasted/note\\name.txt".to_string();
        let original = text.clone();
        assert!(!replace_reference(
            &mut text,
            "/scratch/source/pasted/note/name.txt",
            "/scratch/child/pasted/note/name.txt"
        ));
        assert_eq!(text, original);
    }

    #[test]
    fn expired_inputs_do_not_prevent_forking() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("scratch/source/pasted/missing.txt");
        let mut records = vec![message(json!([{"ref":missing}]))];
        preserve(dir.path(), "source", "child", &mut records, &mut [])
            .unwrap()
            .commit();
        assert_eq!(
            records[0].blocks[0]["ref"],
            missing.to_string_lossy().as_ref()
        );
        assert!(!dir.path().join("scratch/child").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_referenced_symlinks_and_symlinked_input_directories() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let pasted = dir.path().join("scratch/source/pasted");
        fs::create_dir_all(&pasted).unwrap();
        let external = dir.path().join("private.txt");
        fs::write(&external, "private").unwrap();
        let link = pasted.join("link.txt");
        symlink(&external, &link).unwrap();
        let mut records = vec![message(json!([{"ref":link}]))];
        assert!(preserve(dir.path(), "source", "child", &mut records, &mut []).is_err());
        assert!(!dir.path().join("scratch/child").exists());
        fs::remove_file(link).unwrap();
        fs::remove_dir(&pasted).unwrap();
        symlink(dir.path(), &pasted).unwrap();
        assert!(preserve(dir.path(), "source", "child", &mut [], &mut []).is_err());
    }

    #[test]
    fn rewrites_nested_paths_without_matching_file_name_prefixes() {
        let mut value = json!({"blocks": [
            {"path": "/scratch/source/pasted/note.txt"},
            {"text": "Read @\"/scratch/source/pasted/note.txt\" twice /scratch/source/pasted/note.txt"},
            {"text": "/scratch/source/pasted/note.txt.bak"}
        ]});
        assert!(rewrite_value(
            &mut value,
            "/scratch/source/pasted/note.txt",
            "/child/note.txt"
        ));
        assert_eq!(value["blocks"][0]["path"], "/child/note.txt");
        assert_eq!(
            value["blocks"][1]["text"],
            "Read @\"/child/note.txt\" twice /child/note.txt"
        );
        assert_eq!(
            value["blocks"][2]["text"],
            "/scratch/source/pasted/note.txt.bak"
        );
    }
}
