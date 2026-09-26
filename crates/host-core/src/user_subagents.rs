mod model_fallbacks;
#[cfg(test)]
mod tests;

use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, file_timestamp, global_agents_dir, parse_front_matter, slugify, sorted_files,
    CapabilityLevel, CapabilityState,
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MAX_USER_SUBAGENTS: usize = 64;
pub const MAX_SUBAGENT_BYTES: usize = 32 * 1024;
const MAX_NAME_CHARS: usize = 40;
const MAX_DESCRIPTION_CHARS: usize = 400;
/// Mirrors `MAX_SUBAGENT_MAX_TOKENS` in `packages/shared`. No published model
/// accepts an output limit above 128k, so a larger declared value is a typo.
const MAX_TOKENS_CEILING: u32 = 200_000;
const DEFAULT_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];
const ASSIGNABLE_TOOLS: [&str; 7] = [
    "Read",
    "Glob",
    "Grep",
    "BrowserPreview",
    "Bash",
    "Edit",
    "Write",
];
const THINKING_LEVELS: [&str; 8] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "omit",
];
const SUBAGENT_KIND: &str = "subagents";
const SUBAGENT_LIBRARY_KIND: &str = "subagent-library";
const SUBAGENT_LIBRARY_SOURCE: &str = "customagents";
const SUBAGENT_REGISTRY_SOURCE: &str = "registry";
const SUBAGENT_LIBRARY_PREFIX: &str = "customagents:";
const MAX_ACTIVE_USER_SUBAGENTS: usize = 16;
/// Activation state for the subagent builtins, kept in its own file
const BUILTIN_SUBAGENT_HANDLES: [&str; 4] = ["explorer", "code-reviewer", "test-runner", "fixer"];
/// (`<data-dir>/agent-capabilities/subagent-builtins.json`).
///
/// The builtins are constant documents inside agent-runtime, not files in
/// `~/.agents/subagents`, so the directory scan that `list()` performs can
/// never see their handles. That scan also `prune`s state for records it no
/// longer finds, which would delete every builtin entry as an orphan on the
/// first listing. A separate kind keeps the two catalogs apart, and because a
/// `Global` value is only ever stored for an explicit `false`, the state is
/// lazy and sticky: a handle that is off stays off even while it is absent, so
/// a builtin restored in a later release comes back still disabled.
const SUBAGENT_BUILTIN_KIND: &str = "subagent-builtins";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub description: String,
    pub enabled: bool,
    /** Registry documents are writable; CustomAgents library documents are read-only. */
    pub source: String,
    #[serde(default)]
    pub scope: ActivationScope,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub fallback_models: Option<Vec<String>>,
    pub thinking_level: Option<String>,
    pub max_tokens: Option<u32>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility; subagents are global-only now.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

pub struct UserSubagentRegistry {
    state: CapabilityState,
    library: CapabilityState,
    builtins: CapabilityState,
}

fn normalize_name(value: &str) -> String {
    slugify(value, MAX_NAME_CHARS)
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn normalize_tools(requested: Option<&Vec<String>>) -> Vec<String> {
    let requested = requested
        .filter(|tools| !tools.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            DEFAULT_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect()
        });
    let mut inherit = false;
    let mut result = Vec::new();
    for tool in &requested {
        let trimmed = tool.trim();
        if trimmed.eq_ignore_ascii_case("inherit") {
            inherit = true;
            continue;
        }
        if let Some(canonical) = ASSIGNABLE_TOOLS
            .iter()
            .find(|candidate| candidate.eq_ignore_ascii_case(trimmed))
        {
            if !result.iter().any(|value: &String| value == canonical) {
                result.push((*canonical).to_string());
            }
        }
    }
    if inherit {
        let mut tools = vec!["inherit".to_string()];
        tools.extend(result);
        tools
    } else {
        result
    }
}

fn normalize_thinking(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_lowercase();
    THINKING_LEVELS
        .iter()
        .find(|level| **level == candidate)
        .map(|level| (*level).to_string())
}

