use super::*;
use tempfile::tempdir;

#[test]
fn parser_rejects_missing_description() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("agent.md");
    fs::write(&path, "---\nname: agent\n---\n\nDo it\n").unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    assert!(parse_record(&path, &state).is_none());
}

#[test]
fn tools_are_normalized_and_unknown_tools_are_dropped() {
    assert_eq!(
        normalize_tools(Some(&vec!["read".into(), "Nope".into(), "Bash".into()])),
        vec!["Read", "Bash"]
    );
}

#[test]
fn inherit_token_is_kept_and_unknown_tools_still_drop() {
    assert_eq!(
        normalize_tools(Some(&vec!["inherit".into()])),
        vec!["inherit"]
    );
    assert_eq!(
        normalize_tools(Some(&vec!["inherit".into(), "Bash".into(), "Nope".into()])),
        vec!["inherit".to_string(), "Bash".to_string()]
    );
}

#[test]
fn inherit_only_documents_round_trip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(
            &path,
            "---\nname: worker\ndescription: Uses the parent tools.\ntools: inherit\n---\n\nDo the job.\n",
        )
        .unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let record = parse_record(&path, &state).expect("inherit-only document must load");
    assert_eq!(record.tools, vec!["inherit"]);
    let rendered = render_document(&record, "Do the job.");
    assert!(rendered.contains("tools: inherit\n"));
    assert!(!rendered.contains("tools: [inherit]"));
}

#[test]
fn fallback_pins_survive_record_document_round_trips() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(&path, "---\nname: worker\ndescription: Fixture.\nmodel: primary/model\nfallbackModels: [backup/one, Other Gateway/vendor/two]\n---\n\nKeep the body.\n").unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let mut record = parse_record(&path, &state).unwrap();
    assert_eq!(
        record.fallback_models,
        vec!["backup/one", "Other Gateway/vendor/two"]
    );
    let wire = serde_json::to_value(&record).unwrap();
    assert_eq!(
        wire["fallbackModels"],
        serde_json::json!(["backup/one", "Other Gateway/vendor/two"])
    );
    fs::write(&path, render_document(&record, "Keep the body.")).unwrap();
    assert_eq!(
        parse_record(&path, &state).unwrap().fallback_models,
        record.fallback_models
    );
    record.fallback_models.clear();
    let cleared = render_document(&record, "Keep the body.");
    assert!(!cleared.contains("fallbackModels"));
    fs::write(&path, cleared).unwrap();
    assert!(parse_record(&path, &state)
        .unwrap()
        .fallback_models
        .is_empty());
    let old: UserSubagentInput = serde_json::from_str("{}").unwrap();
    assert!(old.fallback_models.is_none());
    let clear: UserSubagentInput = serde_json::from_str(r#"{"fallbackModels":[]}"#).unwrap();
    assert_eq!(clear.fallback_models, Some(vec![]));
}

#[test]
fn omit_is_a_valid_thinking_override() {
    assert_eq!(normalize_thinking(Some("omit")), Some("omit".into()));
    assert_eq!(normalize_thinking(Some(" OMIT ")), Some("omit".into()));
}

