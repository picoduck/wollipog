import { LOCAL_INSTANCE_SCOPE, loadInstanceStorageValue, saveInstanceStorageValue } from "./instance-storage.js";
import type { View } from "./navigation.js";

/**
 * The Sessions destination's last-used presentation: the project-grouped list or the status
 * kanban board. One destination, two modes — the mode is reflected in the route (`/` vs
 * `/board`), so persistence only decides where ACTIVATING the destination (rail, digit,
 * palette, back-from-session) lands. Direct navigation to either path always wins.
 */
export type SessionsViewMode = "list" | "board";

export const SESSIONS_VIEW_MODE_KEY = "wollipog.sessions.viewMode";

export function loadSessionsViewMode(instanceScope = LOCAL_INSTANCE_SCOPE): SessionsViewMode {
  return loadInstanceStorageValue(SESSIONS_VIEW_MODE_KEY, instanceScope) === "board" ? "board" : "list";
}

export function saveSessionsViewMode(mode: SessionsViewMode, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  saveInstanceStorageValue(SESSIONS_VIEW_MODE_KEY, mode, instanceScope);
}

/**
 * The mode a view records when it is current, or null for views that must not touch the
 * persisted mode. An expanded session deliberately records nothing: a session opened from the
 * board would otherwise flip the preference and strand the eventual "back" in the list.
 */
export function sessionsViewModeForView(view: Pick<View, "name">): SessionsViewMode | null {
  if (view.name === "inbox") return "list";
  if (view.name === "board") return "board";
  return null;
}

/** Where activating the Sessions destination goes: the persisted mode's route. */
export function sessionsDestination(instanceScope = LOCAL_INSTANCE_SCOPE): View {
  return loadSessionsViewMode(instanceScope) === "board" ? { name: "board" } : { name: "inbox" };
}
