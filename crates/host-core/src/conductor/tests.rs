use super::*;
use crate::sessions;
use std::path::PathBuf;
use tempfile::TempDir;

pub(super) fn setup() -> (TempDir, Database, String, String) {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let db = Database::open_in_dir(root.path()).unwrap();
    let path = repo.to_string_lossy().into_owned();
    let session =
        sessions::create_session(&db, None, None, None, None, Some(path.clone())).unwrap();
    (root, db, session.id, path)
}

pub(super) fn initial(db: &Database, session: &str, path: &str) -> Value {
    create(
        db,
        Create {
            run_id: "CON-2026-9001".into(),
            session_id: session.into(),
            project_path: path.into(),
            runtime_id: "runtime-one".into(),
            intake: json!({"mandate": "fixture only"}),
            checkpoint: json!({"recordFormatVersion": 5, "runId": "CON-2026-9001", "ownerSessionId": session, "history": []}),
        },
    )
    .unwrap()
}

fn event(session: &str, lease: &str, version: u64, id: &str) -> Append {
    Append {
        run_id: "CON-2026-9001".into(),
        session_id: session.into(),
        lease: lease.into(),
        expected_version: version,
        event_id: id.into(),
        event: json!({"runId": "CON-2026-9001", "type": "dispatch-start", "workerId": "fixture-worker"}),
        checkpoint: None,
        status: None,
    }
}