#[test]
fn document_contains_no_activation_state() {
    let record = UserSubagentRecord {
        id: "review".into(),
        name: "review".into(),
        level: Some("global".into()),
        description: "Review code".into(),
        enabled: false,
        source: SUBAGENT_REGISTRY_SOURCE.into(),
        scope: ActivationScope::default(),
        tools: vec!["Read".into()],
        model: None,
        fallback_models: Vec::new(),
        thinking_level: None,
        max_tokens: None,
        path: "/tmp/review.md".into(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    };
    assert!(!render_document(&record, "Review it").contains("enabled"));
}

#[test]
fn an_output_cap_is_written_and_an_absent_one_is_omitted() {
    let mut record = UserSubagentRecord {
        id: "review".into(),
        name: "review".into(),
        level: Some("global".into()),
        description: "Review code".into(),
        enabled: true,
        source: SUBAGENT_REGISTRY_SOURCE.into(),
        scope: ActivationScope::default(),
        tools: vec!["Read".into()],
        model: None,
        fallback_models: Vec::new(),
        thinking_level: None,
        max_tokens: Some(16_000),
        path: "/tmp/review.md".into(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let document = render_document(&record, "Review it");
    assert!(document.contains("maxTokens: 16000\n"));

    // Absent means "follow the model", so the key must not appear at all —
    // a written `maxTokens: 0` would read back as an explicit empty cap.
    record.max_tokens = None;
    assert!(!render_document(&record, "Review it").contains("maxTokens"));
}

#[test]
fn legacy_max_turns_frontmatter_is_ignored() {
    // The turn limit is gone (ADR 0253). A document that still declares the
    // key must load like any other unknown frontmatter key: keys are only
    // lowercased, so `maxTurns` used to normalize to `maxturns`, while
    // `max-turns` was never read in the first place.
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(
            &path,
            "---\nname: worker\ndescription: Uses the parent tools.\ntools: [Read]\nmaxTurns: 20\nmax-turns: 20\n---\n\nDo the job.\n",
        )
        .unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let record = parse_record(&path, &state).expect("a legacy maxTurns key must not fail the load");
    assert_eq!(record.description, "Uses the parent tools.");
    assert!(!render_document(&record, "Do the job.").contains("maxTurns"));
}

#[test]
fn a_model_pin_requires_a_slash_and_keeps_the_users_spelling() {
    // The shape is `provider/model`; the provider half may be a vendor key
    // or a display name, and a custom endpoint's name contains spaces.
    assert_eq!(
        normalize_model(Some("anthropic/claude-haiku-4-5")).unwrap(),
        Some("anthropic/claude-haiku-4-5".into())
    );
    assert_eq!(
        normalize_model(Some("  My Gateway/local-model  ")).unwrap(),
        Some("My Gateway/local-model".into())
    );
    // An openrouter-style model id keeps its own slashes.
    assert_eq!(
        normalize_model(Some("openrouter/deepseek/deepseek-chat")).unwrap(),
        Some("openrouter/deepseek/deepseek-chat".into())
    );
}

#[test]
fn a_cleared_model_is_none_and_a_malformed_one_is_rejected() {
    assert_eq!(normalize_model(None).unwrap(), None);
    assert_eq!(normalize_model(Some("   ")).unwrap(), None);

    // A bare id has no provider to look up, so the runtime could never
    // resolve it; the editor rejects the same shape before saving.
    assert!(normalize_model(Some("claude-haiku-4-5")).is_err());
    assert!(normalize_model(Some("/claude-haiku-4-5")).is_err());
    assert!(normalize_model(Some("anthropic/")).is_err());
}

#[test]
fn builtins_are_enabled_until_one_is_turned_off() {
    use crate::agent_capabilities::test_support;

    let dir = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(dir.path());
        assert!(registry.disabled_builtins().is_empty());

        let handle = registry.set_builtin_enabled("Fixer", false).unwrap();
        assert_eq!(handle, "fixer");
        assert_eq!(registry.disabled_builtins(), vec!["fixer".to_string()]);

        registry.set_builtin_enabled("fixer", true).unwrap();
        assert!(registry.disabled_builtins().is_empty());
    });
}

#[test]
fn builtin_state_survives_a_registry_rebuild() {
    let dir = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    registry.set_builtin_enabled("fixer", false).unwrap();
    registry
        .set_builtin_enabled("code-reviewer", false)
        .unwrap();

    let reopened = UserSubagentRegistry::new(dir.path());
    // Sorted, so the answer never depends on insertion order.
    assert_eq!(
        reopened.disabled_builtins(),
        vec!["code-reviewer".to_string(), "fixer".to_string()]
    );
}

#[test]
fn a_blank_builtin_handle_is_rejected() {
    let dir = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    let error = registry.set_builtin_enabled("   ", false).unwrap_err();
    assert!(error.to_string().contains("SUBAGENT_INVALID"));
    assert!(registry.disabled_builtins().is_empty());
}

#[test]
fn listing_documents_does_not_prune_builtin_state() {
    // The scan prunes state for ids it did not find. A builtin has no
    // document at all, so the two kinds must never share one state file or
    // the first `list()` would delete every builtin the user turned off.
    use crate::agent_capabilities::test_support;

    let dir = tempdir().unwrap();
    let agents = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    registry.set_builtin_enabled("fixer", false).unwrap();

    test_support::with_global_agents(agents.path(), || {
        registry.list().unwrap();
    });
    assert_eq!(registry.disabled_builtins(), vec!["fixer".to_string()]);

    // And a rebuilt registry still agrees after the listing.
    let mut reopened = UserSubagentRegistry::new(dir.path());
    test_support::with_global_agents(agents.path(), || {
        reopened.list().unwrap();
    });
    assert_eq!(reopened.disabled_builtins(), vec!["fixer".to_string()]);

    // The document kind keeps its own file, so the builtin entry is not
    // mistaken for a user subagent either.
    assert!(dir
        .path()
        .join("agent-capabilities/subagent-builtins.json")
        .exists());
}

fn write_definition(path: &Path, name: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(
            path,
            format!(
                "---\nname: {name}\ndescription: Test {name}.\ntools: [Read, Glob, Grep]\n---\n\nDo {name}.\n"
            ),
        )
        .unwrap();
}

#[test]
fn library_definitions_default_off_and_activation_persists() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    write_definition(
        &agents
            .path()
            .join("subagent-library/customagents/library-worker.md"),
        "library-worker",
    );
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let library = registry
            .list()
            .unwrap()
            .into_iter()
            .find(|record| record.source == SUBAGENT_LIBRARY_SOURCE)
            .unwrap();
        assert_eq!(library.id, "customagents:library-worker");
        assert!(!library.enabled);
        assert!(registry.active_for(None).unwrap().is_empty());

        let enabled = registry.set_enabled(&library.id, true).unwrap().unwrap();
        assert!(enabled.enabled);
        assert_eq!(registry.active_for(None).unwrap()[0].name, "library-worker");

        let mut reopened = UserSubagentRegistry::new(data.path());
        assert!(
            reopened
                .find("customagents:library-worker")
                .unwrap()
                .unwrap()
                .enabled
        );
    });
}

