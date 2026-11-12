//! Durable ownership of confined Docker containers. This never evaluates gates.
//! Creation holds the host lock: fencing cannot precede a late container create.
use super::{blobs, get_index, tool_access::validate_dispatch, ToolAccess};
use crate::db::{now_ms, Database};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RESOURCES: &str = "conductor.resources.v1";
const POLICY: &str = include_str!("../../../../packages/conductor-runtime/assets/seccomp.json");
#[cfg(windows)]
const DOCKER_HOST: &str = "npipe:////./pipe/dockerDesktopLinuxEngine";
#[cfg(not(windows))]
const DOCKER_HOST: &str = "unix:///var/run/docker.sock";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateResource {
    pub session_id: String,
    pub conductor: ToolAccess,
    pub docker_executable: String,
    pub command_id: String,
    pub definition_hash: String,
    pub probe_argv: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    schema: u8,
    id: String,
    run_id: String,
    session_id: String,
    runtime_id: String,
    dispatch_id: String,
    worker_id: String,
    stage: String,
    docker_executable: String,
    cleanup_failed: bool,
    creation_uncertain: bool,
    #[serde(default)]
    probe: bool,
}

fn safe_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            meta.file_attributes() & 0x400 == 0,
            "CONDUCTOR_RESOURCE_PATH_UNSAFE"
        );
    }
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "CONDUCTOR_RESOURCE_PATH_UNSAFE"
    );
    Ok(())
}

fn directory(db: &Database, id: &str, create: bool) -> Result<PathBuf> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "CONDUCTOR_RESOURCE_ID_INVALID"
    );
    let root = db.data_dir().canonicalize()?;
    let mut dir = root.clone();
    for part in ["conductor-resources", id] {
        dir.push(part);
        if create && !dir.try_exists()? {
            fs::create_dir(&dir)?;
        }
        safe_directory(&dir)?;
        ensure!(
            dir.canonicalize()?.starts_with(&root),
            "CONDUCTOR_RESOURCE_PATH_UNSAFE"
        );
    }
    Ok(dir)
}

fn save(db: &Database, item: &Resource) -> Result<()> {
    db.conn().execute("INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(ns,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![RESOURCES, item.id, serde_json::to_string(item)?, now_ms()])?;
    Ok(())
}

fn records(db: &Database) -> Result<Vec<Resource>> {
    let mut stmt = db.conn().prepare("SELECT value_json FROM kv WHERE ns=?1")?;
    let rows = stmt.query_map([RESOURCES], |r| r.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        let item: Resource = serde_json::from_str(&row?)?;
        ensure!(
            item.schema == 1 && uuid::Uuid::parse_str(&item.id).is_ok(),
            "CONDUCTOR_RESOURCE_INCOMPATIBLE"
        );
        items.push(item);
    }
    Ok(items)
}

fn docker_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        value
            .strip_prefix("\\\\?\\")
            .unwrap_or(&value)
            .replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

/// Only fixed Docker argv; isolated environment and bounded retained stderr.
fn docker(item: &Resource, dir: &Path, args: &[String]) -> Result<(bool, String)> {
    let error_path = dir.join("docker-error");
    if error_path.try_exists()? {
        let meta = fs::symlink_metadata(&error_path)?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "CONDUCTOR_RESOURCE_PATH_UNSAFE"
        );
        fs::remove_file(&error_path)?;
    }
    let error = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&error_path)?;
    let mut command = Command::new(&item.docker_executable);
    command
        .env_clear()
        .args(["--config", &docker_path(dir), "--host", DOCKER_HOST])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(error);
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().context("CONDUCTOR_DOCKER_UNAVAILABLE")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            anyhow::bail!("CONDUCTOR_RESOURCE_COMMAND_TIMEOUT");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut bytes = Vec::new();
    fs::File::open(error_path)?
        .take(4096)
        .read_to_end(&mut bytes)?;
    Ok((
        status.success(),
        String::from_utf8_lossy(&bytes).into_owned(),
    ))
}

fn name(item: &Resource) -> String {
    format!("super-conductor-{}", item.id)
}

