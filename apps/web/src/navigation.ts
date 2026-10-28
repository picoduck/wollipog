import { HistoryPositions, type HistoryTraversal, type PositionedHistory } from "./history-position.js";
import {
  parseSourceLocation,
  SOURCE_LOCATION_MAX_PATH_LENGTH,
  type SourceLocation,
} from "@wollipog/protocol";

/** `activationId` is ephemeral and deliberately omitted from viewPath: repeated activation of the
 * same stable deep link must re-focus its exact request without creating duplicate browser history. */
export type AttentionTarget = { eventEpoch: number; requestId?: string; activationId?: number };

export type View =
  | { name: "inbox"; split?: SessionsTab }
  | { name: "board"; split?: SessionsTab }
  | { name: "runners"; section?: ConnectionSection; machineId?: string }
  | { name: "runs" }
  | { name: "pods" }
  | { name: "automations"; editor?: AutomationEditorRoute; tab?: AutomationsTab }
  | { name: "automation"; id: string }
  | { name: "skills"; id?: string; pane?: SkillsPane }
  | { name: "usage" }
  | { name: "archived" }
  | { name: "projects"; id?: string; pane?: ProjectsPane }
  | { name: "session"; id: string; location?: SourceLocation; attention?: AttentionTarget }
  /** `member`: the comparison member a phone shows (#2975); wider layouts show every member. */
  | { name: "run"; id: string; member?: string }
  | { name: "settings"; section?: SettingsSection; policyId?: string; focus?: SettingsFocus }
  /** The tab a phone shows (#2981): the Huddle (`tab: "huddle"`, also the default) or one
   * `member`; wider layouts show the huddle beside every member. */
  | { name: "pod"; id: string; tab?: "huddle"; member?: string };

/**
 * Settings sections, as ROUTES rather than dialog tabs.
 *
 * §11.3: a dialog cannot be linked to, cannot be opened in a second tab, loses its place on every
 * breakpoint crossing, and stacks another modal on top of itself for the shortcut reference. Every
 * section is deep-linkable, which is what makes "see Settings → Appearance" a thing you can send
 * someone.
 */
export type SettingsSection = "appearance" | "notifications" | "behavior" | "approvals" | "reviews" | "orchestrator" | "network" | "storage" | "experimental" | "about";

/**
 * A control a redirect lands on, so an old link arrives where its setting went (#3023):
 * `/settings/keyboard` opens Behavior on the Keyboard Shortcuts row. Ephemeral like
 * `AttentionTarget.activationId`: `viewPath` omits it, so the replaced address is the section's.
 * The store gives each arrival its own `activationId`, so arriving again focuses it again.
 */
export type SettingsFocusTarget = "keyboard-shortcuts";
export type SettingsFocus = { target: SettingsFocusTarget; activationId?: number };

/** Old Settings addresses and the view each now opens; each replaces its own history entry. */
const SETTINGS_ALIASES: Readonly<Record<string, View>> = {
  // Session Naming lives compactly under Behavior.
  "/settings/session-naming": { name: "settings", section: "behavior" },
  // Keyboard folded into Behavior › Input (#3023): the old section's address lands on its one row.
  "/settings/keyboard": { name: "settings", section: "behavior", focus: { target: "keyboard-shortcuts" } },
};

/** Whether `path` is an old Settings address that opens another view (see `SETTINGS_ALIASES`). */
export function isSettingsAlias(path: string): boolean {
  return Object.hasOwn(SETTINGS_ALIASES, path);
}

/** Where a section's settings are kept, when every one of them is kept in the same place. */
export type SettingsScope = "This Device" | "Your Account" | "Your Organization";

export interface SettingsSectionEntry {
  id: SettingsSection;
  title: string;
  /** One line in user terms: under the section's title, and as its row's second line on a phone. */
  description: string;
  /**
   * The panel head's own sentence, where the section has more to say there than a phone's index row
   * holds. The panel head hides its description on phones, so this is never truncated.
   */
  panelDescription?: string;
  /**
   * Named once in the section's head (§11.3 meta). Absent where the section's groups are kept in
   * different places, or where it keeps nothing.
   */
  scope?: SettingsScope;
}

