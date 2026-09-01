import type { ExperimentFlags, ExperimentId } from "./experiments.js";

export type ShortcutId =
  | "search"
  | "navigate-inbox"
  | "navigate-projects"
  | "navigate-runs"
  | "navigate-pods"
  | "navigate-automations"
  | "navigate-usage"
  | "navigate-connections"
  | "navigate-archived"
  | "navigate-skills"
  | "toggle-sessions-view"
  | "open-settings"
  | "focus-inbox-search"
  | "new-session"
  | "focus-next-zone"
  | "focus-previous-zone"
  | "open-files"
  | "open-review"
  | "toggle-terminal"
  | "submit-run"
  | "relay-pod-note"
  | "shortcut-reference"
  | "inbox-next"
  | "inbox-previous"
  | "inbox-expand"
  | "inbox-next-split"
  | "inbox-previous-split"
  | "inbox-approve"
  | "inbox-deny"
  | "inbox-archive"
  | "inbox-snooze"
  | "inbox-pin"
  | "inbox-unread"
  | "inbox-reply"
  | "inbox-page-down"
  | "inbox-page-up"
  | "inbox-follow-latest"
  | "inbox-follow-latest-end"
  | "session-reading-line-down"
  | "session-reading-line-up"
  | "session-reading-page-down"
  | "session-reading-page-up"
  | "session-reading-start"
  | "session-reading-latest"
  | "session-reading-latest-end"
  | "session-reading-next-session"
  | "session-reading-previous-session"
  | "session-reading-approve"
  | "session-reading-deny"
  | "session-reading-archive"
  | "session-reading-snooze"
  | "session-reading-reply"
  | "steer-turn"
  | "stop-turn"
  | "exit-terminal";

export type ShortcutScope = "Global" | "Sessions" | "Sessions List" | "Session" | "Session Reading" | "Run dialog" | "Pod detail";

export type ShortcutGroup = "Navigation" | "Sessions List" | "Session Reading" | "Session" | "Actions" | "Help";