pub fn create(db: &Database, request: CreateResource) -> Result<Value> {
    let start = validate_dispatch(db, &request.session_id, &request.conductor)?;
    let binding = &request.conductor;
    let input = &start["input"];
    ensure!(
        matches!(binding.stage.as_str(), "headsman" | "auditor")
            && input["runId"].as_str() == Some(&binding.run_id)
            && input["ownerSessionId"].as_str() == Some(&request.session_id)
            && input["currentStage"].as_str() == Some(&binding.stage)
            && input["admission"]["purpose"] == "implementation"
            && input["executionAuthorization"]["effectProfile"]["filesystem"] == "workspace-write"
            && input["executionAuthorization"]["executionBaselineHash"].is_string(),
        "CONDUCTOR_QUALITY_NOT_AUTHORIZED"
    );
    let gate = if binding.stage == "headsman" {
        "D"
    } else {
        "E"
    };
    ensure!(
        start["requiredQualityCommands"]
            .as_array()
            .is_some_and(
                |commands| commands.iter().any(|item| item["id"] == request.command_id
                    && item["definitionHash"] == request.definition_hash
                    && item["requiredGates"]
                        .as_array()
                        .is_some_and(|gates| gates.iter().any(|g| g == gate)))
            ),
        "CONDUCTOR_COMMAND_BINDING_INVALID"
    );
    let index = get_index(db.conn(), &binding.run_id)?;
    let probe_mount = request.probe_argv.is_some();
    let intake = blobs::get(db.data_dir(), &binding.run_id, &index.intake_hash)?;
    let definition = intake["request"]["qualityCommands"]
        .as_array()
        .and_then(|commands| {
            commands
                .iter()
                .find(|item| item["id"] == request.command_id)
        })
        .context("CONDUCTOR_COMMAND_UNKNOWN")?;
    let image = definition["image"]
        .as_str()
        .context("CONDUCTOR_COMMAND_INVALID")?;
    ensure!(
        image.len() == 71
            && image.starts_with("sha256:")
            && image[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "CONDUCTOR_COMMAND_INVALID"
    );
    let argv: Vec<String> = if let Some(probe) = request.probe_argv {
        ensure!(
            probe.len() == 3
                && probe[0] == "/usr/local/bin/node"
                && probe[1] == "-e"
                && probe[2].len() < 16384,
            "CONDUCTOR_PROBE_INVALID"
        );
        probe
    } else {
        serde_json::from_value(definition["argv"].clone())?
    };
    ensure!(
        !argv.is_empty()
            && argv.len() <= 64
            && argv[0].starts_with('/')
            && argv
                .iter()
                .all(|arg| arg.len() <= 16384 && !arg.contains('\0')),
        "CONDUCTOR_COMMAND_INVALID"
    );
    let executable = Path::new(&request.docker_executable);
    ensure!(
        executable.is_absolute()
            && executable.is_file()
            && executable.file_name().is_some_and(|name| matches!(
                name.to_string_lossy().to_ascii_lowercase().as_str(),
                "docker" | "docker.exe"
            )),
        "CONDUCTOR_DOCKER_UNAVAILABLE"
    );
    super::source::validate(db, &request.session_id, &binding.run_id)?;
    ensure!(records(db)?.len() < 64, "CONDUCTOR_RESOURCE_LIMIT");
    let mut item = Resource {
        schema: 1,
        id: uuid::Uuid::new_v4().to_string(),
        run_id: binding.run_id.clone(),
        session_id: request.session_id,
        runtime_id: index.runtime_id,
        dispatch_id: binding.dispatch_id.clone(),
        worker_id: binding.worker_id.clone(),
        stage: binding.stage.clone(),
        docker_executable: request.docker_executable,
        cleanup_failed: false,
        creation_uncertain: true,
        probe: probe_mount,
    };
    // Record before directories or Docker effects. Even an uncertain create is recoverable.
    save(db, &item)?;
    let result = (|| -> Result<Value> {
        let dir = directory(db, &item.id, true)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755))?;
        }
        let mut policy = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join("seccomp.json"))?;
        policy.write_all(POLICY.as_bytes())?;
        policy.sync_all()?;
        let source = if probe_mount {
            dir.clone()
        } else {
            PathBuf::from(&index.project_path).canonicalize()?
        };
        ensure!(
            !source.to_string_lossy().contains([',', '\r', '\n']),
            "CONDUCTOR_MOUNT_PATH_INVALID"
        );
        let mut args: Vec<String> = vec![
            "create".into(),
            "--pull".into(),
            "never".into(),
            "--name".into(),
            name(&item),
            "--network".into(),
            "none".into(),
            "--read-only".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges:true".into(),
            "--security-opt".into(),
            format!("seccomp={}", docker_path(&dir.join("seccomp.json"))),
            "--pids-limit".into(),
            "64".into(),
            "--memory".into(),
            "256m".into(),
            "--cpus".into(),
            "1".into(),
            "--user".into(),
            "65534:65534".into(),
            "--tmpfs".into(),
            "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777".into(),
            "--mount".into(),
            format!(
                "type=bind,src={},dst=/workspace,readonly",
                docker_path(&source)
            ),
            "--workdir".into(),
            "/workspace".into(),
            "--entrypoint".into(),
            argv[0].clone(),
            image.into(),
        ];
        args.extend(argv.iter().skip(1).cloned());
        let (success, stderr) = docker(&item, &dir, &args)?;
        item.creation_uncertain = false;
        save(db, &item)?;
        ensure!(success, "CONDUCTOR_CONTAINER_CREATE_FAILED: {stderr}");
        Ok(
            json!({"resourceId": item.id, "containerName": name(&item), "temporary": docker_path(&dir), "policySha256": blobs::hash(POLICY.as_bytes())}),
        )
    })();
    if result.is_err() {
        item.cleanup_failed = true;
        save(db, &item)?;
    }
    result
}

