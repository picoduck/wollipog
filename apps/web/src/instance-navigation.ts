import {
  decodeResourceId,
  encodeResourceId,
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
  if (instanceViewPath(instanceId, view) !== `${pathname}${search}`) return null;
  return { instanceId, view };
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
  history: Pick<History, "state" | "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

/** A fixed-profile history adapter. Cross-profile entries are owned by InstanceProvider. */
export class DesktopInstanceNavigation implements ViewNavigation {
  constructor(
    readonly instanceId: string,
    private readonly target: InstanceNavigationWindow = window,
    private readonly onActivate?: (instanceId: string, view: View) => void,
  ) {}

  current(): View {
    const scoped = instanceRouteFromPath(this.target.location.pathname, this.target.location.search);
    if (scoped?.instanceId === this.instanceId) {
      saveLastInstanceView(this.instanceId, scoped.view);
      return scoped.view;
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
    this.target.history.pushState(this.target.history.state, "", path);
  }

  listen(onView: (view: View) => void): () => void {
    const onPopState = () => {
      const scoped = instanceRouteFromPath(this.target.location.pathname, this.target.location.search);
      if (scoped?.instanceId !== this.instanceId) return;
      saveLastInstanceView(this.instanceId, scoped.view);
      onView(scoped.view);
    };
    this.target.addEventListener("popstate", onPopState);
    return () => this.target.removeEventListener("popstate", onPopState);
  }

  activate(view: View): void {
    if (this.onActivate) this.onActivate(this.instanceId, view);
    else this.push(view);
  }
}