/**
 * What turning an experiment off does. Experimental's panel head says it, and so does its group on a
 * phone, where the head's description is hidden (#3139).
 */
export const EXPERIMENT_OFF_EFFECT = "Turning one off hides it from navigation and search.";

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSectionEntry> = [
  { id: "appearance", title: "Appearance", description: "Theme, colors, density and navigation.", scope: "This Device" },
  {
    id: "notifications",
    title: "Notifications",
    description: "Alerts when a session needs you.",
    panelDescription: "Alerts for approvals and finished turns.",
    scope: "This Device",
  },
  { id: "behavior", title: "Behavior", description: "Typing, privacy and agent defaults." },
  { id: "approvals", title: "Approvals", description: "Question answers and tool policies." },
  { id: "reviews", title: "Reviews", description: "Reviewers, rounds and project overrides.", scope: "Your Account" },
  // No scope: the panel names where its defaults come from instead, "Your Defaults" or "Wollipog
  // Defaults", once it has loaded them (#3026).
  { id: "orchestrator", title: "Orchestrator", description: "Defaults for sessions that run others." },
  { id: "network", title: "Network", description: "Reach this machine from other devices." },
  {
    id: "storage",
    title: "Storage",
    description: "Session and workflow history.",
    panelDescription: "How long archived sessions and completed workflows keep their full history in this control plane. Capable machines also trim archived session logs.",
    scope: "Your Organization",
  },
  {
    id: "experimental",
    title: "Experimental",
    description: "Features that are still being tested.",
    panelDescription: `Early features. ${EXPERIMENT_OFF_EFFECT}`,
    scope: "This Device",
  },
  { id: "about", title: "About", description: "Versions and updates." },
];

/**
 * Settings › Approvals scrolled to one governance policy's row (#2158). Decision Records, request
 * cards and Decision History link a policy's name here; the row carries
 * `approvalsPolicyAnchorId(policyId)` so the same policy is found again from its id alone.
 */
export function approvalsPolicyView(policyId: string): View {
  return { name: "settings", section: "approvals", policyId };
}

/** The DOM id of a policy's row in Settings › Approvals: stable, and safe in a URL fragment or a
 * CSS selector whatever the policy id contains. */
export function approvalsPolicyAnchorId(policyId: string): string {
  return `approvals-policy-${encodeResourceId(policyId)}`;
}

export type ConnectionSection = "instances" | "machines" | "people";

/**
 * The Automation editor's two routes (#2967): `/automations/new` and `/automations/~<id>/edit`. A
 * route rather than a card in the list, so the editor has an address, a reload keeps it and Back
 * leaves it.
 */
export type AutomationEditorRoute = { kind: "new" } | { kind: "edit"; automationId: string };

/**
 * The Automations page's tabs (#2969): the list at `/automations`, and Outbound Events at
 * `/automations/outbound`. Absent is the list; the editor routes have no tab.
 */
export type AutomationsTab = "outbound";

/**
 * Agent Skills panes that are not a skill (docs/design-system.md §6): the Orphaned Copies pane and
 * the Library Overview. A skill id wins over a pane, so a view never names both. `/skills` itself
 * shows the list with the default detail; `/skills/overview` is the same content as its own route,
 * which is what a phone opens from the list (§6.2).
 */
export type SkillsPane = "orphans" | "overview";

/**
 * The Projects pane that is not a project (#2958): the Projects Overview. `/projects` shows the list
 * with the overview beside it; `/projects/overview` is the same content as its own route, which is
 * what a phone opens from the list (§6.2). A project id wins over the pane.
 */
export type ProjectsPane = "overview";

export type GlobalViewName = Extract<View["name"], "inbox" | "projects" | "runs" | "pods" | "automations" | "usage" | "runners" | "archived" | "skills">;

export type DestinationGroup = "work" | "oversight" | "records";