fn validate_removal(uncertain: bool, removed: bool, name: &str, stderr: &str) -> Result<()> {
    ensure!(
        removed
            || stderr.lines().any(|line| line
                .trim_end()
                .ends_with(&format!("No such container: {name}"))),
        "CONDUCTOR_CONTAINER_CLEANUP_FAILED"
    );
    // Successful removal confirms the single pending create took effect. Mere
    // absence cannot prove a timed-out daemon create will not finish later.
    ensure!(
        !uncertain || removed,
        "CONDUCTOR_RESOURCE_CREATION_UNCERTAIN"
    );
    Ok(())
}

fn cleanup(db: &Database, item: &Resource) -> Result<()> {
    let dir = directory(db, &item.id, true)?;
    let (success, stderr) = docker(item, &dir, &["rm".into(), "--force".into(), name(item)])?;
    validate_removal(item.creation_uncertain, success, &name(item), &stderr)?;
    for file in ["seccomp.json", "docker-error"] {
        let path = dir.join(file);
        if path.try_exists()? {
            let meta = fs::symlink_metadata(&path)?;
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "CONDUCTOR_RESOURCE_PATH_UNSAFE"
            );
            fs::remove_file(path)?;
        }
    }
    fs::remove_dir(dir)?;
    db.conn().execute(
        "DELETE FROM kv WHERE ns=?1 AND key=?2",
        params![RESOURCES, item.id],
    )?;
    Ok(())
}

pub fn release(db: &Database, session: &str, run: &str, id: &str) -> Result<Value> {
    let Some(item) = records(db)?.into_iter().find(|item| item.id == id) else {
        return Ok(json!({"released": true}));
    };
    ensure!(
        item.session_id == session && item.run_id == run,
        "CONDUCTOR_OWNER_MISMATCH"
    );
    cleanup_retained(db, item)?;
    Ok(json!({"released": true}))
}

fn cleanup_retained(db: &Database, mut item: Resource) -> Result<()> {
    if let Err(error) = cleanup(db, &item) {
        item.cleanup_failed = true;
        save(db, &item)?;
        return Err(error);
    }
    Ok(())
}

pub fn recover(db: &Database, runtime: Option<&str>, run: Option<&str>) -> Result<()> {
    let mut failed = false;
    for item in records(db)? {
        if runtime.is_none_or(|id| item.runtime_id == id) && run.is_none_or(|id| item.run_id == id)
        {
            failed |= cleanup_retained(db, item).is_err();
        }
    }
    ensure!(!failed, "CONDUCTOR_CONTAINER_CLEANUP_FAILED");
    Ok(())
}

pub fn issues(db: &Database, run: &str) -> Result<Value> {
    Ok(json!(records(db)?.into_iter().filter(|item| item.run_id == run && item.cleanup_failed)
        .map(|item| json!({"resourceId": item.id, "code": "CONDUCTOR_CONTAINER_CLEANUP_FAILED", "creationUncertain": item.creation_uncertain})).collect::<Vec<_>>()))
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;

pub fn snapshot(db: &Database, run: &str) -> Result<Value> {
    Ok(json!(records(db)?.into_iter().filter(|item| item.run_id == run)
        .map(|item| json!({"resourceId": item.id, "containerName": name(&item), "workerId": item.worker_id, "dispatchId": item.dispatch_id,
            "stage": item.stage, "probe": item.probe, "cleanupFailed": item.cleanup_failed, "creationUncertain": item.creation_uncertain})).collect::<Vec<_>>()))
}
