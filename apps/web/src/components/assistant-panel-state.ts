import { useCallback, useEffect, useRef, useState } from "react";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

export const ASSISTANT_PANEL_TABS = ["Work", "Decisions", "Details"] as const;
export type AssistantPanelTab = typeof ASSISTANT_PANEL_TABS[number];
const PREFERENCE_KEY = "wollipog.assistant-panel";

interface PanelPreference {
  open: boolean;
  tab: AssistantPanelTab;
}

function loadPreference(): PanelPreference {
  try {
    const saved: Partial<PanelPreference> | null = JSON.parse(loadBrowserStorageValue(PREFERENCE_KEY) ?? "null");
    return {
      open: saved?.open === true,
      tab: saved?.tab && ASSISTANT_PANEL_TABS.includes(saved.tab) ? saved.tab : "Work",
    };
  } catch {
    return { open: false, tab: "Work" };
  }
}

export function useAssistantPanelState() {
  const [preference, setPreference] = useState(loadPreference);
  const lastSaved = useRef(preference);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // Loading a thread or mounting the shell must never write a preference.
    if (lastSaved.current === preference) return;
    lastSaved.current = preference;
    try {
      saveBrowserStorageValue(PREFERENCE_KEY, JSON.stringify(preference));
    } catch {
      /* Storage unavailable. The panel still works during this visit. */
    }
  }, [preference]);
  const close = useCallback(() => setPreference((current) => current.open ? { ...current, open: false } : current), []);
  const toggle = useCallback(() => setPreference((current) => ({ ...current, open: !current.open })), []);
  const show = (tab: AssistantPanelTab) => setPreference({ open: true, tab });
  return {
    ...preference,
    expanded,
    setExpanded,
    close,
    show,
    toggle,
  };
}

export type AssistantPanelState = ReturnType<typeof useAssistantPanelState>;

