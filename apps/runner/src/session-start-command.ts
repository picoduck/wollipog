import type { StartSessionMessage } from "@wollipog/protocol";
import type { DurableCommandLifecycle } from "./session-manager.js";

export interface SessionStartCommandDependencies {
  track(sessionId: string, materialized: Promise<boolean>): void;
  start(
    command: StartSessionMessage,
    lifecycle: DurableCommandLifecycle | undefined,
    onMaterialized: (ready: boolean) => void,
  ): Promise<boolean>;
  failed(error: unknown, lifecycle: DurableCommandLifecycle | undefined): void;
}

/** Wire every start_session transport through the same materialization fence. The tracked promise
 * settles when the durable session root is ready, independently of admission and provider launch. */
export function startSessionWithMaterializationFence(
  command: StartSessionMessage,
  lifecycle: DurableCommandLifecycle | undefined,
  dependencies: SessionStartCommandDependencies,
): void {
  let resolveMaterialized!: (ready: boolean) => void;
  const materialized = new Promise<boolean>((resolve) => {
    resolveMaterialized = resolve;
  });
  dependencies.track(command.spec.sessionId, materialized);
  void dependencies.start(command, lifecycle, resolveMaterialized).catch((error) => {
    resolveMaterialized(false);
    dependencies.failed(error, lifecycle);
  });
}