export interface GlobalViewItem {
  /** The internal destination id. Routes, rail preferences and digits key on it, never on `name`. */
  id: GlobalViewName;
  /**
   * The destination's one name (docs/design-system.md §4.1). The rail's accessible name and
   * tooltip, the page title, the phone app bar, the More sheet, the palette, the shortcut
   * reference and the Settings › Navigation row all read it, so none of them can disagree.
   */
  name: string;
  /** One line, at most 80 characters, in user terms (§4.2, §17.2). Hidden on phones. */
  description?: string;
  /** The rail group the destination belongs to (§4.1). */
  group: DestinationGroup;
}

/** One vocabulary for every global destination, shared by the rail, header, and palette.
 *
 * The board is deliberately NOT a destination: it is the board mode of Sessions (the `inbox`
 * entry), reachable through the in-view toggle, the `b` shortcut, `/board`, and the palette's
 * extra Board entry below. The `inbox` id is retained internally so saved preferences and
 * routes survive the visible rename to Sessions.
 *
 * Ordered in the three groups of §4.1 — Work, Oversight, Records — because the rail numbers
 * double as the bare digit shortcuts: position IS the binding, so the order is a product
 * decision, not alphabetical. Only the default follows this list: a saved rail order is kept
 * as it was saved (rail-preferences.ts). */
export const GLOBAL_VIEW_ITEMS: ReadonlyArray<GlobalViewItem> = [
  { id: "inbox", name: "Sessions", group: "work" },
  {
    id: "automations",
    name: "Automations",
    description: "Run a prompt on a schedule, from a webhook, or from a chat message.",
    group: "work",
  },
  {
    id: "projects",
    name: "Projects",
    description: "Group related sessions and choose the folders where they run.",
    group: "work",
  },
  {
    id: "runs",
    name: "Multi-Agent Runs",
    description: "Give one task to several agents and compare what each one does.",
    group: "oversight",
  },
  {
    id: "pods",
    name: "Pods",
    description: "Agents that share notes and a worktree while they work toward one objective.",
    group: "oversight",
  },
  { id: "runners", name: "Connections", group: "oversight" },
  {
    id: "skills",
    name: "Agent Skills",
    description: "Write a skill once, then choose which machines and agents get it.",
    group: "oversight",
  },
  { id: "archived", name: "Archived Sessions", group: "records" },
  {
    id: "usage",
    name: "Usage and Cost",
    description: "What your agents spent, by day, agent and project.",
    group: "records",
  },
];

/** The registry entry for a destination. */
export function destination(id: GlobalViewName): GlobalViewItem {
  return GLOBAL_VIEW_ITEMS.find((item) => item.id === id)!;
}

/** "Back to <Destination>": the name of every back control that returns to a destination. */
export function backLabel(id: GlobalViewName): string {
  return `Back to ${destination(id).name}`;
}

/** What an entity page is called until its entity has loaded. */
export const ENTITY_FALLBACK_TITLES = {
  session: "Session",
  run: "Multi-Agent Run",
  pod: "Pod",
  automation: "Automation",
} as const;

/**
 * The page title for any view.
 *
 * Deliberately exhaustive rather than a chain ending in a default: the previous chain named four
 * views and fell through to "Run", so Settings — added later — announced `<h1>Run</h1>` on every
 * one of its six routes. With no default branch, the next view that is added fails to compile
 * until it has a title.
 *
 * An entity page is titled by its entity: pass the loaded session's, run's or pod's own title.
 * The generic noun is only the fallback while it loads.
 */
