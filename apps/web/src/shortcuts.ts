import type { ExperimentFlags, ExperimentId } from "./experiments.js";
import { GLOBAL_VIEW_ITEMS, type GlobalViewName } from "./navigation.js";

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
  | "inbox-grid-next"
  | "inbox-grid-previous"
  | "inbox-grid-first"
  | "inbox-expand"
  | "inbox-open-top-request"
  | "inbox-toggle-thread"
  | "inbox-toggle-all-threads"
  | "inbox-go-to-parent"
  | "inbox-expand-thread"
  | "inbox-collapse-thread"
  | "inbox-fork"
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
  | "session-reading-fork"
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

/** The navigation shortcut advertising each rail destination, for derived-digit display. */
export const RAIL_SHORTCUT_IDS = {
  inbox: "navigate-inbox",
  automations: "navigate-automations",
  runs: "navigate-runs",
  pods: "navigate-pods",
  runners: "navigate-connections",
  skills: "navigate-skills",
  projects: "navigate-projects",
  archived: "navigate-archived",
  usage: "navigate-usage",
} as const satisfies Record<GlobalViewName, ShortcutId>;

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "search",
    group: "Navigation",
    label: "Search",
    scope: "Global",
    binding: { key: "k", primary: true },
  },
  // The digits below are the DEFAULT configuration's bindings. At runtime the bare digits derive
  // solely from the visible rail order (#385, rail-preferences.ts): the shell's key handler and
  // the shortcut reference both read the derived mapping, so a reordered or hidden destination
  // renumbers everywhere at once and these table entries never disagree with a keycap. The
  // entries are built from the destination registry, so each is labelled with the destination's
  // one name (docs/design-system.md §4.1).
  ...GLOBAL_VIEW_ITEMS.map((item, index): ShortcutDefinition => ({
    id: RAIL_SHORTCUT_IDS[item.id],
    group: "Navigation",
    label: item.name,
    scope: "Global",
    binding: { key: String(index + 1), bare: true },
  })),
  {
    id: "toggle-sessions-view",
    group: "Navigation",
    label: "Toggle List / Board",
    scope: "Sessions",
    binding: { key: "b", bare: true },
  },
  {
    id: "open-settings",
    group: "Navigation",
    label: "Open Settings",
    scope: "Global",
    // On supported desktop layouts Shift+, is reported as KeyboardEvent.key "<". Keep the
    // matcher honest while displaying the physical key people press rather than "Shift+<".
    binding: { key: "<", shift: true, displayKey: "," },
  },
  {
    id: "focus-inbox-search",
    group: "Navigation",
    label: "Search Sessions",
    scope: "Global",
    binding: { key: "/", bare: true },
  },
  {
    id: "new-session",
    group: "Actions",
    label: "New Session",
    scope: "Global",
    binding: { key: "c", bare: true },
  },
  {
    id: "focus-next-zone",
    group: "Navigation",
    label: "Next Focus Zone",
    scope: "Global",
    binding: { key: "F6" },
  },
  {
    id: "focus-previous-zone",
    group: "Navigation",
    label: "Previous Focus Zone",
    scope: "Global",
    binding: { key: "F6", shift: true },
  },
  {
    id: "open-files",
    group: "Session",
    label: "Files Panel",
    scope: "Session",
    binding: { key: "p", primary: true },
  },
  {
    id: "open-review",
    group: "Session",
    label: "Review Panel",
    scope: "Session",
    binding: { key: "g", primary: true, shift: true },
  },
  {
    id: "toggle-terminal",
    group: "Session",
    label: "Toggle Terminal",
    scope: "Session",
    binding: { key: "`", primary: true },
  },
  {
    id: "submit-run",
    group: "Actions",
    label: "Start Multi-Agent Run",
    scope: "Run dialog",
    binding: { key: "Enter", primary: true },
  },
  {
    id: "relay-pod-note",
    group: "Actions",
    label: "Add Pod Note",
    scope: "Pod detail",
    binding: { key: "Enter", primary: true },
  },
  {
    id: "shortcut-reference",
    group: "Help",
    label: "Keyboard Shortcuts",
    scope: "Global",
    binding: { key: "?", shift: true, bare: true },
  },
  {
    id: "inbox-next",
    group: "Sessions List",
    label: "Next Session",
    scope: "Sessions List",
    binding: { key: "j", bare: true },
  },
  {
    id: "inbox-previous",
    group: "Sessions List",
    label: "Previous Session",
    scope: "Sessions List",
    binding: { key: "k", bare: true },
  },
  {
    id: "inbox-grid-next",
    group: "Sessions List",
    label: "Next Session (Grid)",
    scope: "Sessions List",
    binding: { key: "ArrowDown", bare: true, displayKey: "↓" },
  },
  {
    id: "inbox-grid-previous",
    group: "Sessions List",
    label: "Previous Session (Grid)",
    scope: "Sessions List",
    binding: { key: "ArrowUp", bare: true, displayKey: "↑" },
  },
  {
    id: "inbox-grid-first",
    group: "Sessions List",
    label: "First Session (Grid)",
    scope: "Sessions List",
    binding: { key: "Home", bare: true },
  },
  {
    id: "inbox-expand",
    group: "Sessions List",
    label: "Expand Session",
    scope: "Sessions List",
    binding: { key: "Enter", bare: true },
  },
  {
    id: "inbox-open-top-request",
    group: "Sessions List",
    label: "Open Top Request",
    scope: "Sessions List",
    binding: { key: "F2", bare: true },
  },
  {
    id: "inbox-toggle-thread",
    group: "Sessions List",
    label: "Toggle Thread",
    scope: "Sessions List",
    binding: { key: "t", bare: true },
  },
  {
    id: "inbox-toggle-all-threads",
    group: "Sessions List",
    label: "Toggle All Threads",
    scope: "Sessions List",
    binding: { key: "t", shift: true, bare: true },
  },
  {
    id: "inbox-go-to-parent",
    group: "Sessions List",
    label: "Go to Parent",
    scope: "Sessions List",
    binding: { key: "p", bare: true },
  },
  {
    id: "inbox-expand-thread",
    group: "Sessions List",
    label: "Expand Thread",
    scope: "Sessions List",
    binding: { key: "ArrowRight", bare: true, displayKey: "→" },
  },
  {
    id: "inbox-collapse-thread",
    group: "Sessions List",
    label: "Collapse Thread",
    scope: "Sessions List",
    binding: { key: "ArrowLeft", bare: true, displayKey: "←" },
  },
  {
    id: "inbox-fork",
    group: "Sessions List",
    label: "Fork Conversation",
    scope: "Sessions List",
    binding: { key: "f", bare: true },
  },
  {
    id: "inbox-next-split",
    group: "Sessions List",
    label: "Next Split",
    scope: "Sessions List",
    binding: { key: "Tab", bare: true },
  },
  {
    id: "inbox-previous-split",
    group: "Sessions List",
    label: "Previous Split",
    scope: "Sessions List",
    binding: { key: "Tab", shift: true, bare: true },
  },
  {
    id: "inbox-approve",
    group: "Sessions List",
    label: "Approve Request",
    scope: "Sessions List",
    binding: { key: "a", bare: true },
  },
  {
    id: "inbox-deny",
    group: "Sessions List",
    label: "Deny Request",
    scope: "Sessions List",
    binding: { key: "d", bare: true },
  },
  {
    id: "inbox-archive",
    group: "Sessions List",
    label: "Archive Session",
    scope: "Sessions List",
    binding: { key: "e", bare: true },
  },
  {
    id: "inbox-snooze",
    group: "Sessions List",
    label: "Snooze Session",
    scope: "Sessions List",
    binding: { key: "h", bare: true },
  },
  {
    id: "inbox-pin",
    group: "Sessions List",
    label: "Pin Session",
    scope: "Sessions List",
    binding: { key: "s", bare: true },
  },
  {
    id: "inbox-unread",
    group: "Sessions List",
    label: "Mark Unread",
    scope: "Sessions List",
    binding: { key: "u", bare: true },
  },
  {
    id: "inbox-reply",
    group: "Sessions List",
    label: "Reply to Session",
    scope: "Sessions List",
    binding: { key: "r", bare: true },
  },
  {
    id: "inbox-page-down",
    group: "Sessions List",
    label: "Page Down",
    scope: "Sessions List",
    binding: { key: " ", bare: true },
  },
  {
    id: "inbox-page-up",
    group: "Sessions List",
    label: "Page Up",
    scope: "Sessions List",
    binding: { key: " ", shift: true, bare: true },
  },
  {
    id: "inbox-follow-latest",
    group: "Sessions List",
    label: "Jump to Latest",
    scope: "Sessions List",
    binding: { key: "g", shift: true, bare: true },
  },
  {
    id: "inbox-follow-latest-end",
    group: "Sessions List",
    label: "Last Session / Jump to Latest",
    scope: "Sessions List",
    binding: { key: "End", bare: true },
  },
  {
    id: "session-reading-line-down",
    group: "Session Reading",
    label: "Scroll Down",
    scope: "Session Reading",
    binding: { key: "j", bare: true },
  },
  {
    id: "session-reading-line-up",
    group: "Session Reading",
    label: "Scroll Up",
    scope: "Session Reading",
    binding: { key: "k", bare: true },
  },
  {
    id: "session-reading-page-down",
    group: "Session Reading",
    label: "Page Down",
    scope: "Session Reading",
    binding: { key: " ", bare: true },
  },
  {
    id: "session-reading-page-up",
    group: "Session Reading",
    label: "Page Up",
    scope: "Session Reading",
    binding: { key: " ", shift: true, bare: true },
  },
  {
    id: "session-reading-start",
    group: "Session Reading",
    label: "Session Start",
    scope: "Session Reading",
    binding: { key: "g", bare: true, sequence: ["g", "g"] },
  },
  {
    id: "session-reading-latest",
    group: "Session Reading",
    label: "Jump to Latest",
    scope: "Session Reading",
    binding: { key: "g", shift: true, bare: true },
  },
  {
    id: "session-reading-latest-end",
    group: "Session Reading",
    label: "Jump to Latest (End)",
    scope: "Session Reading",
    binding: { key: "End", bare: true },
  },
  {
    id: "session-reading-next-session",
    group: "Session Reading",
    label: "Next Session",
    scope: "Session Reading",
    // Alt/Option+Arrow on every platform: a literal Ctrl+J/K pair made Previous Session shadow
    // Search's Ctrl+K on Windows and Linux (#2080). KeyboardEvent.key is the same arrow everywhere.
    binding: { key: "ArrowDown", alt: true, displayKey: "↓" },
  },
  {
    id: "session-reading-previous-session",
    group: "Session Reading",
    label: "Previous Session",
    scope: "Session Reading",
    binding: { key: "ArrowUp", alt: true, displayKey: "↑" },
  },
  {
    id: "session-reading-approve",
    group: "Session Reading",
    label: "Approve Request",
    scope: "Session Reading",
    binding: { key: "a", bare: true },
  },
  {
    id: "session-reading-deny",
    group: "Session Reading",
    label: "Deny Request",
    scope: "Session Reading",
    binding: { key: "d", bare: true },
  },
  {
    id: "session-reading-archive",
    group: "Session Reading",
    label: "Archive and Advance",
    scope: "Session Reading",
    binding: { key: "e", bare: true },
  },
  {
    id: "session-reading-snooze",
    group: "Session Reading",
    label: "Snooze Session",
    scope: "Session Reading",
    binding: { key: "h", bare: true },
  },
  {
    id: "session-reading-fork",
    group: "Session Reading",
    label: "Fork Conversation",
    scope: "Session Reading",
    binding: { key: "f", bare: true },
  },
  {
    id: "session-reading-reply",
    group: "Session Reading",
    label: "Reply to Session",
    scope: "Session Reading",
    binding: { key: "r", bare: true },
  },
  {
    id: "steer-turn",
    group: "Session",
    label: "Steer Active Turn",
    scope: "Session",
    binding: { key: "Enter", ctrl: true },
  },
  {
    id: "stop-turn",
    group: "Session",
    label: "Stop Turn",
    scope: "Session",
    binding: { key: "Escape", shift: true },
  },
  {
    id: "exit-terminal",
    group: "Session",
    label: "Exit Terminal Focus",
    scope: "Session",
    binding: { key: "Escape", ctrl: true },
  },
] as const;