export type ShortcutDefinition = {
  id: ShortcutId;
  group: ShortcutGroup;
  label: string;
  description: string;
  scope: ShortcutScope;
  binding: {
    key: string;
    primary?: boolean;
    /** Literal Control key, for terminal boundaries that must not map to Command on macOS. */
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    /** Unmodified application key, gated by `inTypingContext` before matching. */
    bare?: boolean;
    /** Ordered bare-key chord. Stateful matching is handled by `advanceShortcutSequence`. */
    sequence?: readonly string[];
    /** Keycap shown to people when `KeyboardEvent.key` differs from the physical key label. */
    displayKey?: string;
  };
};

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "search",
    group: "Navigation",
    label: "Search",
    description: "Search sessions, transcripts, and views",
    scope: "Global",
    binding: { key: "k", primary: true },
  },
  {
    id: "navigate-inbox",
    group: "Navigation",
    label: "Sessions",
    description: "Open Sessions in its last-used list or board mode",
    scope: "Global",
    binding: { key: "1", bare: true },
  },
  {
    id: "navigate-automations",
    group: "Navigation",
    label: "Automations",
    description: "Open Automations",
    scope: "Global",
    binding: { key: "2", bare: true },
  },
  {
    id: "navigate-runs",
    group: "Navigation",
    label: "Multi-Agent",
    description: "Open Multi-Agent Runs",
    scope: "Global",
    binding: { key: "3", bare: true },
  },
  {
    id: "navigate-pods",
    group: "Navigation",
    label: "Pods",
    description: "Open Collaboration Pods",
    scope: "Global",
    binding: { key: "4", bare: true },
  },
  {
    id: "navigate-connections",
    group: "Navigation",
    label: "Connections",
    description: "Open Connections",
    scope: "Global",
    binding: { key: "5", bare: true },
  },
  {
    id: "navigate-skills",
    group: "Navigation",
    label: "Agent Skills",
    description: "Open Agent Skills",
    scope: "Global",
    binding: { key: "6", bare: true },
  },
  {
    id: "navigate-projects",
    group: "Navigation",
    label: "Projects",
    description: "Open Projects",
    scope: "Global",
    binding: { key: "7", bare: true },
  },
  {
    id: "navigate-archived",
    group: "Navigation",
    label: "Archived Sessions",
    description: "Open Archived Sessions",
    scope: "Global",
    binding: { key: "8", bare: true },
  },
  {
    id: "navigate-usage",
    group: "Navigation",
    label: "Usage",
    description: "Open Usage & Cost",
    scope: "Global",
    binding: { key: "9", bare: true },
  },
  {
    id: "toggle-sessions-view",
    group: "Navigation",
    label: "Toggle List / Board",
    description: "Switch Sessions between its list and board modes",
    scope: "Sessions",
    binding: { key: "b", bare: true },
  },
  {
    id: "open-settings",
    group: "Navigation",
    label: "Open Settings",
    description: "Open Settings from anywhere in the app",
    scope: "Global",
    // On supported desktop layouts Shift+, is reported as KeyboardEvent.key "<". Keep the
    // matcher honest while displaying the physical key people press rather than "Shift+<".
    binding: { key: "<", shift: true, displayKey: "," },
  },
  {
    id: "focus-inbox-search",
    group: "Navigation",
    label: "Search Sessions",
    description: "Focus the Sessions search",
    scope: "Global",
    binding: { key: "/", bare: true },
  },
  {
    id: "new-session",
    group: "Actions",
    label: "New Session",
    description: "Open the new session dialog",
    scope: "Global",
    binding: { key: "c", bare: true },
  },
  {
    id: "focus-next-zone",
    group: "Navigation",
    label: "Next Focus Zone",
    description: "Move focus through the rail, list, and detail",
    scope: "Global",
    binding: { key: "F6" },
  },
  {
    id: "focus-previous-zone",
    group: "Navigation",
    label: "Previous Focus Zone",
    description: "Move focus backward through the rail, list, and detail",
    scope: "Global",
    binding: { key: "F6", shift: true },
  },
  {
    id: "open-files",
    group: "Session",
    label: "Files Panel",
    description: "Open the current session's files",
    scope: "Session",
    binding: { key: "p", primary: true },
  },
  {
    id: "open-review",
    group: "Session",
    label: "Review Panel",
    description: "Open the current session's review summary",
    scope: "Session",
    binding: { key: "g", primary: true, shift: true },
  },
  {
    id: "toggle-terminal",
    group: "Session",
    label: "Toggle Terminal",
    description: "Show or hide the current session's terminal dock",
    scope: "Session",
    binding: { key: "`", primary: true },
  },
  {
    id: "submit-run",
    group: "Actions",
    label: "Start Multi-Agent Run",
    description: "Submit the current multi-agent run dialog",
    scope: "Run dialog",
    binding: { key: "Enter", primary: true },
  },
  {
    id: "relay-pod-note",
    group: "Actions",
    label: "Add Pod Note",
    description: "Add or relay the current attributed pod note",
    scope: "Pod detail",
    binding: { key: "Enter", primary: true },
  },
  {
    id: "shortcut-reference",
    group: "Help",
    label: "Keyboard Shortcuts",
    description: "Open this shortcut reference",
    scope: "Global",
    binding: { key: "?", shift: true, bare: true },
  },
  {
    id: "inbox-next",
    group: "Sessions List",
    label: "Next Session",
    description: "Select the next session card",
    scope: "Sessions List",
    binding: { key: "j", bare: true },
  },
  {
    id: "inbox-previous",
    group: "Sessions List",
    label: "Previous Session",
    description: "Select the previous session card",
    scope: "Sessions List",
    binding: { key: "k", bare: true },
  },
  {
    id: "inbox-expand",
    group: "Sessions List",
    label: "Expand Session",
    description: "Expand the selected session",
    scope: "Sessions List",
    binding: { key: "Enter", bare: true },
  },
  {
    id: "inbox-next-split",
    group: "Sessions List",
    label: "Next Split",
    description: "Move to the next project split",
    scope: "Sessions List",
    binding: { key: "Tab", bare: true },
  },
  {
    id: "inbox-previous-split",
    group: "Sessions List",
    label: "Previous Split",
    description: "Move to the previous project split",
    scope: "Sessions List",
    binding: { key: "Tab", shift: true, bare: true },
  },
  {
    id: "inbox-approve",
    group: "Sessions List",
    label: "Approve Request",
    description: "Approve the selected session request",
    scope: "Sessions List",
    binding: { key: "a", bare: true },
  },
  {
    id: "inbox-deny",
    group: "Sessions List",
    label: "Deny Request",
    description: "Deny the selected session request",
    scope: "Sessions List",
    binding: { key: "d", bare: true },
  },
  {
    id: "inbox-archive",
    group: "Sessions List",
    label: "Archive Session",
    description: "Archive the selected session and advance",
    scope: "Sessions List",
    binding: { key: "e", bare: true },
  },
  {
    id: "inbox-snooze",
    group: "Sessions List",
    label: "Snooze Session",
    description: "Schedule or edit a reminder for the selected session",
    scope: "Sessions List",
    binding: { key: "h", bare: true },
  },
  {
    id: "inbox-pin",
    group: "Sessions List",
    label: "Pin Session",
    description: "Pin or unpin the selected session",
    scope: "Sessions List",
    binding: { key: "s", bare: true },
  },
  {
    id: "inbox-unread",
    group: "Sessions List",
    label: "Mark Unread",
    description: "Mark the selected session unread",
    scope: "Sessions List",
    binding: { key: "u", bare: true },
  },
  {
    id: "inbox-reply",
    group: "Sessions List",
    label: "Reply to Session",
    description: "Expand the selected session and focus the composer",
    scope: "Sessions List",
    binding: { key: "r", bare: true },
  },
  {
    id: "inbox-page-down",
    group: "Sessions List",
    label: "Page Down",
    description: "Page down through preview history",
    scope: "Sessions List",
    binding: { key: " ", bare: true },
  },
  {
    id: "inbox-page-up",
    group: "Sessions List",
    label: "Page Up",
    description: "Page up through preview history",
    scope: "Sessions List",
    binding: { key: " ", shift: true, bare: true },
  },
  {
    id: "inbox-follow-latest",
    group: "Sessions List",
    label: "Follow Live Output",
    description: "Jump to the latest preview event and resume following",
    scope: "Sessions List",
    binding: { key: "g", shift: true, bare: true },
  },
  {
    id: "inbox-follow-latest-end",
    group: "Sessions List",
    label: "Follow Live Output (End)",
    description: "Jump to the latest preview event and resume following",
    scope: "Sessions List",
    binding: { key: "End", bare: true },
  },
  {
    id: "session-reading-line-down",
    group: "Session Reading",
    label: "Scroll Down",
    description: "Scroll the transcript down by one line",
    scope: "Session Reading",
    binding: { key: "j", bare: true },
  },
  {
    id: "session-reading-line-up",
    group: "Session Reading",
    label: "Scroll Up",
    description: "Scroll the transcript up by one line",
    scope: "Session Reading",
    binding: { key: "k", bare: true },
  },
  {
    id: "session-reading-page-down",
    group: "Session Reading",
    label: "Page Down",
    description: "Page down through session history",
    scope: "Session Reading",
    binding: { key: " ", bare: true },
  },
  {
    id: "session-reading-page-up",
    group: "Session Reading",
    label: "Page Up",
    description: "Page up through session history",
    scope: "Session Reading",
    binding: { key: " ", shift: true, bare: true },
  },
  {
    id: "session-reading-start",
    group: "Session Reading",
    label: "Session Start",
    description: "Jump to the start of the session",
    scope: "Session Reading",
    binding: { key: "g", bare: true, sequence: ["g", "g"] },
  },
  {
    id: "session-reading-latest",
    group: "Session Reading",
    label: "Follow Live Output",
    description: "Jump to the latest event and resume following",
    scope: "Session Reading",
    binding: { key: "g", shift: true, bare: true },
  },
  {
    id: "session-reading-latest-end",
    group: "Session Reading",
    label: "Follow Live Output (End)",
    description: "Jump to the latest event and resume following",
    scope: "Session Reading",
    binding: { key: "End", bare: true },
  },
  {
    id: "session-reading-next-session",
    group: "Session Reading",
    label: "Next Session",
    description: "Open the next inbox session while staying expanded",
    scope: "Session Reading",
    binding: { key: "j", ctrl: true },
  },
  {
    id: "session-reading-previous-session",
    group: "Session Reading",
    label: "Previous Session",
    description: "Open the previous inbox session while staying expanded",
    scope: "Session Reading",
    binding: { key: "k", ctrl: true },
  },
  {
    id: "session-reading-approve",
    group: "Session Reading",
    label: "Approve Request",
    description: "Approve the pending session request",
    scope: "Session Reading",
    binding: { key: "a", bare: true },
  },
  {
    id: "session-reading-deny",
    group: "Session Reading",
    label: "Deny Request",
    description: "Deny the pending session request",
    scope: "Session Reading",
    binding: { key: "d", bare: true },
  },
  {
    id: "session-reading-archive",
    group: "Session Reading",
    label: "Archive and Advance",
    description: "Archive this session and open the next session",
    scope: "Session Reading",
    binding: { key: "e", bare: true },
  },
  {
    id: "session-reading-snooze",
    group: "Session Reading",
    label: "Snooze Session",
    description: "Schedule or edit a reminder for this session",
    scope: "Session Reading",
    binding: { key: "h", bare: true },
  },
  {
    id: "session-reading-reply",
    group: "Session Reading",
    label: "Reply to Session",
    description: "Focus the session composer",
    scope: "Session Reading",
    binding: { key: "r", bare: true },
  },
  {
    id: "steer-turn",
    group: "Session",
    label: "Steer Active Turn",
    description: "Send the composer message into the active agent turn",
    scope: "Session",
    binding: { key: "Enter", ctrl: true },
  },
  {
    id: "stop-turn",
    group: "Session",
    label: "Stop Turn",
    description: "Stop the active agent turn without ending the session",
    scope: "Session",
    binding: { key: "Escape", shift: true },
  },
  {
    id: "exit-terminal",
    group: "Session",
    label: "Exit Terminal Focus",
    description: "Return keyboard focus from the terminal to the session",
    scope: "Session",
    binding: { key: "Escape", ctrl: true },
  },
] as const;

