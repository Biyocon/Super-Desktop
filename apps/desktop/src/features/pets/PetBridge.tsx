import { useEffect } from "react";
import i18n from "i18next";
import { useAppStore } from "../../stores/app-store";
import type { AppState } from "../../stores/app-state";
import { projectMiniActivity } from "./mini-activity";
import { petsClient } from "./client";


/** The only bridge from selected-session UI state to the native companion. */
export function PetBridge() {
  useEffect(() => {
    let alive = true;
    let previous = "";
    let pending = Promise.resolve();
    const report = () => {
      if (alive) useAppStore.setState({ error: i18n.t("pets.operationFailed") });
    };
    const publish = (state: AppState) => {
      if (!state.settings) return;
      const activity = projectMiniActivity(state);
      const key = JSON.stringify(activity);
      if (key === previous) return;
      previous = key;
      pending = pending.then(async () => { if (alive) await petsClient.publish(activity); }).catch(report);
    };
    const unsubscribe = useAppStore.subscribe(publish);
    const stopActions = petsClient.onAction((action) => {
      const state = useAppStore.getState();
      if (typeof action === "object") {
        const draft = action.draft;
        if (state.activeSessionId !== draft.sessionId || state.composerPrefill) { report(); return; }
        state.setPage("chat");
        useAppStore.setState({ composerPrefill: { sessionId: draft.sessionId, text: draft.text, fileReferences: [], append: true } });
      } else if (action === "settings") state.setSettingsTab("pets");
      else if (action === "dictate") state.setSettingsTab("pets");
      else if (action === "newTask") void state.newSession().catch(report);
    });
    publish(useAppStore.getState());
    return () => { alive = false; unsubscribe(); stopActions(); };
  }, []);
  return null;
}
