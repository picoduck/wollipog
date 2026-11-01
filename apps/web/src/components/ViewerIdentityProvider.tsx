import { useEffect, useState, type ReactNode } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { ViewerIdentityContext, viewerIdentity, type ViewerIdentity } from "../resolver-identity.js";
import { useStoreSelector } from "../store.js";

/**
 * Who is viewing, for every transcript surface: a shared session names who answered or decided
 * rather than saying "you" to everyone (#2527). Reloaded on each connect, and in place whenever the
 * control plane reports a member directory change (#2606): a member added or renamed, or another
 * member's access changed. A change to this viewer's own access closes the socket instead. A
 * reconnect may carry different credentials on the same client, so the previous viewer is dropped
 * whenever the connection leaves online: until the identity loads, or if it cannot, resolver wording
 * stays neutral. A directory refresh keeps the current viewer until the new one arrives.
 */
export function ViewerIdentityProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const conn = useStoreSelector((s) => s.conn);
  const directoryRevision = useStoreSelector((s) => s.identityDirectoryRevision);
  const [loaded, setLoaded] = useState<{ api: ApiClient; viewer: ViewerIdentity } | null>(null);
  useEffect(() => {
    if (conn !== "online") {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    void api.getIdentity().then((identity) => {
      if (!cancelled) setLoaded({ api, viewer: viewerIdentity(identity) });
    }).catch(() => {
      // Keep what is shown: neutral wording after a connect, the last directory after a refresh.
      // The next connect or directory change retries.
    });
    return () => { cancelled = true; };
  }, [api, conn, directoryRevision]);
  const viewer = conn === "online" && loaded?.api === api ? loaded.viewer : null;
  return <ViewerIdentityContext.Provider value={viewer}>{children}</ViewerIdentityContext.Provider>;
}