export const SHORTCUT_GROUPS = ["Navigation", "Sessions List", "Session Reading", "Session", "Actions", "Help"] as const;

export function shortcut(id: ShortcutId): ShortcutDefinition {
  const definition = SHORTCUTS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`unknown shortcut: ${id}`);
  return definition;
}

export type KeyboardLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

type ActiveElementDocument = Pick<Document, "activeElement">;

function typingElement(element: Element | null): boolean {
  if (!element) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  if (element.closest(".xterm")) return true;
  const editable = element.closest<HTMLElement>("[contenteditable]");
  return Boolean(editable && editable.getAttribute("contenteditable")?.toLowerCase() !== "false");
}

/** The single guard for every unmodified letter, symbol, and navigation key. */
export function inTypingContext(
  targetDocument: ActiveElementDocument | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
  return typingElement(targetDocument?.activeElement ?? null);
}

export function matchesShortcut(
  event: KeyboardLike,
  id: ShortcutId,
  targetDocument: ActiveElementDocument | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
  const binding = shortcut(id).binding;
  if (binding.sequence?.length) return false;
  if (binding.bare && inTypingContext(targetDocument)) return false;
  const primary = event.ctrlKey || event.metaKey;
  if (binding.ctrl) {
    if (!event.ctrlKey || event.metaKey) return false;
  } else if (Boolean(binding.primary) !== primary) return false;
  if (Boolean(binding.shift) !== event.shiftKey) return false;
  if (Boolean(binding.alt) !== event.altKey) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function shortcutDisplay(id: ShortcutId, mac = isMacPlatform()): string {
  return shortcutBindingDisplay(shortcut(id).binding, mac);
}

export function shortcutBindingDisplay(binding: ShortcutDefinition["binding"], mac = isMacPlatform()): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  else if (binding.primary) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift && binding.key !== "?") parts.push(mac ? "⇧" : "Shift");
  const key = binding.sequence?.length
    ? binding.sequence.map(displayKey).join(" ")
    : displayKey(binding.displayKey ?? binding.key);
  parts.push(key);
  return mac && !binding.ctrl ? parts.join("") : parts.join("+");
}

function displayKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  return key.length === 1 && key !== "`" ? key.toUpperCase() : key;
}

export interface ShortcutSequenceState {
  index: number;
  expiresAt: number;
}

export interface ShortcutSequenceResult {
  matched: boolean;
  state: ShortcutSequenceState | null;
}

export const SHORTCUT_SEQUENCE_WINDOW_MS = 600;

/**
 * Advance one bare-key sequence. A mismatch or typing context cancels the chord; an expired
 * chord treats the current key as a possible new first key. Registry lookup remains with the
 * caller so scopes and remapped definitions stay centralized.
 */
export function advanceShortcutSequence(
  event: KeyboardLike,
  sequence: readonly string[],
  state: ShortcutSequenceState | null,
  now: number,
  targetDocument: ActiveElementDocument | undefined = typeof document === "undefined" ? undefined : document,
  windowMs = SHORTCUT_SEQUENCE_WINDOW_MS,
): ShortcutSequenceResult {
  if (sequence.length === 0 || inTypingContext(targetDocument)) return { matched: false, state: null };
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return { matched: false, state: null };

  const index = state && now <= state.expiresAt ? state.index : 0;
  if (event.key.toLowerCase() !== sequence[index]?.toLowerCase()) return { matched: false, state: null };
  if (index === sequence.length - 1) return { matched: true, state: null };
  return { matched: false, state: { index: index + 1, expiresAt: now + windowMs } };
}

