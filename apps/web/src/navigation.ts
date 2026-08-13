import {
  parseSourceLocation,
  SOURCE_LOCATION_MAX_PATH_LENGTH,
  type SourceLocation,
} from "@wollipog/protocol";

export type View =
  | { name: "inbox" }
  | { name: "board" }
  | { name: "runners"; section?: ConnectionSection }
  | { name: "runs" }
  | { name: "pods" }
  | { name: "automations" }
  | { name: "usage" }
  | { name: "projects"; id?: string }
  | { name: "session"; id: string; location?: SourceLocation }
  | { name: "run"; id: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "pod"; id: string };

/**
 * Settings sections, as ROUTES rather than dialog tabs.
 *
 * §11.3: a dialog cannot be linked to, cannot be opened in a second tab, loses its place on every
 * breakpoint crossing, and stacks another modal on top of itself for the shortcut reference. Every
 * section is deep-linkable, which is what makes "see Settings → Appearance" a thing you can send
 * someone.
 */
export type SettingsSection = "appearance" | "notifications" | "keyboard" | "behavior" | "network" | "about";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; title: string }> = [
  { id: "appearance", title: "Appearance" },
  { id: "notifications", title: "Notifications" },
  { id: "keyboard", title: "Keyboard" },
  { id: "behavior", title: "Behavior" },
  { id: "network", title: "Network" },
  { id: "about", title: "About" },
];

export type ConnectionSection = "instances" | "machines" | "people";

export type GlobalViewName = Extract<View["name"], "inbox" | "projects" | "board" | "runs" | "pods" | "automations" | "usage" | "runners">;

/** One vocabulary for every global destination, shared by the rail, header, and palette. */
export const GLOBAL_VIEW_ITEMS: ReadonlyArray<{
  name: GlobalViewName;
  label: string;
  title: string;
  paletteLabel: string;
}> = [
  { name: "inbox", label: "Inbox", title: "Inbox", paletteLabel: "Inbox" },
  { name: "projects", label: "Projects", title: "Projects", paletteLabel: "Projects" },
  { name: "board", label: "Board", title: "Board", paletteLabel: "Board" },
  { name: "runs", label: "Multi-Agent", title: "Multi-Agent Runs", paletteLabel: "Multi-Agent Runs" },
  { name: "pods", label: "Pods", title: "Collaboration Pods", paletteLabel: "Collaboration Pods" },
  { name: "automations", label: "Automations", title: "Automations", paletteLabel: "Automations" },
  { name: "usage", label: "Usage", title: "Usage & Cost", paletteLabel: "Usage & Cost" },
  { name: "runners", label: "Connections", title: "Connections", paletteLabel: "Connections" },
];

/**
 * The page title for any view.
 *
 * Deliberately exhaustive rather than a chain ending in a default: the previous chain named four
 * views and fell through to "Run", so Settings — added later — announced `<h1>Run</h1>` on every
 * one of its six routes. With no default branch, the next view that is added fails to compile
 * until it has a title.
 */
export function viewTitle(view: View): string {
  switch (view.name) {
    case "inbox":
    case "projects":
    case "board":
    case "runs":
    case "pods":
    case "automations":
    case "usage":
    case "runners":
      // Named once, in the list the rail and palette already read, so the three surfaces cannot
      // drift apart.
      return GLOBAL_VIEW_ITEMS.find((item) => item.name === view.name)!.title;
    case "session": return "Session";
    case "run": return "Run";
    case "pod": return "Pod";
    // The section is the <h2> inside the page; repeating it here would say it twice.
    case "settings": return "Settings";
  }
  // No default branch: this line stops compiling when a view is added without a title.
  const unhandled: never = view;
  return unhandled;
}

/**
 * Destinations the palette offers that the rail does not render as its own item.
 *
 * Settings is reachable by a dedicated gear rather than a rail row, so it is absent from
 * GLOBAL_VIEW_ITEMS — and the palette, which derived its whole fixed list from that array, had no
 * way to reach it. Appending it to the rail list instead would have made the rail render a second
 * Settings entry beside the gear.
 */