/// A definition pin, normalized, or an error when it is not a pin.
///
/// The stored shape is `provider/model`. Only the slash is structural: the
/// provider half is matched by a normalized alias in the runtime
/// (`findProvider`), and a custom endpoint's display name may contain spaces,
/// so those are valid here too. Rejecting a value the editor offers would leave
/// the user with a definition that saves but can never resolve.
fn normalize_model(value: Option<&str>) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some((provider, model)) = trimmed.split_once('/') else {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    };
    if provider.is_empty() || model.is_empty() {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    }
    Ok(Some(trimmed.to_string()))
}

fn parse_record_from_source(
    path: &Path,
    state: &CapabilityState,
    kind: &str,
    default_enabled: bool,
    source: &str,
) -> Option<UserSubagentRecord> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_SUBAGENT_BYTES {
        return None;
    }
    let (front, body) = parse_front_matter(&raw);
    if body.trim().is_empty() {
        return None;
    }
    let fallback = path.file_stem()?.to_str()?;
    let name = normalize_name(front.get("name").map(String::as_str).unwrap_or(fallback));
    let description = clip(front.get("description")?, MAX_DESCRIPTION_CHARS);
    if name.is_empty() || description.is_empty() {
        return None;
    }
    let id = if source == SUBAGENT_LIBRARY_SOURCE {
        format!("{SUBAGENT_LIBRARY_PREFIX}{name}")
    } else {
        name.clone()
    };
    let tools = front.get("tools").map(|value| {
        value
            .trim_matches(['[', ']'])
            .split(',')
            .map(|tool| tool.trim().to_string())
            .collect::<Vec<_>>()
    });
    let tools = normalize_tools(tools.as_ref());
    if tools.is_empty() {
        return None;
    }
    let enabled =
        state.enabled_with_default(kind, CapabilityLevel::Global, &id, None, default_enabled);
    let updated_at = file_timestamp(path);
    let max_tokens = front
        .get("maxtokens")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TOKENS_CEILING));
    Some(UserSubagentRecord {
        id,
        name,
        level: Some("global".into()),
        description,
        enabled,
        source: source.into(),
        scope: ActivationScope::default(),
        tools,
        model: front
            .get("model")
            .cloned()
            .filter(|value| !value.is_empty()),
        fallback_models: model_fallbacks::parse(&raw).ok()?,
        thinking_level: normalize_thinking(front.get("thinkinglevel").map(String::as_str)),
        max_tokens,
        path: path.to_string_lossy().to_string(),
        size_bytes: raw.len() as u64,
        created_at: updated_at.clone(),
        updated_at,
    })
}

#[cfg(test)]
fn parse_record(path: &Path, state: &CapabilityState) -> Option<UserSubagentRecord> {
    parse_record_from_source(path, state, SUBAGENT_KIND, true, SUBAGENT_REGISTRY_SOURCE)
}

fn scan_records(
    directory: &Path,
    state: &mut CapabilityState,
    kind: &str,
    default_enabled: bool,
    source: &str,
) -> Result<Vec<UserSubagentRecord>> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for path in sorted_files(directory, "md") {
        let Some(record) = parse_record_from_source(&path, state, kind, default_enabled, source)
        else {
            continue;
        };
        if seen.insert(record.id.clone()) {
            records.push(record);
        }
    }
    let ids = records.iter().map(|record| record.id.clone()).collect();
    state.prune(kind, CapabilityLevel::Global, None, &ids)?;
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

fn render_document(record: &UserSubagentRecord, body: &str) -> String {
    let mut output = String::from("---\n");
    output.push_str(&format!("name: {}\n", record.name));
    output.push_str(&format!(
        "description: {}\n",
        record.description.replace('\n', " ")
    ));
    if record.tools.len() == 1 && record.tools[0].eq_ignore_ascii_case("inherit") {
        output.push_str("tools: inherit\n");
    } else {
        output.push_str(&format!("tools: [{}]\n", record.tools.join(", ")));
    }
    if let Some(model) = &record.model {
        output.push_str(&format!("model: {model}\n"));
    }
    if !record.fallback_models.is_empty() {
        output.push_str(&format!(
            "fallbackModels: [{}]\n",
            record.fallback_models.join(", ")
        ));
    }
    if let Some(level) = &record.thinking_level {
        output.push_str(&format!("thinkingLevel: {level}\n"));
    }
    if let Some(max_tokens) = record.max_tokens {
        output.push_str(&format!("maxTokens: {max_tokens}\n"));
    }
    output.push_str("---\n\n");
    output.push_str(body.trim());
    output.push('\n');
    output
}