export function viewTitle(view: View, entityTitle?: string | null): string {
  switch (view.name) {
    // Board mode belongs to the Sessions destination; its page title matches the rail name.
    case "board":
      return destination("inbox").name;
    case "automations":
      // The editor is titled by what it edits; the list by its destination.
      if (view.editor?.kind === "new") return "New Automation";
      if (view.editor?.kind === "edit") return entityTitle ? `Edit ${entityTitle}` : "Edit Automation";
      return destination(view.name).name;
    case "inbox":
    case "projects":
    case "runs":
    case "pods":
    case "usage":
    case "runners":
    case "archived":
    case "skills":
      // Named once, in the list the rail and palette already read, so the surfaces cannot drift
      // apart.
      return destination(view.name).name;
    case "session":
    case "run":
    case "pod":
    case "automation":
      return entityTitle || ENTITY_FALLBACK_TITLES[view.name];
    // The section is the <h2> inside the page; repeating it here would say it twice.
    case "settings": return "Settings";
  }
  // No default branch: this line stops compiling when a view is added without a title.
  const unhandled: never = view;
  return unhandled;
}

/**
 * The view as the subject of a sentence ("Automations Couldn't Be Shown"). A destination reads as
 * its page title; one item of a kind reads as "This Session", since "Session Couldn't Be Shown"
 * names a type rather than the thing on screen.
 */
export function viewSubjectName(view: View): string {
  if (view.name === "session" || view.name === "run" || view.name === "pod" || view.name === "automation") {
    return `This ${viewTitle(view)}`;
  }
  return viewTitle(view);
}

/**
 * Destinations the palette's Go To offers that the rail does not render as its own item.
 *
 * Settings is reachable by a dedicated gear rather than a rail row, so it is absent from
 * GLOBAL_VIEW_ITEMS — and the palette, which derived its whole fixed list from that array, had no
 * way to reach it. Appending it to the rail list instead would have made the rail render a second
 * Settings entry beside the gear. Each section is named by itself, with "Settings" as its second
 * line (#1978). The board is not here: it is a mode of Sessions, which the palette's Actions switch.
 */
export const EXTRA_PALETTE_DESTINATIONS: ReadonlyArray<{ label: string; detail?: string; view: View }> = [
  { label: "Settings", view: { name: "settings" } },
  ...SETTINGS_SECTIONS.map((section) => ({
    label: section.title,
    detail: "Settings",
    view: { name: "settings" as const, section: section.id },
  })),
];

const MAX_RESOURCE_ID_LENGTH = 256;

/** Exact UTF-16LE base64url is deliberately alphabet-only: browsers, proxies, Fastify's static
 * fallback, and URL normalizers cannot reinterpret opaque `/`, `.`, `..`, `?`, or `#` content. */
function encodeOpaque(value: string): string {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >>> 8);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeOpaque(encodedId: string, maxLength: number): string | null {
  if (!encodedId || !/^[A-Za-z0-9_-]+$/.test(encodedId)) return null;
  try {
    const padded = encodedId.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (encodedId.length % 4)) % 4);
    const binary = atob(padded);
    if (binary.length % 2 !== 0) return null;
    let id = "";
    for (let i = 0; i < binary.length; i += 2) {
      id += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
    }
    if (!id.trim() || id.length > maxLength || encodeOpaque(id) !== encodedId) return null;
    return id;
  } catch {
    return null;
  }
}

export function encodeResourceId(id: string): string {
  return encodeOpaque(id);
}

export function decodeResourceId(encodedId: string): string | null {
  return decodeOpaque(encodedId, MAX_RESOURCE_ID_LENGTH);
}

export function sameView(a: View, b: View): boolean {
  return a.name === b.name && viewPath(a) === viewPath(b);
}

/**
 * A Sessions tab (an Inbox split key), or null for All. Tabs change the URL (docs/design-system.md
 * §10.1); a Sessions link without a tab opens the tab last used on this device, as every link did
 * before the tab was written.
 */
export type SessionsTab = string | null;

const SESSIONS_TAB_PARAM = "tab";
/** Split keys always carry a `:` or a leading space, so this never names a real split. */
const SESSIONS_TAB_ALL = "all";
const SESSIONS_TAB_MAX_LENGTH = 512;

function sessionsTabSearch(split: SessionsTab | undefined): string {
  if (split === undefined) return "";
  return `?${new URLSearchParams({ [SESSIONS_TAB_PARAM]: split ?? SESSIONS_TAB_ALL }).toString()}`;
}