/** The reference's default group order: the two small groups everyone needs, then the contextual ones. */
export const SHORTCUT_GROUPS = ["Navigation", "Actions", "Sessions List", "Session Reading", "Session", "Help"] as const;

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

/** A bare digit press under the same gating as every other bare binding, or null. */
export function bareDigitPressed(
  event: KeyboardLike,
  targetDocument: ActiveElementDocument | undefined = typeof document === "undefined" ? undefined : document,
): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (!/^[0-9]$/.test(event.key)) return null;
  if (inTypingContext(targetDocument)) return null;
  return event.key;
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

/** The binding as an `aria-keyshortcuts` value: UI Events modifier names joined by "+". */
export function shortcutAriaKeys(id: ShortcutId, mac = isMacPlatform()): string {
  const { binding } = shortcut(id);
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Control");
  else if (binding.primary) parts.push(mac ? "Meta" : "Control");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(binding.key === " " ? "Space" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join("+");
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

/** The rail destination a navigation shortcut advertises, or null for every other binding. */
export function railViewForShortcut(id: ShortcutId): keyof typeof RAIL_SHORTCUT_IDS | null {
  for (const [name, shortcutId] of Object.entries(RAIL_SHORTCUT_IDS)) {
    if (shortcutId === id) return name as keyof typeof RAIL_SHORTCUT_IDS;
  }
  return null;
}

/** What decides whether a binding works here. The reference reads it to explain a dead key. */
export type ShortcutAvailability = {
  sessionOpen: boolean;
  terminalSupported: boolean;
  filesSupported: boolean;
  conversationSteeringSupported?: boolean;
  turnInterruptionSupported?: boolean;
  experimentFlags?: ExperimentFlags;
  /** Rail destinations hidden by preference (#385); their digits are unassigned, not dead. */
  hiddenRailViews?: ReadonlySet<string>;
};

/** Why a whole group cannot be used here, said once under its heading, or null. */
export function shortcutGroupUnavailableReason(
  group: ShortcutGroup,
  context: Pick<ShortcutAvailability, "sessionOpen">,
): string | null {
  if ((group === "Session" || group === "Session Reading") && !context.sessionOpen) {
    return "Open a session to use these.";
  }
  return null;
}

/** Why this one binding cannot be used here, beyond what its group already says, or null. */
export function shortcutUnavailableReason(definition: ShortcutDefinition, context: ShortcutAvailability): string | null {
  const railView = railViewForShortcut(definition.id);
  if (railView && context.hiddenRailViews?.has(railView)) {
    return "Hidden in Settings → Appearance";
  }
  const experiment = EXPERIMENT_SHORTCUT_IDS[definition.id];
  if (experiment && context.experimentFlags && !context.experimentFlags[experiment]) {
    return "Turned off in Settings → Experimental";
  }
  // The row names the feature, so the reason only has to say whose fault it is. It stays short
  // enough to share the row's one line with the label and the keycap.
  const runnerSupport: Partial<Record<ShortcutId, boolean | undefined>> = {
    "toggle-terminal": context.terminalSupported,
    "open-files": context.filesSupported,
    "steer-turn": context.conversationSteeringSupported,
    "stop-turn": context.turnInterruptionSupported,
  };
  if (definition.id in runnerSupport && !runnerSupport[definition.id]) {
    return "Not supported by this runner";
  }
  return null;
}

/** The reference group a focus scope belongs to, or null for a page with no group of its own. */
export function shortcutGroupForScope(scope: ShortcutScope): ShortcutGroup | null {
  return scope === "Sessions List" || scope === "Session Reading" || scope === "Session" ? scope : null;
}

export type ShortcutReferenceRow = {
  id: ShortcutId;
  label: string;
  /** The keycap text, as the person sees it. */
  keys: string;
  /** A row-specific reason the binding is dead here; a whole group's reason is its `note`. */
  reason: string | null;
};

export type ShortcutReferenceGroup = {
  group: ShortcutGroup;
  /** The group for the page the reference was opened from ("Current Page"). */
  current: boolean;
  /** Why the whole group is unavailable here, or null. */
  note: string | null;
  rows: ShortcutReferenceRow[];
};

/** The two Session groups share some actions. A row there with the same label and keys as one
 * already listed is said once, in whichever of the two comes first. */
const MERGED_ROW_GROUPS: ReadonlySet<ShortcutGroup> = new Set(["Sessions List", "Session Reading"]);

/** Keys compare without spaces or "+", so "ctrl k" finds Ctrl+K. */
function compactKeys(text: string): string {
  return text.toLowerCase().replace(/[\s+]/g, "");
}

function matchesQuery(row: ShortcutReferenceRow, needle: string): boolean {
  if (!needle || row.label.toLowerCase().includes(needle)) return true;
  const keys = compactKeys(needle);
  return keys !== "" && compactKeys(row.keys).includes(keys);
}

/**
 * The Keyboard Shortcuts reference, in reading order: the group for the page it was opened from
 * first, then the default order. Rows say their label and keys once; a query keeps the rows whose
 * label or keys contain it, and a group with no row left is dropped.
 */
export function shortcutReferenceGroups({
  scope,
  availability,
  keys,
  query = "",
}: {
  scope: ShortcutScope;
  availability: ShortcutAvailability;
  keys: (definition: ShortcutDefinition) => string;
  query?: string;
}): ShortcutReferenceGroup[] {
  const current = shortcutGroupForScope(scope);
  const order = current ? [current, ...SHORTCUT_GROUPS.filter((group) => group !== current)] : [...SHORTCUT_GROUPS];
  const needle = query.trim().toLowerCase();
  const listed = new Set<string>();
  const groups: ShortcutReferenceGroup[] = [];
  for (const group of order) {
    const note = shortcutGroupUnavailableReason(group, availability);
    const rows: ShortcutReferenceRow[] = [];
    for (const definition of SHORTCUTS) {
      if (definition.group !== group) continue;
      const row: ShortcutReferenceRow = {
        id: definition.id,
        label: definition.label,
        keys: keys(definition),
        reason: note ? null : shortcutUnavailableReason(definition, availability),
      };
      if (MERGED_ROW_GROUPS.has(group)) {
        const identity = `${row.label}\n${row.keys}`;
        if (listed.has(identity)) continue;
        listed.add(identity);
      }
      if (matchesQuery(row, needle)) rows.push(row);
    }
    if (rows.length > 0) groups.push({ group, current: group === current, note, rows });
  }
  return groups;
}

export function shortcutLayerActive(document: Document, exceptPalette = false): boolean {
  const modal = exceptPalette ? '[aria-modal="true"]:not(.palette)' : '[aria-modal="true"]';
  return Boolean(document.querySelector(exceptPalette ? modal : `${modal}, [role="menu"], .menu[role="dialog"], .popover[role="dialog"]`));
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return typingElement(target);
}
