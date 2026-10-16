import { useOptionalStoreSelector } from "./store.js";
import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { RemoteAccessView } from "@wollipog/protocol";
import { ApiError } from "./api.js";
import { useApi } from "./api-context.js";
import { instancePublicOrigin, useInstances } from "./instances-context.js";

const RemoteAccessContext = createContext<{ view: RemoteAccessView | null; loading: boolean; update: (view: RemoteAccessView) => void } | null>(null);

/** The result belongs to an API client, so switching instances can never reuse another host's URL. */
export function RemoteAccessProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const connection = useOptionalStoreSelector((state) => state.conn);
  const [loaded, setLoaded] = useState<{ api: typeof api; view: RemoteAccessView | null } | null>(null);
  useEffect(() => {
    let current = true;
    if (connection && connection !== "online") return;
    const read = () => {
      if (!api.remoteAccess) { setLoaded({ api, view: null }); return; }
      void api.remoteAccess().then((view) => { if (current) setLoaded({ api, view }); }).catch((error: unknown) => {
        if (current) setLoaded({ api, view: error instanceof ApiError && error.status === 404 ? null : {
          canConfigure: false, phase: "unavailable", provider: null, origin: null, canDisable: false, verifiedAt: null,
          message: "The secure address could not be checked. Reconnect and retry.",
        } });
      });
    };
    read();
    // Recheck when a tab comes back, without background polling or storing a stale success on disk.
    window.addEventListener("focus", read);
    return () => { current = false; window.removeEventListener("focus", read); };
  }, [api, connection]);
  const view = loaded?.api === api ? loaded.view : null;
  return <RemoteAccessContext.Provider value={{ view, loading: loaded?.api !== api, update: (next) => setLoaded({ api, view: next }) }}>{children}</RemoteAccessContext.Provider>;
}

export function useRemoteAccess() { return useContext(RemoteAccessContext); }

/** Remote links use the verified server address; failed managed setup never falls back to HTTP. */
export function useDashboardPublicOrigin(): string | null {
  const instances = useInstances();
  const remote = useRemoteAccess();
  const view = remote?.view;
  if (remote?.loading || view?.phase === "unavailable") return null;
  if (view?.provider) return view.phase === "ready" ? view.origin : null;
  return instancePublicOrigin(instances);
}