/** The tab a Sessions URL names: undefined when it names none or its query is not a tab. */
function sessionsTabFromSearch(search: string): SessionsTab | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== SESSIONS_TAB_PARAM) return undefined;
  const split = params.get(SESSIONS_TAB_PARAM) ?? "";
  if (split === "" || split.length > SESSIONS_TAB_MAX_LENGTH) return undefined;
  return split === SESSIONS_TAB_ALL ? null : split;
}

function sessionsView(name: "inbox" | "board", search: string): View {
  const split = sessionsTabFromSearch(search);
  // A query that is not a tab keeps the view it always opened rather than failing the route.
  return split === undefined ? { name } : { name, split };
}

function sourceLocationSearch(location: SourceLocation): string {
  const params = new URLSearchParams();
  if (location.line !== undefined) params.set("line", String(location.line));
  if (location.column !== undefined) params.set("column", String(location.column));
  if (location.symbol !== undefined) params.set("symbol", location.symbol);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function viewPath(view: View): string {
  switch (view.name) {
    case "inbox": return `/${sessionsTabSearch(view.split)}`;
    case "board": return `/board${sessionsTabSearch(view.split)}`;
    // A machine is selected on the Machines tab alone (#2985), so a machine id names that tab.
    case "runners": return view.machineId !== undefined
      ? `/connections/machines/~${encodeResourceId(view.machineId)}`
      : `/connections/${view.section ?? "machines"}`;
    case "runs": return "/runs";
    case "pods": return "/pods";
    case "automations": return view.editor?.kind === "new" ? "/automations/new"
      : view.editor?.kind === "edit" ? `/automations/~${encodeResourceId(view.editor.automationId)}/edit`
        : view.tab === "outbound" ? "/automations/outbound" : "/automations";
    case "automation": return `/automations/~${encodeResourceId(view.id)}`;
    case "skills": return view.id ? `/skills/~${encodeResourceId(view.id)}` : view.pane ? `/skills/${view.pane}` : "/skills";
    case "usage": return "/usage";
    case "archived": return "/archived";
    case "projects": return view.id ? `/projects/~${encodeResourceId(view.id)}` : view.pane ? `/projects/${view.pane}` : "/projects";
    case "session": return view.location
      ? `/sessions/~${encodeResourceId(view.id)}/files/~${encodeOpaque(view.location.path)}${sourceLocationSearch(view.location)}`
      : view.attention
      ? `/sessions/~${encodeResourceId(view.id)}/attention${view.attention.requestId === undefined ? "" : `/~${encodeOpaque(view.attention.requestId)}`}?epoch=${view.attention.eventEpoch}`
      : `/sessions/~${encodeResourceId(view.id)}`;
    case "run": return `/runs/~${encodeResourceId(view.id)}${runMemberSearch(view.member)}`;
    case "settings": return view.section === "approvals" && view.policyId !== undefined
      ? `/settings/approvals/~${encodeResourceId(view.policyId)}`
      : view.section ? `/settings/${view.section}` : "/settings";
    case "pod": return `/pods/~${encodeResourceId(view.id)}${podTabSearch(view)}`;
  }
}

function locationFromSearch(path: string, search: string): SourceLocation | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];
  if (keys.some((key) => !["line", "column", "symbol"].includes(key)) || new Set(keys).size !== keys.length) return null;
  const coordinate = (key: "line" | "column"): number | undefined | null => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const line = coordinate("line");
  const column = coordinate("column");
  if (line === null || column === null) return null;
  const symbol = params.get("symbol") ?? undefined;
  return parseSourceLocation({
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(symbol === undefined ? {} : { symbol }),
  });
}

const RUN_MEMBER_PARAM = "member";

function runMemberSearch(member: string | undefined): string {
  return member === undefined ? "" : `?${new URLSearchParams({ [RUN_MEMBER_PARAM]: member }).toString()}`;
}

