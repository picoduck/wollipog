import { HistoryPositions, type HistoryTraversal, type PositionedHistory } from "./history-position.js";
import { interceptTraversal } from "./leave-guard.js";
import {
  decodeResourceId,
  encodeResourceId,
  isSettingsAlias,
  viewFromPath,
  viewPath,
  type View,
  type ViewNavigation,
} from "./navigation.js";
import {
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

const INSTANCE_PREFIX = "/instances/~";
const LAST_ROUTE_KEY = "wollipog.navigation.lastRoute";

export interface InstanceRoute {
  instanceId: string;
  view: View;
}

/** Build a desktop-only route that cannot confuse identical resource ids across instances. */
export function instanceViewPath(instanceId: string, view: View): string {
  if (!instanceId) throw new TypeError("instance id must not be empty");
  return `${INSTANCE_PREFIX}${encodeResourceId(instanceId)}${viewPath(view)}`;
}

/** Parse a canonical desktop instance route. Browser dashboards continue using `viewFromPath`. */
export function instanceRouteFromPath(pathname: string, search = ""): InstanceRoute | null {
  if (!pathname.startsWith(INSTANCE_PREFIX)) return null;
  const remainder = pathname.slice(INSTANCE_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash < 1) return null;
  const encodedInstanceId = remainder.slice(0, slash);
  const instanceId = decodeResourceId(encodedInstanceId);
  if (!instanceId) return null;
  const scopedPath = remainder.slice(slash) || "/";
  const view = viewFromPath(scopedPath, search);
  if (!view) return null;
  // An old Settings address (`/settings/keyboard`, #3023) is still that instance's route; callers
  // replace it with the canonical one, as `BrowserNavigation` does for an unscoped address.
  const aliased = isSettingsAlias(scopedPath) && search === "" && encodeResourceId(instanceId) === encodedInstanceId;
  if (!aliased && instanceViewPath(instanceId, view) !== `${pathname}${search}`) return null;
  return { instanceId, view };
}

/**
 * A focus or history intent that `InstanceProvider` must carry across rebuilding an instance's
 * store: the canonical route does not serialize it. Held for that one read only.
 */
let heldRedirect: { path: string; view: View } | null = null;

/** Hold the transient arrival intent for the store's first read of the canonical route. */
export function holdRedirectFocus(instanceId: string, view: View): void {
  const hasIntent = (view.name === "settings" && view.focus) || (view.name === "archived" && view.browseVisit?.restore);
  heldRedirect = hasIntent ? { path: instanceViewPath(instanceId, view), view } : null;
}

/** The held view, if it is for exactly this address; the hold ends either way. */
function takeHeldRedirect(path: string): View | null {
  const held = heldRedirect;
  heldRedirect = null;
  return held?.path === path ? held.view : null;
}

export function isInstanceScopedPath(pathname: string): boolean {
  return pathname.startsWith("/instances/");
}

export function loadLastInstanceView(instanceId: string): View {
  const stored = loadInstanceStorageValue(LAST_ROUTE_KEY, instanceId);
  if (!stored) return { name: "inbox" };
  try {
    const url = new URL(stored, "https://wollipog.invalid");
    return viewFromPath(url.pathname, url.search) ?? { name: "inbox" };
  } catch {
    return { name: "inbox" };
  }
}

export function saveLastInstanceView(instanceId: string, view: View): void {
  saveInstanceStorageValue(LAST_ROUTE_KEY, viewPath(view), instanceId);
}

export interface InstanceNavigationWindow {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: PositionedHistory;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

/** A fixed-profile history adapter. Cross-profile entries are owned by InstanceProvider. */
export class DesktopInstanceNavigation implements ViewNavigation {
  private readonly positions: HistoryPositions;

  constructor(
    readonly instanceId: string,
    private readonly target: InstanceNavigationWindow = window,
    private readonly onActivate?: (instanceId: string, view: View) => void,
  ) {
    this.positions = new HistoryPositions(target.history);
  }

  current(): View {
    const view = this.read();
    this.positions.adopt();
    return view;
  }

  private read(): View {
    const scoped = instanceRouteFromPath(this.target.location.pathname, this.target.location.search);
    const held = takeHeldRedirect(`${this.target.location.pathname}${this.target.location.search}`);
    if (scoped?.instanceId === this.instanceId) {
      const view = held ?? scoped.view;
      this.replaceAlias(view);
      saveLastInstanceView(this.instanceId, view);
      return view;
    }
    const legacy = viewFromPath(this.target.location.pathname, this.target.location.search);
    const view = legacy ?? loadLastInstanceView(this.instanceId);
    const path = instanceViewPath(this.instanceId, view);
    this.target.history.replaceState(this.target.history.state, "", path);
    saveLastInstanceView(this.instanceId, view);
    return view;
  }

  push(view: View): void {
    const path = instanceViewPath(this.instanceId, view);
    saveLastInstanceView(this.instanceId, view);
    if (`${this.target.location.pathname}${this.target.location.search}` === path && !this.target.location.hash) return;
    this.positions.push(path);
  }

  replace(view: View): void {
    saveLastInstanceView(this.instanceId, view);
    this.replaceAlias(view);
  }

  listen(onView: (view: View, traversal?: HistoryTraversal) => void): () => void {
    const onPopState = () => {
      const scoped = instanceRouteFromPath(this.target.location.pathname, this.target.location.search);
      // Another instance's entry is InstanceProvider's to open, with a store of its own; it asks
      // `holdDeparture` first.
      if (scoped?.instanceId !== this.instanceId) return;
      this.replaceAlias(scoped.view);
      saveLastInstanceView(this.instanceId, scoped.view);
      const move = this.positions.arrive();
      if (move) onView(scoped.view, move.traversal);
    };
    this.target.addEventListener("popstate", onPopState);
    return () => this.target.removeEventListener("popstate", onPopState);
  }

  /**
   * Whether this instance's editor holds a Back or Forward that leaves for another instance's entry
   * (#3218). InstanceProvider asks before it opens that instance, since opening it closes this one;
   * this instance's own `popstate` listener leaves such an entry alone, so each move is counted once.
   */
  holdDeparture(): boolean {
    const move = this.positions.arrive();
    // Part of a return to the editor's entry that is under way: not a move to another instance.
    if (!move) return true;
    return move.traversal !== undefined && interceptTraversal(move.traversal);
  }

  /** An old Settings address replaces its own entry with the view's canonical route. */
  private replaceAlias(view: View): void {
    const path = instanceViewPath(this.instanceId, view);
    if (`${this.target.location.pathname}${this.target.location.search}` === path) return;
    this.target.history.replaceState(this.target.history.state, "", path);
  }

  activate(view: View): void {
    if (this.onActivate) this.onActivate(this.instanceId, view);
    else this.push(view);
  }
}
