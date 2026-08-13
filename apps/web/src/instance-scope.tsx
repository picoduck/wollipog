import React, { createContext, useContext, type ReactNode } from "react";
import { LOCAL_INSTANCE_SCOPE } from "./instance-storage.js";

const InstanceScopeContext = createContext(LOCAL_INSTANCE_SCOPE);

/** Bind browser-persisted, server-owned state to one immutable instance generation. */
export function InstanceScopeProvider({
  instanceScope,
  children,
}: {
  instanceScope: string;
  children: ReactNode;
}) {
  if (!instanceScope) throw new TypeError("instance scope must not be empty");
  return <InstanceScopeContext.Provider value={instanceScope}>{children}</InstanceScopeContext.Provider>;
}

/** Browser dashboards remain Local when no desktop instance provider is mounted. */
export function useInstanceScope(): string {
  return useContext(InstanceScopeContext);
}