/** The member a run URL names: undefined when it names none or its query is not a member. */
function runMemberFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== RUN_MEMBER_PARAM) return undefined;
  const member = params.get(RUN_MEMBER_PARAM) ?? "";
  return !member.trim() || member.length > MAX_RESOURCE_ID_LENGTH ? undefined : member;
}

const POD_TAB_PARAM = "tab";
const POD_TAB_HUDDLE = "huddle";

function podTabSearch(view: { tab?: "huddle"; member?: string }): string {
  if (view.member !== undefined) return runMemberSearch(view.member);
  return view.tab === POD_TAB_HUDDLE ? `?${new URLSearchParams({ [POD_TAB_PARAM]: POD_TAB_HUDDLE }).toString()}` : "";
}

/** The tab a pod URL names: the Huddle, one member, or neither when its query is anything else. */
function podTabFromSearch(search: string): { tab: "huddle" } | { member: string } | Record<string, never> {
  const member = runMemberFromSearch(search);
  if (member !== undefined) return { member };
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];
  return keys.length === 1 && keys[0] === POD_TAB_PARAM && params.get(POD_TAB_PARAM) === POD_TAB_HUDDLE
    ? { tab: POD_TAB_HUDDLE }
    : {};
}

function resourceView(kind: "sessions" | "runs" | "pods", encodedId: string, search: string): View | null {
  const id = decodeResourceId(encodedId);
  if (id === null) return null;
  if (kind === "sessions") return { name: "session", id };
  if (kind === "runs") {
    // A query that is not a member keeps the run open rather than failing the route.
    const member = runMemberFromSearch(search);
    return member === undefined ? { name: "run", id } : { name: "run", id, member };
  }
  // As for a run, a query that names no tab keeps the pod open on its default tab.
  return { name: "pod", id, ...podTabFromSearch(search) };
}

/** Parse only the dashboard's explicit route vocabulary. Unknown and malformed paths are not
 * treated as view ids, which keeps typos and encoded slashes from selecting surprising state. */
