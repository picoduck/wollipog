import { randomUUID } from "node:crypto";
import { agentAvailableForImplicitLaunch, type AgentDefinition } from "@wollipog/protocol";

export const DISCOVERY_RECOVERY_DELAY_MS = 10_000;
export const DISCOVERY_RECOVERY_ATTEMPTS = 2;

/** Recover native Claude discovery, never launch a session or reuse an earlier readiness proof. */
export class DiscoveryRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private passId = "";
  private entryPoint = "inventory";
  private failed = new Set<string>();

  constructor(private readonly rediscover: () => void, private readonly log: (line: string) => void) {}

  begin(recovery = false): void {
    this.dispose();
    if (!recovery) this.attempt = 0;
    this.passId = randomUUID();
    this.entryPoint = recovery ? "automatic_recovery" : "inventory";
  }

  complete(agents: readonly AgentDefinition[]): void {
    let retry = false;
    const failed = new Set<string>();
    for (const agent of agents) {
      if (agent.driver !== "claude-code" || (agent.context?.kind ?? "native") !== "native" ||
          agent.installation?.selection === "other" || agent.harnessSelectionBlocked) continue;
      if (agentAvailableForImplicitLaunch(agent)) {
        if (this.failed.has(agent.id)) this.record(agent.id, "recovered");
        continue;
      }
      const failure = agent.claudeCode?.failure;
      const auth = agent.providerAccountReadiness?.defaultAuthStatus ?? agent.authStatus;
      const reason = failure?.code ?? (auth === "unauthenticated" ? "unauthenticated" : "launch_not_ready");
      const retryable = failure?.retryable === true;
      failed.add(agent.id);
      retry ||= retryable;
      this.record(agent.id, reason, { retryable,
        nextRetryInMs: retryable && this.attempt < DISCOVERY_RECOVERY_ATTEMPTS ? DISCOVERY_RECOVERY_DELAY_MS : null,
        retriesRemaining: DISCOVERY_RECOVERY_ATTEMPTS - this.attempt });
    }
    this.failed = failed;
    if (!retry || this.attempt >= DISCOVERY_RECOVERY_ATTEMPTS) return;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.rediscover();
    }, DISCOVERY_RECOVERY_DELAY_MS);
    this.timer.unref?.();
  }

  private record(agentId: string, reason: string, extra: Record<string, unknown> = {}): void {
    this.log(JSON.stringify({ event: "provider_discovery_observation", passId: this.passId,
      entryPoint: this.entryPoint, observedAt: Date.now(), agentId, harness: "claude-code", reason,
      recoveryAttempt: this.attempt, ...extra }));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