export const EXTRA_PALETTE_DESTINATIONS: ReadonlyArray<{ label: string; view: View }> = [
  { label: "Settings", view: { name: "settings" } },
  ...SETTINGS_SECTIONS.map((section) => ({
    label: `Settings — ${section.title}`,
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
    case "inbox": return "/";
    case "board": return "/board";
    case "runners": return `/connections/${view.section ?? "machines"}`;
    case "runs": return "/runs";
    case "pods": return "/pods";
    case "automations": return "/automations";
    case "usage": return "/usage";
    case "projects": return view.id ? `/projects/~${encodeResourceId(view.id)}` : "/projects";
    case "session": return view.location
      ? `/sessions/~${encodeResourceId(view.id)}/files/~${encodeOpaque(view.location.path)}${sourceLocationSearch(view.location)}`
      : `/sessions/~${encodeResourceId(view.id)}`;
    case "run": return `/runs/~${encodeResourceId(view.id)}`;
    case "settings": return `/settings/${view.section ?? "appearance"}`;
    case "pod": return `/pods/~${encodeResourceId(view.id)}`;
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

function resourceView(kind: "sessions" | "runs" | "pods", encodedId: string): View | null {
  const id = decodeResourceId(encodedId);
  if (id === null) return null;
  if (kind === "sessions") return { name: "session", id };
  if (kind === "runs") return { name: "run", id };
  return { name: "pod", id };
}

/** Parse only the dashboard's explicit route vocabulary. Unknown and malformed paths are not
 * treated as view ids, which keeps typos and encoded slashes from selecting surprising state. */
export function viewFromPath(pathname: string, search = ""): View | null {
  const path = pathname.length > 1 ? (pathname.replace(/\/+$/, "") || "/") : pathname;
  if (path === "/" || path.toLowerCase() === "/index.html" || path === "/inbox") return { name: "inbox" };
  if (path === "/board") return { name: "board" };
  // /runners was the canonical route before the user-facing Connections rename. Keep existing
  // bookmarks valid while all newly-generated URLs consistently use /connections.
  if (path === "/connections" || path === "/runners") return { name: "runners", section: "machines" };
  const connectionsMatch = /^\/connections\/(instances|machines|people)$/.exec(path);
  if (connectionsMatch) {
    return { name: "runners", section: connectionsMatch[1] as ConnectionSection };
  }
  if (path === "/runs") return { name: "runs" };
  if (path === "/pods") return { name: "pods" };
  if (path === "/automations") return { name: "automations" };
  if (path === "/usage") return { name: "usage" };
  if (path === "/settings") return { name: "settings", section: "appearance" };
  const settingsMatch = /^\/settings\/(appearance|notifications|keyboard|behavior|network|about)$/.exec(path);
  if (settingsMatch) return { name: "settings", section: settingsMatch[1] as SettingsSection };
  if (path === "/projects") return { name: "projects" };
  const projectMatch = /^\/projects\/~([^/]+)$/.exec(path);
  if (projectMatch) {
    const id = decodeResourceId(projectMatch[1]!);
    return id === null ? null : { name: "projects", id };
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
  return match ? resourceView(match[1] as "sessions" | "runs" | "pods", match[2]!) : null;
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
  const message = data as { type?: unknown; sessionId?: unknown };
  const opensSession = message.type === "mam:open-session" || message.type === "wollipog:open-session";
  if (opensSession && typeof message.sessionId === "string" &&
      message.sessionId.trim() && message.sessionId.length <= MAX_RESOURCE_ID_LENGTH) {
    return { name: "session", id: message.sessionId };
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
  history: Pick<History, "state" | "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface ViewNavigation {
  current(): View;
  push(view: View): void;
  listen(onView: (view: View) => void): () => void;
  activate?(view: View): void;
}

export class BrowserNavigation implements ViewNavigation {
  constructor(private readonly target: NavigationWindow = window) {}

  current(): View {
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
    this.target.history.pushState(this.target.history.state, "", path);
  }

  listen(onView: (view: View) => void): () => void {
    const onPopState = () => onView(this.current());
    this.target.addEventListener("popstate", onPopState);
    return () => this.target.removeEventListener("popstate", onPopState);
  }
}