export function viewFromPath(pathname: string, search = ""): View | null {
  const path = pathname.length > 1 ? (pathname.replace(/\/+$/, "") || "/") : pathname;
  if (path === "/" || path.toLowerCase() === "/index.html" || path === "/inbox") return sessionsView("inbox", search);
  if (path === "/board") return sessionsView("board", search);
  // /runners was the canonical route before the user-facing Connections rename. Keep existing
  // bookmarks valid while all newly-generated URLs consistently use /connections.
  if (path === "/connections" || path === "/runners") return { name: "runners", section: "machines" };
  const connectionsMatch = /^\/connections\/(instances|machines|people)$/.exec(path);
  if (connectionsMatch) {
    return { name: "runners", section: connectionsMatch[1] as ConnectionSection };
  }
  const machineMatch = /^\/connections\/machines\/~([^/]+)$/.exec(path);
  if (machineMatch) {
    const machineId = decodeResourceId(machineMatch[1]!);
    return machineId === null ? null : { name: "runners", section: "machines", machineId };
  }
  if (path === "/runs") return { name: "runs" };
  if (path === "/pods") return { name: "pods" };
  if (path === "/automations") return { name: "automations" };
  if (path === "/automations/new") return { name: "automations", editor: { kind: "new" } };
  if (path === "/automations/outbound") return { name: "automations", tab: "outbound" };
  const automationEditMatch = /^\/automations\/~([^/]+)\/edit$/.exec(path);
  if (automationEditMatch) {
    const automationId = decodeResourceId(automationEditMatch[1]!);
    return automationId === null ? null : { name: "automations", editor: { kind: "edit", automationId } };
  }
  const automationMatch = /^\/automations\/~([^/]+)$/.exec(path);
  if (automationMatch) {
    const id = decodeResourceId(automationMatch[1]!);
    return id === null ? null : { name: "automation", id };
  }
  if (path === "/skills") return { name: "skills" };
  const skillsPaneMatch = /^\/skills\/(orphans|overview)$/.exec(path);
  if (skillsPaneMatch) return { name: "skills", pane: skillsPaneMatch[1] as SkillsPane };
  const skillMatch = /^\/skills\/~([^/]+)$/.exec(path);
  if (skillMatch) {
    const id = decodeResourceId(skillMatch[1]!);
    return id === null ? null : { name: "skills", id };
  }
  if (path === "/usage") return { name: "usage" };
  if (path === "/archived") return { name: "archived" };
  // No section: a phone shows the section index, and wider layouts open the first section (§6.1, §6.2).
  if (path === "/settings") return { name: "settings" };
  // Keep old bookmarks useful: a copy, so a caller that annotates the view cannot change the table.
  if (isSettingsAlias(path)) return structuredClone(SETTINGS_ALIASES[path]!);
  const settingsMatch = /^\/settings\/(appearance|notifications|behavior|approvals|orchestrator|network|storage|experimental|about)$/.exec(path);
  if (settingsMatch) return { name: "settings", section: settingsMatch[1] as SettingsSection };
  const approvalsPolicyMatch = /^\/settings\/approvals\/~([^/]+)$/.exec(path);
  if (approvalsPolicyMatch) {
    const policyId = decodeResourceId(approvalsPolicyMatch[1]!);
    return policyId === null ? null : approvalsPolicyView(policyId);
  }
  if (path === "/projects") return { name: "projects" };
  if (path === "/projects/overview") return { name: "projects", pane: "overview" };
  const projectMatch = /^\/projects\/~([^/]+)$/.exec(path);
  if (projectMatch) {
    const id = decodeResourceId(projectMatch[1]!);
    return id === null ? null : { name: "projects", id };
  }
  const attentionMatch = /^\/sessions\/~([^/]+)\/attention(?:\/~([^/]+))?$/.exec(path);
  if (attentionMatch) {
    const id = decodeResourceId(attentionMatch[1]!);
    const requestId = attentionMatch[2] === undefined ? undefined : decodeOpaque(attentionMatch[2], 2048);
    const params = new URLSearchParams(search);
    const epoch = params.get("epoch");
    if (id === null || requestId === null || [...params.keys()].length !== 1 ||
        epoch === null || !/^(0|[1-9]\d*)$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) return null;
    return { name: "session", id, attention: { eventEpoch: Number(epoch), ...(requestId === undefined ? {} : { requestId }) } };
  }
  const fileMatch = /^\/sessions\/~([^/]+)\/files\/~([^/]+)$/.exec(path);
  if (fileMatch) {
    const id = decodeResourceId(fileMatch[1]!);
    const sourcePath = decodeOpaque(fileMatch[2]!, SOURCE_LOCATION_MAX_PATH_LENGTH);
    if (id === null || sourcePath === null) return null;
    const location = locationFromSearch(sourcePath, search);
    return location ? { name: "session", id, location } : null;
  }
  const match = /^\/(sessions|runs|pods)\/~([^/]+)$/.exec(path);
  return match ? resourceView(match[1] as "sessions" | "runs" | "pods", match[2]!, search) : null;
}

/** Compatibility bridge for notification links created by older service workers. */
export function legacyViewFromFragment(hash: string): View | null {
  if (hash.startsWith("#open=")) {
    let id: string;
    try {
      id = decodeURIComponent(hash.slice("#open=".length));
    } catch {
      return null;
    }
    return !id.trim() || id.length > MAX_RESOURCE_ID_LENGTH ? null : { name: "session", id };
  }
  return hash === "#view=automations" ? { name: "automations" } : null;
}

export function absoluteViewUrl(origin: string, view: View): string {
  return new URL(viewPath(view), origin).href;
}

