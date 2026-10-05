import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { useStoreSelector } from "../store.js";

interface Loaded {
  api: ApiClient;
  names: ReadonlyMap<string, string>;
}

/**
 * The organization's governance policy names, by policy id, for Decision Records (#2204): a policy's
 * decision is named by its display name, never "Policy · <id>". Loaded only when a row first asks,
 * and again on each connect, since a reconnect may carry other credentials. A row naming a policy
 * the names lack reloads them once (the policy may be new), and saving a policy here reloads them,
 * so a rename shows. Until the names load, and where they cannot, a row says "Policy".
 */
export function GovernancePolicyNamesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const conn = useStoreSelector((s) => s.conn);
  const [wanted, setWanted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const wantedRef = useRef(false);
  /** Policy ids already reloaded for, so a policy that no longer exists asks only once. */
  const reloadedFor = useRef(new Set<string>());
  const load = useCallback((policyId: string) => {
    if (!wantedRef.current) {
      wantedRef.current = true;
      setWanted(true);
      return;
    }
    const current = loadedRef.current;
    if (!current || current.names.has(policyId) || reloadedFor.current.has(policyId)) return;
    reloadedFor.current.add(policyId);
    setGeneration((value) => value + 1);
  }, []);
  const invalidate = useCallback(() => {
    if (!wantedRef.current) return;
    reloadedFor.current.clear();
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    if (conn !== "online") {
      // A reconnect may carry other credentials: drop the previous names before the next load.
      setLoaded(null);
      reloadedFor.current.clear();
    }
  }, [conn]);
  useEffect(() => {
    if (!wanted || conn !== "online") return;
    let cancelled = false;
    void api.governancePolicies().then(({ policies }) => {
      if (cancelled) return;
      const names = new Map<string, string>();
      for (const policy of policies) {
        const name = policy.name.trim();
        if (name) names.set(policy.policyId, name);
      }
      setLoaded({ api, names });
    }).catch(() => {
      // The names already shown, or "Policy", are the safe fallback; the next connect retries.
    });
    return () => { cancelled = true; };
  }, [api, conn, wanted, generation]);
  const names = conn === "online" && loaded?.api === api ? loaded.names : null;
  const value = useMemo(() => ({ names, load, invalidate }), [names, load, invalidate]);
  return <GovernancePolicyNamesContext.Provider value={value}>{children}</GovernancePolicyNamesContext.Provider>;
}
