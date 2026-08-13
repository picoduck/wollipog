import { escapeOwner } from "./focus-zones.js";
import type { View } from "./navigation.js";
import {
  inTypingContext,
  isEditableShortcutTarget,
  matchesShortcut,
  shortcutLayerActive,
} from "./shortcuts.js";

type SettingsNavigationOptions = {
  document: Document;
  viewName: View["name"];
  settingsReturnView: View | null;
  navigate: (view: View) => void;
};

/** Shift+, is global navigation, but never text input, an IME keystroke, or a nested layer key. */
export function settingsShortcutShouldOpen(event: KeyboardEvent, targetDocument: Document): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  if (shortcutLayerActive(targetDocument)) return false;
  if (inTypingContext(targetDocument) || isEditableShortcutTarget(event.target)) return false;
  return matchesShortcut(event, "open-settings", targetDocument);
}

/**
 * Handle the two Settings-owned shell keys. Returns true only when this function consumed the
 * event, allowing the rest of the shell Escape ladder to keep ownership of layers and other views.
 */
export function handleSettingsNavigationKey(
  event: KeyboardEvent,
  { document: targetDocument, viewName, settingsReturnView, navigate }: SettingsNavigationOptions,
): boolean {
  // Settings is already open. Do not silently reset a non-default section to Appearance or add a
  // duplicate browser-history entry when the global shortcut is pressed again.
  if (viewName !== "settings" && settingsShortcutShouldOpen(event, targetDocument)) {
    event.preventDefault();
    navigate({ name: "settings" });
    return true;
  }
  // Composition owns Escape too: the first Escape may cancel the active IME candidate.
  if (event.isComposing || event.keyCode === 229) return false;

  const owner = escapeOwner(event, { document: targetDocument, viewName });
  if (owner === "settings-input") {
    event.preventDefault();
    (targetDocument.activeElement as HTMLElement | null)?.blur();
    return true;
  }
  if (owner === "settings") {
    event.preventDefault();
    // This is deliberately an in-app PUSH, not history.back(): direct/deep-link entry has no
    // guaranteed same-app predecessor, and a browser Back after this return reopens Settings.
    navigate(settingsReturnView ?? { name: "inbox" });
    return true;
  }
  return false;
}