export function viewFromNotificationMessage(data: unknown): View | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; sessionId?: unknown; eventEpoch?: unknown; requestId?: unknown };
  const opensSession = message.type === "mam:open-session" || message.type === "wollipog:open-session";
  if (opensSession && typeof message.sessionId === "string" &&
      message.sessionId.trim() && message.sessionId.length <= MAX_RESOURCE_ID_LENGTH) {
    const hasAttention = Object.hasOwn(message, "eventEpoch") || Object.hasOwn(message, "requestId");
    if (!hasAttention) return { name: "session", id: message.sessionId };
    if (!Number.isSafeInteger(message.eventEpoch) || (message.eventEpoch as number) < 0) return null;
    if (message.requestId !== undefined &&
        (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > MAX_RESOURCE_ID_LENGTH)) return null;
    return { name: "session", id: message.sessionId, attention: {
      eventEpoch: message.eventEpoch as number,
      ...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}),
    } };
  }
  return message.type === "mam:open-automations" || message.type === "wollipog:open-automations"
    ? { name: "automations" }
    : null;
}

/** The isolated public-share boot has no StoreProvider listener. Give it a small navigation-only
 * listener so a notification focused onto that controlled window still reaches the authenticated
 * dashboard destination instead of being silently swallowed. */
export function isolatedNotificationNavigationHandler(
  navigate: (path: string) => void,
): (event: Pick<MessageEvent, "data">) => void {
  return (event) => {
    const view = viewFromNotificationMessage(event.data);
    if (view) navigate(viewPath(view));
  };
}

export function replaceIsolatedShareWithDashboard(
  target: Pick<Window, "history" | "location">,
  path: string,
): void {
  // Scrub the retained capability immediately, then replace (rather than assign) the share entry.
  // This prevents Back/Forward cache traversal from restoring the live React tree and its in-memory
  // capability after a notification transfers the window into the authenticated dashboard.
  target.history.replaceState(null, "", `${target.location.pathname}${target.location.search}`);
  target.location.replace(path);
}

/** Replace a legacy notification fragment before React boots so the first render already targets
 * the canonical route and the fragment never survives in history or copied links. */
export function adoptLegacyNavigationFragment(): boolean {
  const view = legacyViewFromFragment(window.location.hash);
  if (!view) return false;
  window.history.replaceState(window.history.state, "", viewPath(view));
  return true;
}

export interface NavigationWindow {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: PositionedHistory;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface NavigateOptions {
  /**
   * Replace the current history entry instead of adding one: for a route that cannot be shown here
   * and lands somewhere else (Connections › Instances on a phone), so Back does not return to it.
   */
  replace?: boolean;
}

export interface ViewNavigation {
  current(): View;
  push(view: View): void;
  /** Absent in a harness that only records pushes; the store pushes instead. */
  replace?(view: View): void;
  /** Browser Back and Forward. A move that can be held comes with its traversal (#3218). */
  listen(onView: (view: View, traversal?: HistoryTraversal) => void): () => void;
  activate?(view: View): void;
}

export class BrowserNavigation implements ViewNavigation {
  private readonly positions: HistoryPositions;

  constructor(private readonly target: NavigationWindow = window) {
    this.positions = new HistoryPositions(target.history);
  }

  current(): View {
    const view = this.read();
    this.positions.adopt();
    return view;
  }

  private read(): View {
    const parsed = viewFromPath(this.target.location.pathname, this.target.location.search);
    const view = parsed ?? { name: "inbox" as const };
    const canonical = viewPath(view);
    if (`${this.target.location.pathname}${this.target.location.search}` !== canonical || this.target.location.hash) {
      this.target.history.replaceState(this.target.history.state, "", canonical);
    }
    return view;
  }

  push(view: View): void {
    const path = viewPath(view);
    if (`${this.target.location.pathname}${this.target.location.search}` === path && !this.target.location.hash) return;
    this.positions.push(path);
  }

  replace(view: View): void {
    // The entry keeps its state, and with it its history position.
    this.target.history.replaceState(this.target.history.state, "", viewPath(view));
  }

  listen(onView: (view: View, traversal?: HistoryTraversal) => void): () => void {
    const onPopState = () => {
      const view = this.read();
      const move = this.positions.arrive();
      if (move) onView(view, move.traversal);
    };
    this.target.addEventListener("popstate", onPopState);
    return () => this.target.removeEventListener("popstate", onPopState);
  }
}
