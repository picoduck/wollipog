import { useSyncExternalStore } from "react";

/**
 * Show Agent Logs (#2184): whether the transcript renders a run of work whose only steps are a
 * harness's own output (stderr, such as a boot line). Off by default and stored on this device.
 * Agent Log steps inside a run with other work always render.
 */
export const SHOW_AGENT_LOGS_STORAGE_KEY = "wollipog.show-agent-logs";
const SHOW_AGENT_LOGS_CHANGE_EVENT = "wollipog:show-agent-logs-change";
const unstorableChoice = new WeakMap<Window, boolean>();

export function showAgentLogs(win: Window = window): boolean {
  const remembered = unstorableChoice.get(win);
  if (remembered !== undefined) return remembered;
  try {
    return win.localStorage.getItem(SHOW_AGENT_LOGS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setShowAgentLogs(value: boolean, win: Window = window): void {
  try {
    win.localStorage.setItem(SHOW_AGENT_LOGS_STORAGE_KEY, String(value));
    unstorableChoice.delete(win);
  } catch {
    // Keep the explicit choice effective for this page even when storage is best-effort.
    unstorableChoice.set(win, value);
  }
  win.dispatchEvent(new Event(SHOW_AGENT_LOGS_CHANGE_EVENT));
}

export function useShowAgentLogs(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(SHOW_AGENT_LOGS_CHANGE_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(SHOW_AGENT_LOGS_CHANGE_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => showAgentLogs(),
    () => false,
  );
}
