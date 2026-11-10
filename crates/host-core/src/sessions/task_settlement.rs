use super::*;

/// Existing ids are replay-safe, except provisional assistant and active Task snapshots.
pub(super) fn update_existing_snapshot(
    db: &Database,
    session_id: &str,
    message: &UiMessage,
) -> Result<bool> {
    let assistant = message.role == "assistant"
        && message.status.as_deref() != Some("streaming")
        && streaming_assistant_indexed(db, session_id, &message.id)?;
    let task = if terminal_task(message) {
        transcripts::read_transcript(db.data_dir(), session_id)?
            .into_iter()
            .rev()
            .find(|record| record.id == message.id)
            .map(record_to_ui)
            .filter(|old| {
                old.role == "tool"
                    && old.tool_name.as_deref() == Some("Task")
                    && old.tool_call_id == message.tool_call_id
                    && old.tool_args == message.tool_args
                    && old.created_at == message.created_at
                    && old.parent_tool_call_id == message.parent_tool_call_id
                    && old
                        .tool_result
                        .as_ref()
                        .and_then(|r| r.pointer("/details/status"))
                        .and_then(Value::as_str)
                        == Some("running")
                    && old
                        .tool_result
                        .as_ref()
                        .and_then(|r| r.pointer("/details/delegationId"))
                        == message
                            .tool_result
                            .as_ref()
                            .and_then(|r| r.pointer("/details/delegationId"))
            })
    } else {
        None
    };
    let updated = if assistant {
        message.clone()
    } else if let Some(mut old) = task {
        // Settlement must not rewrite original tool usage or attribution.
        old.content = message.content.clone();
        old.tool_result = message.tool_result.clone();
        old
    } else {
        return Ok(false);
    };
    let (record, text) = ui_to_record(&updated);
    invalidate_transcript_layout(session_id);
    if !transcripts::update_message(db.data_dir(), session_id, &record)? {
        return Err(anyhow!(
            "provisional message is missing from its transcript"
        ));
    }
    db.conn().execute(
        "UPDATE messages SET text = ?3, is_error = ?4 WHERE session_id = ?1 AND id = ?2",
        params![session_id, record.id, text, record.is_error],
    )?;
    Ok(true)
}

fn terminal_task(message: &UiMessage) -> bool {
    message.role == "tool"
        && message.tool_name.as_deref() == Some("Task")
        && message
            .tool_result
            .as_ref()
            .and_then(|r| r.pointer("/details/delegationId"))
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && matches!(
            message
                .tool_result
                .as_ref()
                .and_then(|r| r.pointer("/details/status"))
                .and_then(Value::as_str),
            Some("completed" | "failed" | "stopped" | "aborted")
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_settlement_survives_reload_without_reordering_or_replay_regression() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        for status in ["completed", "failed", "stopped", "aborted"] {
            let initial: UiMessage = serde_json::from_value(serde_json::json!({
                "id": status, "role": "tool", "content": "started", "createdAt": "2026-11-10T00:00:00Z",
                "toolName": "Task", "toolCallId": status, "toolArgs": {"agent":"explorer","task":status},
                "toolResult": {"details":{"delegationId":status,"status":"running"}}
            })).unwrap();
            append_message(&db, &session.id, &initial, None).unwrap();
            let mut settled = initial.clone();
            settled.content = format!("settled {status}");
            settled.tool_result =
                Some(serde_json::json!({"details":{"delegationId":status,"status":status}}));
            let mut wrong = settled.clone();
            wrong.tool_result.as_mut().unwrap()["details"]["delegationId"] =
                serde_json::json!("other");
            append_message(&db, &session.id, &wrong, None).unwrap();
            assert_eq!(
                get_session(&db, &session.id)
                    .unwrap()
                    .unwrap()
                    .messages
                    .last()
                    .unwrap()
                    .content,
                "started"
            );
            append_message(&db, &session.id, &settled, None).unwrap();
            append_message(&db, &session.id, &initial, None).unwrap();
            append_message(&db, &session.id, &wrong, None).unwrap();
            assert_eq!(
                get_session(&db, &session.id)
                    .unwrap()
                    .unwrap()
                    .messages
                    .last()
                    .unwrap()
                    .content,
                settled.content
            );
        }
        let restored = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(
            restored
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["completed", "failed", "stopped", "aborted"]
        );
        assert_eq!(
            transcripts::read_transcript(db.data_dir(), &session.id)
                .unwrap()
                .len(),
            4
        );
    }
}