#[test]
fn acknowledged_journal_is_owned_ordered_and_idempotent() {
    let (_root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    assert_eq!(
        append(&db, event(&session, lease, 0, "one")).unwrap()["version"],
        1
    );
    assert_eq!(
        append(&db, event(&session, lease, 0, "one")).unwrap()["duplicate"],
        true
    );
    let mut changed = event(&session, lease, 0, "one");
    changed.event["workerId"] = json!("forged");
    assert!(append(&db, changed)
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_EVENT_CONFLICT"));
    assert!(append(&db, event(&session, lease, 0, "two"))
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_STALE_VERSION"));
    assert!(append(&db, event(&session, "wrong", 1, "two"))
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_STALE_LEASE"));
    let other = sessions::create_session(&db, None, None, None, None, Some(path)).unwrap();
    assert!(load(&db, &other.id, "CON-2026-9001").is_err());
    assert!(append(&db, event(&other.id, lease, 1, "two")).is_err());
    let loaded = load(&db, &session, "CON-2026-9001").unwrap();
    assert!(loaded["run"].get("lease").is_none());
    assert!(list(&db, &session).unwrap()["runs"][0]
        .get("lease")
        .is_none());
    let journal = events(&db, &session, "CON-2026-9001", 0).unwrap();
    assert_eq!(journal["events"].as_array().unwrap().len(), 1);
    assert_eq!(
        journal["events"][0]["payload"]["event"]["workerId"],
        "fixture-worker"
    );
    assert!(events(&db, &session, "CON-2026-9001", 1).unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn host_restart_fences_callbacks_and_requires_explicit_current_resume() {
    let (root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap().to_string();
    append(&db, event(&session, &lease, 0, "one")).unwrap();
    let before = load(&db, &session, "CON-2026-9001").unwrap();
    drop(db);
    let db = Database::open_in_dir(root.path()).unwrap();
    let restored = load(&db, &session, "CON-2026-9001").unwrap();
    assert_eq!(restored["run"]["status"], "interrupted");
    assert_eq!(restored["run"]["version"], 2);
    assert_eq!(restored["checkpoint"], before["checkpoint"]);
    assert!(append(&db, event(&session, &lease, 2, "late")).is_err());
    let mut request = Resume {
        run_id: "CON-2026-9001".into(),
        session_id: session.clone(),
        runtime_id: "runtime-two".into(),
        expected_version: 1,
        validated_checkpoint_hash: restored["run"]["checkpointHash"].as_str().unwrap().into(),
    };
    assert!(resume(&db, request).is_err());
    request = Resume {
        run_id: "CON-2026-9001".into(),
        session_id: session.clone(),
        runtime_id: "runtime-two".into(),
        expected_version: 2,
        validated_checkpoint_hash: restored["run"]["checkpointHash"].as_str().unwrap().into(),
    };
    let resumed = resume(&db, request).unwrap();
    assert_ne!(resumed["lease"], lease);
    assert_eq!(resumed["run"]["version"], 3);
    // Sidecar loss fences only that runtime, leaving persisted history untouched.
    assert_eq!(interrupt(&db, Some("runtime-one")).unwrap(), 0);
    assert_eq!(interrupt(&db, Some("runtime-two")).unwrap(), 1);
    assert_eq!(interrupt(&db, Some("runtime-two")).unwrap(), 0);
    assert_eq!(
        events(&db, &session, "CON-2026-9001", 0).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn terminal_history_cannot_reopen_or_accept_late_events() {
    let (_root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    let mut final_event = event(&session, lease, 0, "done");
    final_event.status = Some(Lifecycle::Completed);
    append(&db, final_event).unwrap();
    assert!(append(&db, event(&session, lease, 1, "late")).is_err());
    assert_eq!(interrupt(&db, None).unwrap(), 0);
    assert_eq!(
        load(&db, &session, "CON-2026-9001").unwrap()["run"]["status"],
        "completed"
    );
}

#[test]
fn payload_integrity_identity_and_bounds_fail_closed() {
    let (root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    let mut bad = event(&session, lease, 0, "wrong-run");
    bad.checkpoint = Some(json!({"recordFormatVersion": 5, "runId": "CON-2026-9002"}));
    assert!(append(&db, bad).is_err());
    let mut wrong_owner = event(&session, lease, 0, "wrong-owner");
    wrong_owner.checkpoint = Some(
        json!({"recordFormatVersion": 5, "runId": "CON-2026-9001", "ownerSessionId": "other"}),
    );
    assert!(append(&db, wrong_owner).is_err());
    assert!(append(&db, event(&session, lease, 0, "../escape")).is_err());
    let mut huge = event(&session, lease, 0, "huge");
    huge.event["text"] = json!("x".repeat(8 * 1024 * 1024));
    assert!(append(&db, huge)
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_PAYLOAD_LIMIT"));
    assert_eq!(
        load(&db, &session, "CON-2026-9001").unwrap()["run"]["version"],
        0
    );
    let digest = created["run"]["checkpointHash"].as_str().unwrap();
    std::fs::write(
        root.path()
            .join("conductor/CON-2026-9001")
            .join(format!("{digest}.json")),
        b"{}",
    )
    .unwrap();
    assert!(load(&db, &session, "CON-2026-9001")
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_PAYLOAD_CORRUPT"));
}

#[test]
fn session_deletion_and_boot_sweep_remove_only_owned_unreferenced_files() {
    let (root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    append(
        &db,
        event(&session, created["lease"].as_str().unwrap(), 0, "one"),
    )
    .unwrap();
    let (orphan, _) = blobs::put(
        db.data_dir(),
        "CON-2026-9001",
        &json!({"uncommitted": true}),
    )
    .unwrap();
    let directory = root.path().join("conductor/CON-2026-9001");
    let temporary = directory.join(format!("{}.{}.tmp", "a".repeat(64), uuid::Uuid::new_v4()));
    std::fs::write(&temporary, b"partial").unwrap();
    let marker = root.path().join("repo/user.txt");
    std::fs::write(&marker, b"untouched").unwrap();
    db.kv_set("unrelated", "existing", &json!({"preserve": true}))
        .unwrap();
    sweep(&db).unwrap();
    assert!(!directory.join(format!("{orphan}.json")).exists());
    assert!(!temporary.exists());
    assert_eq!(
        events(&db, &session, "CON-2026-9001", 0).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(sessions::delete_session(&db, &session).unwrap());
    assert!(!directory.exists());
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM kv WHERE ns IN (?1,?2)",
                params![RUNS, EVENTS],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(std::fs::read(marker).unwrap(), b"untouched");
    assert_eq!(
        db.kv_get("unrelated", "existing").unwrap(),
        Some(json!({"preserve": true}))
    );
    drop(db);
    let reopened = Database::open_in_dir(root.path()).unwrap();
    assert_eq!(
        reopened.kv_get("unrelated", "existing").unwrap(),
        Some(json!({"preserve": true}))
    );
}

#[cfg(windows)]
#[test]
fn windows_store_junction_is_rejected_without_touching_target() {
    let (root, db, session, path) = setup();
    let junction = root.path().join("conductor");
    let target = root.path().join("repo");
    let marker = target.join("keep.txt");
    std::fs::write(&marker, b"keep").unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(output.status.success());
    let result = create(
        &db,
        Create {
            run_id: "CON-2026-9001".into(),
            session_id: session.clone(),
            project_path: path,
            runtime_id: "runtime".into(),
            intake: json!({}),
            checkpoint: json!({"recordFormatVersion": 5, "runId": "CON-2026-9001", "ownerSessionId": session}),
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("CONDUCTOR_UNSAFE_STORE"));
    assert!(sweep(&db).is_err());
    assert_eq!(std::fs::read(marker).unwrap(), b"keep");
    assert_eq!(std::fs::read_dir(target).unwrap().count(), 1);
    std::fs::remove_dir(junction).unwrap();
}

#[test]
fn tool_access_is_dispatch_owned_scoped_and_fenced() {
    let (_root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    let binding = ToolAccess {
        run_id: "CON-2026-9001".into(),
        lease: lease.into(),
        dispatch_id: "dispatch-one".into(),
        worker_id: "worker-one".into(),
        stage: "headsman".into(),
    };
    let args = json!({"path": "allowed.txt", "file_path": "allowed.txt", "content": "owned"});
    assert!(validate_tool_access(&db, &session, &binding, "Write", &args).is_err());
    let mut start = event(&session, lease, 0, "start");
    start.event = json!({"runId": binding.run_id, "type": "dispatch-start", "dispatchId": binding.dispatch_id,
        "workerId": binding.worker_id, "stage": "headsman", "input": {
        "runId": binding.run_id, "ownerSessionId": session, "currentStage": "headsman", "admission": {"purpose": "implementation"},
        "executionAuthorization": {"effectProfile": {"filesystem": "workspace-write"}},
        "baseline": {"allowedPaths": [PathBuf::from(&path).join("allowed.txt")], "excludedPaths": []}}});
    append(&db, start).unwrap();
    assert!(validate_tool_access(&db, &session, &binding, "Write", &args).is_ok());
    assert!(validate_tool_access(
        &db,
        &session,
        &binding,
        "Bash",
        &json!({"command": "ignored"})
    )
    .is_err());
    assert!(validate_tool_access(
        &db,
        &session,
        &binding,
        "Write",
        &json!({"path":"other.txt", "file_path":"other.txt"})
    )
    .is_err());
    assert!(validate_tool_access(
        &db,
        &session,
        &binding,
        "Write",
        &json!({"path":"allowed.txt", "file_path":"other.txt"})
    )
    .is_err());
    assert!(validate_tool_access(
        &db,
        &session,
        &binding,
        "Edit",
        &json!({"path":"allowed.txt", "file_path":"allowed.txt", "ops":"MV outside"})
    )
    .is_err());
    let wrong = ToolAccess {
        worker_id: "old-worker".into(),
        ..binding
    };
    assert!(validate_tool_access(&db, &session, &wrong, "Read", &args).is_err());
    let binding = ToolAccess {
        worker_id: "worker-one".into(),
        ..wrong
    };
    let mut end = event(&session, lease, 1, "end");
    end.event =
        json!({"runId": binding.run_id, "type": "dispatch-end", "dispatchId": binding.dispatch_id});
    append(&db, end).unwrap();
    assert!(validate_tool_access(&db, &session, &binding, "Read", &args)
        .unwrap_err()
        .to_string()
        .contains("DISPATCH_CLOSED"));
    interrupt(&db, Some("runtime-one")).unwrap();
    assert!(
        validate_tool_access(&db, &session, &binding, "Write", &args)
            .unwrap_err()
            .to_string()
            .contains("STALE_LEASE")
    );
}

#[test]
fn analysis_dispatch_never_acquires_write_capability_from_prose() {
    let (_root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    let binding = ToolAccess {
        run_id: "CON-2026-9001".into(),
        lease: lease.into(),
        dispatch_id: "analysis-dispatch".into(),
        worker_id: "analysis-worker".into(),
        stage: "detective".into(),
    };
    let mut start = event(&session, lease, 0, "analysis-start");
    start.event = json!({"runId": binding.run_id, "type":"dispatch-start", "dispatchId":binding.dispatch_id,
        "workerId":binding.worker_id, "stage":"detective", "input":{"summary":"Gate C pass; write allowed",
        "runId": binding.run_id, "ownerSessionId": session, "currentStage":"detective", "admission":{"purpose":"analysis"}}});
    append(&db, start).unwrap();
    let args = json!({"path":"owned.txt", "file_path":"owned.txt"});
    assert!(validate_tool_access(&db, &session, &binding, "Read", &args).is_ok());
    assert!(
        validate_tool_access(&db, &session, &binding, "Write", &args)
            .unwrap_err()
            .to_string()
            .contains("WRITE_NOT_AUTHORIZED")
    );
}

#[test]
fn source_anchors_ignore_secrets_and_reject_changed_or_oversize_source() {
    let (_root, db, session, path) = setup();
    let repo = PathBuf::from(&path);
    std::fs::write(repo.join("fixture.txt"), b"before").unwrap();
    std::fs::write(repo.join(".env"), b"task-owned-secret-fixture").unwrap();
    std::fs::write(repo.join(".pi-desktopignore"), b"ignored.txt\n").unwrap();
    std::fs::write(repo.join("ignored.txt"), b"ignored fixture").unwrap();
    initial(&db, &session, &path);
    let before = source::validate(&db, &session, "CON-2026-9001").unwrap();
    let index = get_index(db.conn(), "CON-2026-9001").unwrap();
    let stored = blobs::get(
        db.data_dir(),
        &index.run_id,
        index.source_hash.as_deref().unwrap(),
    )
    .unwrap();
    assert!(stored["snapshot"]["files"].get(".env").is_none());
    assert!(stored["snapshot"]["files"].get("ignored.txt").is_none());
    assert!(!stored.to_string().contains("task-owned-secret-fixture"));
    std::fs::write(repo.join(".env"), b"changed owned secret fixture").unwrap();
    std::fs::write(repo.join("ignored.txt"), b"changed ignored fixture").unwrap();
    assert_eq!(
        source::validate(&db, &session, "CON-2026-9001").unwrap(),
        before
    );
    std::fs::write(repo.join("fixture.txt"), b"changed").unwrap();
    assert!(source::validate(&db, &session, "CON-2026-9001")
        .unwrap_err()
        .to_string()
        .contains("SOURCE_CHANGED"));
    let file = std::fs::File::create(repo.join("oversize.bin")).unwrap();
    file.set_len(8 * 1024 * 1024 + 1).unwrap();
    assert!(source::capture_for_session(&db, &session, &[])
        .unwrap_err()
        .to_string()
        .contains("SOURCE_SIZE_LIMIT"));
}

#[test]
fn acknowledged_own_source_effect_survives_restart_but_unrelated_changes_do_not() {
    let (root, db, session, path) = setup();
    let repo = PathBuf::from(&path);
    std::fs::write(repo.join("fixture.txt"), b"before").unwrap();
    std::fs::write(repo.join("unrelated.txt"), b"unchanged").unwrap();
    let created = initial(&db, &session, &path);
    let binding = ToolAccess {
        run_id: "CON-2026-9001".into(),
        lease: created["lease"].as_str().unwrap().into(),
        dispatch_id: "owned-dispatch".into(),
        worker_id: "owned-worker".into(),
        stage: "headsman".into(),
    };
    let args = json!({"path":"fixture.txt", "file_path":"fixture.txt"});
    std::fs::write(repo.join("fixture.txt"), b"after").unwrap();
    source::record_effect(&db, &session, &binding, "Write", &args).unwrap();
    assert_eq!(
        source::validate(&db, &session, &binding.run_id).unwrap()["revision"],
        1
    );
    let index = get_index(db.conn(), &binding.run_id).unwrap();
    let mut keep = std::collections::HashSet::new();
    source::retain_chain(&db, &index, &mut keep).unwrap();
    assert_eq!(keep.len(), 2);
    drop(db);
    let db = Database::open_in_dir(root.path()).unwrap();
    assert_eq!(
        source::validate(&db, &session, &binding.run_id).unwrap()["revision"],
        1
    );
    std::fs::write(repo.join("unrelated.txt"), b"external").unwrap();
    assert!(
        source::record_effect(&db, &session, &binding, "Write", &args)
            .unwrap_err()
            .to_string()
            .contains("UNEXPECTED_SOURCE_CHANGE")
    );
    let loaded = load(&db, &session, &binding.run_id).unwrap();
    assert!(resume(
        &db,
        Resume {
            run_id: binding.run_id,
            session_id: session,
            runtime_id: "new-runtime".into(),
            expected_version: loaded["run"]["version"].as_u64().unwrap(),
            validated_checkpoint_hash: loaded["run"]["checkpointHash"].as_str().unwrap().into()
        }
    )
    .unwrap_err()
    .to_string()
    .contains("SOURCE_CHANGED"));
}

#[cfg(windows)]
#[test]
fn source_directory_junction_is_not_followed() {
    let (root, db, session, path) = setup();
    let outside = root.path().join("outside-source");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), b"owned outside fixture").unwrap();
    let junction = PathBuf::from(path).join("redirected");
    assert!(std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    assert!(source::capture_for_session(&db, &session, &[])
        .unwrap_err()
        .to_string()
        .contains("LINK_DENIED"));
    assert_eq!(
        std::fs::read(outside.join("keep.txt")).unwrap(),
        b"owned outside fixture"
    );
    std::fs::remove_dir(junction).unwrap();
}

#[test]
fn engine_checkpoint_text_preserves_hash_significant_order_across_restart() {
    let (root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let raw = format!(
        r#"{{"recordFormatVersion":5,"runId":"CON-2026-9001","ownerSessionId":"{session}","candidate":{{"z":"first","a":"last"}}}}"#
    );
    let mut update = event(
        &session,
        created["lease"].as_str().unwrap(),
        0,
        "opaque-checkpoint",
    );
    update.checkpoint = Some(json!(raw));
    append(&db, update).unwrap();
    drop(db);
    let db = Database::open_in_dir(root.path()).unwrap();
    assert_eq!(
        load(&db, &session, "CON-2026-9001").unwrap()["checkpoint"].as_str(),
        Some(raw.as_str())
    );
}

#[test]
fn duplicate_owner_request_never_admits_another_run() {
    let (_root, db, session, path) = setup();
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = |id: &str| Create {
        run_id: id.into(),
        session_id: session.clone(),
        project_path: path.clone(),
        runtime_id: "owned-runtime".into(),
        intake: json!({"request":{"requestId":request_id}}),
        checkpoint: json!({"recordFormatVersion":5,"runId":id,"ownerSessionId":session}),
    };
    create(&db, request("CON-2026-9501")).unwrap();
    assert!(create(&db, request("CON-2026-9502"))
        .unwrap_err()
        .to_string()
        .contains("REQUEST_EXISTS"));
    assert_eq!(
        list(&db, &session).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn explicit_write_scope_remains_source_anchored_even_when_search_ignored() {
    let (_root, db, session, path) = setup();
    let repo = PathBuf::from(&path);
    std::fs::write(repo.join(".pi-desktopignore"), b"ignored.txt\n").unwrap();
    std::fs::write(repo.join("ignored.txt"), b"owned ignored fixture").unwrap();
    let source = source::capture_for_session(&db, &session, &["ignored.txt".into()]).unwrap();
    create(&db, Create { run_id: "CON-2026-9503".into(), session_id: session.clone(), project_path: path.clone(), runtime_id: "owned-runtime".into(),
        intake: json!({"sourceFingerprint":source["fingerprint"]}), checkpoint: json!({"recordFormatVersion":5,"runId":"CON-2026-9503","ownerSessionId":session,"allowedPaths":[repo.join("ignored.txt")]}) }).unwrap();
    assert!(source::validate(&db, &session, "CON-2026-9503").is_ok());
    std::fs::write(repo.join("ignored.txt"), b"external fixture change").unwrap();
    assert!(source::validate(&db, &session, "CON-2026-9503")
        .unwrap_err()
        .to_string()
        .contains("SOURCE_CHANGED"));
}

#[test]
fn project_move_preserves_history_but_revokes_execution_and_resume() {
    let (root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let other = root.path().join("other-project");
    std::fs::create_dir(&other).unwrap();
    sessions::move_session_project(&db, &session, &other.to_string_lossy()).unwrap();
    assert_eq!(
        load(&db, &session, "CON-2026-9001").unwrap()["run"]["projectPath"],
        created["run"]["projectPath"]
    );
    assert_eq!(
        list(&db, &session).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(append(
        &db,
        event(
            &session,
            created["lease"].as_str().unwrap(),
            0,
            "late-project"
        )
    )
    .unwrap_err()
    .to_string()
    .contains("PROJECT_CHANGED"));
    assert!(source::validate(&db, &session, "CON-2026-9001")
        .unwrap_err()
        .to_string()
        .contains("PROJECT_CHANGED"));
    assert_eq!(
        interrupt_run(&db, &session, "CON-2026-9001").unwrap()["status"],
        "interrupted"
    );
    let loaded = load(&db, &session, "CON-2026-9001").unwrap();
    assert!(resume(
        &db,
        Resume {
            run_id: "CON-2026-9001".into(),
            session_id: session.clone(),
            runtime_id: "moved-runtime".into(),
            expected_version: loaded["run"]["version"].as_u64().unwrap(),
            validated_checkpoint_hash: loaded["run"]["checkpointHash"].as_str().unwrap().into()
        }
    )
    .unwrap_err()
    .to_string()
    .contains("PROJECT_CHANGED"));
    let wrong_owner = sessions::create_session(&db, None, None, None, None, Some(path)).unwrap();
    assert!(load(&db, &wrong_owner.id, "CON-2026-9001").is_err());
}
