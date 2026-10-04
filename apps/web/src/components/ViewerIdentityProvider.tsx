import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { NO_RESOLVER_DIRECTORY, ResolverDirectoryContext, viewerIdentity, type ViewerIdentity } from "../resolver-identity.js";
import { useStoreSelector } from "../store.js";

/**
 * Who is viewing, for every transcript surface: a shared session names who answered or decided
 * rather than saying "you" to everyone (#2527). Reloaded on each connect, since membership changes
 * force a reconnect. A reconnect may carry different credentials on the same client, so the
 * previous viewer is dropped first: until the identity loads, or if it cannot, resolver wording
 * stays neutral.
 */
export function ViewerIdentityProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const conn = useStoreSelector((s) => s.conn);
  const [loaded, setLoaded] = useState<{ api: ApiClient; viewer: ViewerIdentity } | null>(null);
  useEffect(() => {
    if (conn !== "online") return;
    let cancelled = false;
    setLoaded(null);
    void api.getIdentity().then((identity) => {
      if (!cancelled) setLoaded({ api, viewer: viewerIdentity(identity) });
    }).catch(() => {
      // Neutral wording is the safe fallback; the next connect retries.
    });
    return () => { cancelled = true; };
  }, [api, conn]);
  const viewer = conn === "online" && loaded?.api === api ? loaded.viewer : null;
  const directory = useMemo(() => viewer ? { ...NO_RESOLVER_DIRECTORY, viewer } : NO_RESOLVER_DIRECTORY, [viewer]);
  return <ResolverDirectoryContext.Provider value={directory}>{children}</ResolverDirectoryContext.Provider>;
}
