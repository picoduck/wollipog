import type {ShellView} from "@wollipog/protocol";
import type {Hub} from "./hub.js";
import type {ShellRegistry} from "./shell-registry.js";
import type {OwnerManagementResult} from "./owner-management.js";

export interface ManagedShellOpenResult {
  ok: boolean; status: number; shell?: ShellView; error?: string;
  capabilityRequirement?: import("@wollipog/protocol").RunnerCapabilityRequirementDetails;
  providerHomeRefusal?: import("@wollipog/protocol").ProviderHomeLaunchRefusalView;
}
/** Terminal process inventory/lifecycle is app management. Raw terminal input/output remains
 * workspace I/O. Both transports use the owner's exact runner/TUI opening path. */
export function createSessionShellManagement(deps: {
  hub: Hub; registry: ShellRegistry;
  open(sessionId: string, input: {cols?: unknown; rows?: unknown; kind?: unknown}, options?: {recheck?: () => Promise<unknown>}): Promise<ManagedShellOpenResult>;
}) {
  return {
    list(sessionId: string) {return {shells: deps.registry.list(sessionId)};},
    open: deps.open,
    close(sessionId: string, shellId: string): OwnerManagementResult {
      const entry = deps.registry.get(shellId);
      if (!entry || entry.sessionId !== sessionId) return {status: 404, body: {error: "shell not found"}};
      deps.hub.sendToRunner(entry.runnerId, {type: "shell_close", shellId});
      deps.registry.remove(shellId, entry.runnerId, Date.now());
      deps.hub.shellExit(entry.sessionId, shellId, null, entry.outputEndSeq);
      return {status: 204, body: undefined};
    },
  };
}
