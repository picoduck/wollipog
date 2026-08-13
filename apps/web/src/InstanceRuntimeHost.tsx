import { useEffect, type ReactNode } from "react";
import { ApiProvider } from "./api-context.js";
import type { InstanceRuntime } from "./instance-runtime.js";
import { InstanceScopeProvider } from "./instance-scope.js";
import type { ViewNavigation } from "./navigation.js";
import { StoreProvider } from "./store.js";

const runtimeOwners = new WeakMap<InstanceRuntime, number>();

function retainRuntime(runtime: InstanceRuntime): () => void {
  runtimeOwners.set(runtime, (runtimeOwners.get(runtime) ?? 0) + 1);
  return () => {
    const remaining = Math.max(0, (runtimeOwners.get(runtime) ?? 1) - 1);
    if (remaining > 0) runtimeOwners.set(runtime, remaining);
    else runtimeOwners.delete(runtime);
    queueMicrotask(() => {
      if (!runtimeOwners.has(runtime)) runtime.close();
    });
  };
}

/** Mount the complete connection-scoped application subtree for one immutable runtime. */
export function InstanceRuntimeHost({
  runtime,
  navigation,
  disposeOnUnmount = false,
  children,
}: {
  runtime: InstanceRuntime;
  navigation?: ViewNavigation;
  /** BrowserApp owns no provider lifecycle, so it opts into disposal here. */
  disposeOnUnmount?: boolean;
  children: ReactNode;
}) {
  useEffect(() => disposeOnUnmount ? retainRuntime(runtime) : undefined, [disposeOnUnmount, runtime]);
  return (
    <InstanceScopeProvider instanceScope={runtime.instanceId}>
      <ApiProvider client={runtime.api}>
        <StoreProvider connection={runtime.ui} navigation={navigation}>{children}</StoreProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  );
}