fn default_body(name: &str) -> String {
    format!("Do the work the task names and report only what the parent needs. Start with the first concrete step for `{name}`.\n")
}

impl UserSubagentRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SUBAGENT_KIND),
            library: CapabilityState::new(data_dir, SUBAGENT_LIBRARY_KIND),
            builtins: CapabilityState::new(data_dir, SUBAGENT_BUILTIN_KIND),
        }
    }

    fn scan_registry(&mut self) -> Result<Vec<UserSubagentRecord>> {
        let directory = capability_dir(CapabilityLevel::Global, None, "subagents")?;
        scan_records(
            &directory,
            &mut self.state,
            SUBAGENT_KIND,
            true,
            SUBAGENT_REGISTRY_SOURCE,
        )
    }

    fn scan_library(&mut self) -> Result<Vec<UserSubagentRecord>> {
        let directory = global_agents_dir()
            .join("subagent-library")
            .join("customagents");
        scan_records(
            &directory,
            &mut self.library,
            SUBAGENT_LIBRARY_KIND,
            false,
            SUBAGENT_LIBRARY_SOURCE,
        )
    }

    fn reconcile_active_selection(&mut self, records: &mut [UserSubagentRecord]) -> Result<()> {
        let mut handles = HashSet::new();
        let mut disable = Vec::new();
        for record in records.iter_mut().filter(|record| record.enabled) {
            if handles.len() < MAX_ACTIVE_USER_SUBAGENTS && handles.insert(record.name.clone()) {
                continue;
            }
            record.enabled = false;
            disable.push((record.source.clone(), record.id.clone()));
        }
        for (source, id) in disable {
            if source == SUBAGENT_LIBRARY_SOURCE {
                self.library.set_enabled_with_default(
                    SUBAGENT_LIBRARY_KIND,
                    CapabilityLevel::Global,
                    &id,
                    None,
                    false,
                    false,
                )?;
            } else {
                self.state
                    .set_enabled(SUBAGENT_KIND, CapabilityLevel::Global, &id, None, false)?;
            }
        }

        let disabled: HashSet<String> = self.disabled_builtins().into_iter().collect();
        for builtin in BUILTIN_SUBAGENT_HANDLES {
            if disabled.contains(builtin) || handles.contains(builtin) {
                continue;
            }
            if handles.len() < MAX_ACTIVE_USER_SUBAGENTS {
                handles.insert(builtin.into());
            } else {
                self.builtins.set_enabled(
                    SUBAGENT_BUILTIN_KIND,
                    CapabilityLevel::Global,
                    builtin,
                    None,
                    false,
                )?;
            }
        }
        Ok(())
    }

    pub fn list(&mut self) -> Result<Vec<UserSubagentRecord>> {
        let mut records = self.scan_registry()?;
        records.extend(self.scan_library()?);
        self.reconcile_active_selection(&mut records)?;
        records.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.source.cmp(&b.source)));
        Ok(records)
    }

    pub fn active_for(&mut self, _project_path: Option<&str>) -> Result<Vec<UserSubagentRecord>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|record| record.enabled)
            .collect())
    }

    fn find(&mut self, id: &str) -> Result<Option<UserSubagentRecord>> {
        Ok(self.list()?.into_iter().find(|record| record.id == id))
    }

    fn validate_user_activation(&mut self, id: &str, handle: &str) -> Result<()> {
        let records = self.list()?;
        if records
            .iter()
            .any(|record| record.enabled && record.id != id && record.name == handle)
        {
            bail!("SUBAGENT_CONFLICT: another source already activates handle \"{handle}\"");
        }
        let mut handles: HashSet<String> = records
            .into_iter()
            .filter(|record| record.enabled && record.id != id)
            .map(|record| record.name)
            .collect();
        let disabled: HashSet<String> = self.disabled_builtins().into_iter().collect();
        for builtin in BUILTIN_SUBAGENT_HANDLES {
            if !disabled.contains(builtin) {
                handles.insert(builtin.into());
            }
        }
        if !handles.contains(handle) && handles.len() >= MAX_ACTIVE_USER_SUBAGENTS {
            bail!("SUBAGENT_LIMIT: at most {MAX_ACTIVE_USER_SUBAGENTS} subagents can be active");
        }
        Ok(())
    }

    fn validate_builtin_activation(&mut self, handle: &str) -> Result<()> {
        let mut handles: HashSet<String> = self
            .list()?
            .into_iter()
            .filter(|record| record.enabled)
            .map(|record| record.name)
            .collect();
        let disabled: HashSet<String> = self.disabled_builtins().into_iter().collect();
        for builtin in BUILTIN_SUBAGENT_HANDLES {
            if builtin != handle && !disabled.contains(builtin) {
                handles.insert(builtin.into());
            }
        }
        if !handles.contains(handle) && handles.len() >= MAX_ACTIVE_USER_SUBAGENTS {
            bail!("SUBAGENT_LIMIT: at most {MAX_ACTIVE_USER_SUBAGENTS} subagents can be active");
        }
        Ok(())
    }

    pub fn create(&mut self, input: UserSubagentInput) -> Result<UserSubagentRecord> {
        let name = normalize_name(
            input
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .or(input.name.as_deref())
                .unwrap_or_default(),
        );
        if name.is_empty() {
            bail!("SUBAGENT_INVALID: name is required");
        }
        let description = clip(
            input.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_CHARS,
        );
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        if self
            .scan_registry()?
            .iter()
            .any(|record| record.id == name || record.name == name)
        {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        if self.scan_registry()?.len() >= MAX_USER_SUBAGENTS {
            bail!("SUBAGENT_INVALID: at most {MAX_USER_SUBAGENTS} subagents");
        }
        let tools = normalize_tools(input.tools.as_ref());
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let enabled = input.enabled.unwrap_or(true);
        if enabled {
            self.validate_user_activation(&name, &name)?;
        }
        let record = UserSubagentRecord {
            id: name.clone(),
            name,
            level: Some("global".into()),
            description,
            enabled,
            source: SUBAGENT_REGISTRY_SOURCE.into(),
            scope: ActivationScope::default(),
            tools,
            model: normalize_model(input.model.as_deref())?,
            fallback_models: model_fallbacks::normalize(
                input.fallback_models.as_deref().unwrap_or(&[]),
            )?,
            thinking_level: normalize_thinking(input.thinking_level.as_deref()),
            max_tokens: input
                .max_tokens
                .filter(|value| *value > 0)
                .map(|value| value.min(MAX_TOKENS_CEILING)),
            path: String::new(),
            size_bytes: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let directory = capability_dir(CapabilityLevel::Global, None, "subagents")?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.md", record.id));
        let default_body = default_body(&record.name);
        let body = input.body.as_deref().unwrap_or(default_body.as_str());
        let document = render_document(&record, body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if !record.enabled {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &record.id,
                None,
                false,
            )?;
        }
        self.find(&record.id)?
            .ok_or_else(|| anyhow::anyhow!("SUBAGENT_INVALID: created subagent was not found"))
    }

    pub fn update(
        &mut self,
        id: &str,
        input: UserSubagentInput,
    ) -> Result<Option<UserSubagentRecord>> {
        let Some(current) = self.find(id)? else {
            return Ok(None);
        };
        if current.source == SUBAGENT_LIBRARY_SOURCE {
            bail!("SUBAGENT_READ_ONLY: library definitions cannot be edited");
        }
        let name = input
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_name)
            .unwrap_or_else(|| current.name.clone());
        if name != current.name && self.scan_registry()?.iter().any(|record| record.id == name) {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .unwrap_or_else(|| current.description.clone());
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        let tools = normalize_tools(input.tools.as_ref().or(Some(&current.tools)));
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let raw = fs::read_to_string(&current.path)?;
        let (_, old_body) = parse_front_matter(&raw);
        let body = input.body.unwrap_or(old_body);
        let mut next = current.clone();
        next.id = name.clone();
        next.name = name.clone();
        next.description = description;
        next.tools = tools;
        next.model = match input.model {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_model(Some(value.as_str()))?,
            None => current.model,
        };
        if let Some(values) = input.fallback_models {
            next.fallback_models = model_fallbacks::normalize(&values)?;
        }
        next.thinking_level = match input.thinking_level {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_thinking(Some(value.as_str())),
            None => current.thinking_level,
        };
        next.max_tokens = match input.max_tokens {
            Some(0) => None,
            Some(value) => Some(value.min(MAX_TOKENS_CEILING)),
            None => current.max_tokens,
        };
        next.enabled = input.enabled.unwrap_or(current.enabled);
        if next.enabled && (!current.enabled || next.name != current.name) {
            self.validate_user_activation(&current.id, &next.name)?;
        }
        next.path = current.path.clone();
        if next.id != current.id {
            next.path = capability_dir(CapabilityLevel::Global, None, "subagents")?
                .join(format!("{}.md", next.id))
                .to_string_lossy()
                .to_string();
        }
        let document = render_document(&next, &body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&next.path, &document)?;
        if next.path != current.path {
            fs::remove_file(&current.path).ok();
        }
        if next.id != current.id {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &next.id,
                None,
                next.enabled,
            )?;
            self.state
                .forget(SUBAGENT_KIND, CapabilityLevel::Global, &current.id, None)?;
        } else if next.enabled != current.enabled {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &next.id,
                None,
                next.enabled,
            )?;
        }
        self.find(&next.id)
    }

    pub fn read(&mut self, id: &str) -> Result<Option<(UserSubagentRecord, String)>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let Some(record) = self.find(id)? else {
            return Ok(false);
        };
        if record.source == SUBAGENT_LIBRARY_SOURCE {
            bail!("SUBAGENT_READ_ONLY: library definitions cannot be removed here");
        }
        fs::remove_file(&record.path).ok();
        let _ = self.scan_registry()?;
        Ok(true)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<UserSubagentRecord>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        if enabled && !record.enabled {
            self.validate_user_activation(&record.id, &record.name)?;
        }
        if record.source == SUBAGENT_LIBRARY_SOURCE {
            self.library.set_enabled_with_default(
                SUBAGENT_LIBRARY_KIND,
                CapabilityLevel::Global,
                &record.id,
                None,
                enabled,
                false,
            )?;
        } else {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &record.id,
                None,
                enabled,
            )?;
        }
        self.find(id)
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<UserSubagentRecord>> {
        let _ = scope;
        self.find(id)
    }

    /// Handles the user turned off among the shipped subagent builtins.
    ///
    /// Read straight from the state file: the builtins have no document to
    /// scan, and the answer must not depend on which of them the running
    /// build happens to define.
    pub fn disabled_builtins(&self) -> Vec<String> {
        self.builtins
            .disabled_ids(SUBAGENT_BUILTIN_KIND, CapabilityLevel::Global)
    }

    /// Turn one builtin handle on or off, returning the normalized handle.
    ///
    /// The handle is normalized exactly like a document id, so the same
    /// spelling reaches the runtime catalog. Nothing is validated against a
    /// current builtin list on purpose: the state is sticky for handles a
    /// later build may reintroduce.
    pub fn set_builtin_enabled(&mut self, handle: &str, enabled: bool) -> Result<String> {
        let name = normalize_name(handle);
        if name.is_empty() {
            bail!("SUBAGENT_INVALID: a builtin handle is required");
        }
        if enabled && self.disabled_builtins().contains(&name) {
            self.validate_builtin_activation(&name)?;
        }
        self.builtins.set_enabled(
            SUBAGENT_BUILTIN_KIND,
            CapabilityLevel::Global,
            &name,
            None,
            enabled,
        )?;
        Ok(name)
    }
}
