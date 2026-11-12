use super::super::resources;
use super::super::tests::{initial, setup};
use super::super::{append, interrupt, load, Append};
use super::*;

fn request(session: &str, lease: &str) -> resources::CreateResource {
    serde_json::from_value(json!({"sessionId": session, "dockerExecutable": "/missing/docker", "commandId": "verify", "definitionHash": "a".repeat(64),
        "conductor": {"runId": "CON-2026-9001", "lease": lease, "dispatchId": "dispatch-one", "workerId": "worker-one", "stage": "headsman"}, "probeArgv": null})).unwrap()
}

#[test]
fn resource_creation_requires_acknowledged_live_dispatch_and_owner_before_os_access() {
    let (_root, db, session, path) = setup();
    let created = initial(&db, &session, &path);
    let lease = created["lease"].as_str().unwrap();
    assert!(resources::create(&db, request(&session, lease))
        .unwrap_err()
        .to_string()
        .contains("DISPATCH_NOT_FOUND"));
    assert!(resources::create(&db, request("wrong-owner", lease))
        .unwrap_err()
        .to_string()
        .contains("OWNER_MISMATCH"));
    assert!(resources::create(&db, request(&session, "stale"))
        .unwrap_err()
        .to_string()
        .contains("STALE_LEASE"));
    let event = Append {
        run_id: "CON-2026-9001".into(),
        session_id: session.clone(),
        lease: lease.into(),
        expected_version: 0,
        event_id: "dispatch-one".into(),
        event: json!({"runId":"CON-2026-9001", "type":"dispatch-start", "dispatchId":"dispatch-one", "workerId":"worker-one", "stage":"headsman", "input":{"admission":{"purpose":"analysis"}}}),
        checkpoint: None,
        status: None,
    };
    append(&db, event).unwrap();
    assert!(resources::create(&db, request(&session, lease))
        .unwrap_err()
        .to_string()
        .contains("QUALITY_NOT_AUTHORIZED"));
    assert!(issues(&db, "CON-2026-9001")
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn cleanup_failure_is_retained_and_restart_never_disables_history_or_replays() {
    let (root, db, session, path) = setup();
    initial(&db, &session, &path);
    let checkpoint = load(&db, &session, "CON-2026-9001").unwrap()["checkpoint"].clone();
    let item = Resource {
        schema: 1,
        id: uuid::Uuid::new_v4().to_string(),
        run_id: "CON-2026-9001".into(),
        session_id: session.clone(),
        runtime_id: "runtime-one".into(),
        dispatch_id: "dispatch".into(),
        worker_id: "worker".into(),
        stage: "headsman".into(),
        docker_executable: root
            .path()
            .join("missing-docker")
            .to_string_lossy()
            .into_owned(),
        cleanup_failed: false,
        creation_uncertain: false,
        probe: false,
    };
    let dir = directory(&db, &item.id, true).unwrap();
    fs::write(dir.join("foreign-file"), "must not be deleted").unwrap();
    save(&db, &item).unwrap();
    assert!(release(&db, "wrong-owner", &item.run_id, &item.id).is_err());
    assert!(!records(&db).unwrap()[0].cleanup_failed);
    assert_eq!(interrupt(&db, Some("other-runtime")).unwrap(), 0);
    assert!(!records(&db).unwrap()[0].cleanup_failed);
    assert!(interrupt(&db, Some("runtime-one")).is_err());
    assert_eq!(
        issues(&db, &item.run_id).unwrap().as_array().unwrap().len(),
        1
    );
    assert!(dir.join("foreign-file").is_file());
    drop(db);
    let db = Database::open_in_dir(root.path()).unwrap();
    let history = load(&db, &session, &item.run_id).unwrap();
    assert_eq!(history["run"]["status"], "interrupted");
    assert_eq!(history["checkpoint"], checkpoint);
    assert_eq!(
        history["resourceIssues"][0]["code"],
        "CONDUCTOR_CONTAINER_CLEANUP_FAILED"
    );
    assert!(dir.join("foreign-file").is_file());
}

#[test]
fn resource_paths_reject_nonidentifiers_and_absent_release_is_idempotent() {
    let (_root, db, session, path) = setup();
    initial(&db, &session, &path);
    assert!(directory(&db, "../foreign", true).is_err());
    assert_eq!(
        release(
            &db,
            &session,
            "CON-2026-9001",
            &uuid::Uuid::new_v4().to_string()
        )
        .unwrap()["released"],
        true
    );
}

#[test]
fn uncertain_creation_needs_confirmed_removal_not_mere_absence() {
    let name = "super-conductor-owned";
    assert!(validate_removal(
        false,
        false,
        name,
        "No such container: super-conductor-owned"
    )
    .is_ok());
    assert!(validate_removal(
        true,
        false,
        name,
        "No such container: super-conductor-owned"
    )
    .unwrap_err()
    .to_string()
    .contains("CREATION_UNCERTAIN"));
    assert!(validate_removal(true, true, name, "").is_ok());
    assert!(validate_removal(false, false, name, "daemon unavailable").is_err());
    assert!(validate_removal(false, false, name, "No such container: foreign").is_err());
}

#[test]
fn foreign_container_name_suffix_is_not_cleanup_evidence() {
    assert!(validate_removal(
        false,
        false,
        "super-conductor-owned",
        "No such container: super-conductor-owned-foreign"
    )
    .is_err());
}