/** Shortcuts whose feature can be switched off in Settings → Experimental. Their handlers all
 * live inside the gated surfaces, so the binding is already dead when the flag is off — this
 * mapping exists so the reference says why instead of advertising a working key. */
const EXPERIMENT_SHORTCUT_IDS: Partial<Record<ShortcutId, ExperimentId>> = {
  "navigate-runs": "multiAgent",
  "submit-run": "multiAgent",
  "navigate-pods": "pods",
  "relay-pod-note": "pods",
};

export function shortcutUnavailableReason(
  definition: ShortcutDefinition,
  context: {
    sessionOpen: boolean;
    terminalSupported: boolean;
    filesSupported: boolean;
    conversationSteeringSupported?: boolean;
    turnInterruptionSupported?: boolean;
    experimentFlags?: ExperimentFlags;
  },
): string | null {
  const experiment = EXPERIMENT_SHORTCUT_IDS[definition.id];
  if (experiment && context.experimentFlags && !context.experimentFlags[experiment]) {
    return "Turned off in Settings → Experimental";
  }
  if ((definition.scope === "Session" || definition.scope === "Session Reading") && !context.sessionOpen) {
    return "Open a session to use this binding";
  }
  if (definition.id === "toggle-terminal" && !context.terminalSupported) {
    return "Unavailable until this runner supports session shells";
  }
  if (definition.id === "open-files" && !context.filesSupported) {
    return "Unavailable until this runner supports session files";
  }
  if (definition.id === "steer-turn" && !context.conversationSteeringSupported) {
    return "Unavailable until this runner supports conversation steering";
  }
  if (definition.id === "stop-turn" && !context.turnInterruptionSupported) {
    return "Unavailable until this runner supports stopping an active turn";
  }
  return null;
}

export function shortcutLayerActive(document: Document, exceptPalette = false): boolean {
  const modal = exceptPalette ? '[aria-modal="true"]:not(.palette)' : '[aria-modal="true"]';
  return Boolean(document.querySelector(exceptPalette ? modal : `${modal}, [role="menu"], .plus-pop[role="dialog"]`));
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return typingElement(target);
}
