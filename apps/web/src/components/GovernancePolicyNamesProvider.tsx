import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { useStoreSelector } from "../store.js";

/**
 * The organization's governance policy names, by policy id, for Decision Records (#2204): a policy's
 * decision is named by its display name, never "Policy · <id>". Loaded only when a row first asks,
 * then once per connection, since a reconnect may carry other credentials. Until the names load,
 * and where they cannot, a row says "Policy".
 */
export function GovernancePolicyNamesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const conn = useStoreSelector((s) => s.conn);
  const [wanted, setWanted] = useState(false);
  const [loaded, setLoaded] = useState<{ api: ApiClient; names: ReadonlyMap<string, string> } | null>(null);
  const wantedRef = useRef(false);
  const load = useCallback(() => {
    if (wantedRef.current) return;
    wantedRef.current = true;
    setWanted(true);
  }, []);
  useEffect(() => {
    if (!wanted || conn !== "online") return;
    let cancelled = false;
    setLoaded(null);
    void api.governancePolicies().then(({ policies }) => {
      if (cancelled) return;
      const names = new Map<string, string>();
      for (const policy of policies) {
        const name = policy.name.trim();
        if (name) names.set(policy.policyId, name);
      }
      setLoaded({ api, names });
    }).catch(() => {
      // "Policy" is the safe fallback; the next connect retries.
    });
    return () => { cancelled = true; };
  }, [api, conn, wanted]);
  const names = conn === "online" && loaded?.api === api ? loaded.names : null;
  const value = useMemo(() => ({ names, load }), [names, load]);
  return <GovernancePolicyNamesContext.Provider value={value}>{children}</GovernancePolicyNamesContext.Provider>;
}