#[test]
fn active_registry_handle_blocks_same_named_library_handle() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    write_definition(&agents.path().join("subagents/worker.md"), "worker");
    write_definition(
        &agents
            .path()
            .join("subagent-library/customagents/worker.md"),
        "worker",
    );
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let error = registry
            .set_enabled("customagents:worker", true)
            .unwrap_err();
        assert!(error.to_string().contains("SUBAGENT_CONFLICT"));
        assert_eq!(
            registry.active_for(None).unwrap()[0].source,
            SUBAGENT_REGISTRY_SOURCE
        );
    });
}

#[test]
fn activating_a_seventeenth_user_handle_is_rejected() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    for index in 0..MAX_ACTIVE_USER_SUBAGENTS {
        write_definition(
            &agents.path().join(format!("subagents/worker-{index}.md")),
            &format!("worker-{index}"),
        );
    }
    write_definition(
        &agents.path().join("subagent-library/customagents/extra.md"),
        "extra",
    );
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let error = registry
            .set_enabled("customagents:extra", true)
            .unwrap_err();
        assert!(error.to_string().contains("SUBAGENT_LIMIT"));
    });
}

#[test]
fn library_definitions_are_read_only_through_registry_crud() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    let path = agents
        .path()
        .join("subagent-library/customagents/library-worker.md");
    write_definition(&path, "library-worker");
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let update = registry
            .update("customagents:library-worker", UserSubagentInput::default())
            .unwrap_err();
        assert!(update.to_string().contains("SUBAGENT_READ_ONLY"));
        let remove = registry.remove("customagents:library-worker").unwrap_err();
        assert!(remove.to_string().contains("SUBAGENT_READ_ONLY"));
        assert!(path.exists());
    });
}

fn input(name: &str, enabled: bool) -> UserSubagentInput {
    UserSubagentInput {
        name: Some(name.into()),
        description: Some(format!("Test {name}.")),
        body: Some(format!("Do {name}.")),
        tools: Some(vec!["Read".into()]),
        enabled: Some(enabled),
        ..UserSubagentInput::default()
    }
}

#[test]
fn active_library_handle_blocks_active_registry_creation() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    write_definition(
        &agents
            .path()
            .join("subagent-library/customagents/worker.md"),
        "worker",
    );
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        registry.set_enabled("customagents:worker", true).unwrap();
        let error = registry.create(input("worker", true)).unwrap_err();
        assert!(error.to_string().contains("SUBAGENT_CONFLICT"));
        assert!(!agents.path().join("subagents/worker.md").exists());
    });
}

#[test]
fn builtin_activation_cannot_become_the_seventeenth_handle() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        registry.set_builtin_enabled("fixer", false).unwrap();
        for index in 0..13 {
            registry
                .create(input(&format!("worker-{index}"), true))
                .unwrap();
        }
        let error = registry.set_builtin_enabled("fixer", true).unwrap_err();
        assert!(error.to_string().contains("SUBAGENT_LIMIT"));
    });
}

#[test]
fn renaming_a_disabled_registry_definition_keeps_it_disabled() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let created = registry.create(input("before", false)).unwrap();
        assert!(!created.enabled);
        let renamed = registry
            .update(
                "before",
                UserSubagentInput {
                    name: Some("after".into()),
                    ..UserSubagentInput::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(renamed.id, "after");
        assert!(!renamed.enabled);
    });
}

#[test]
fn legacy_overflow_is_persisted_as_the_previous_effective_sixteen() {
    use crate::agent_capabilities::test_support;

    let data = tempdir().unwrap();
    let agents = tempdir().unwrap();
    for index in 0..17 {
        write_definition(
            &agents
                .path()
                .join(format!("subagents/worker-{index:02}.md")),
            &format!("worker-{index:02}"),
        );
    }
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSubagentRegistry::new(data.path());
        let listed = registry.list().unwrap();
        assert_eq!(listed.iter().filter(|record| record.enabled).count(), 16);
        assert!(
            !listed
                .iter()
                .find(|record| record.name == "worker-16")
                .unwrap()
                .enabled
        );
        assert_eq!(
            registry.disabled_builtins().len(),
            BUILTIN_SUBAGENT_HANDLES.len()
        );

        let mut reopened = UserSubagentRegistry::new(data.path());
        assert_eq!(reopened.active_for(None).unwrap().len(), 16);
        assert_eq!(
            reopened.disabled_builtins().len(),
            BUILTIN_SUBAGENT_HANDLES.len()
        );
    });
}
