import type { AgentDefinition, ClaudeMediaReviewerAttestation } from "@wollipog/protocol";

export interface MediaReviewerAdvertisementDeps {
  /** Current agent list; discovery replaces it, so it is read on every refresh. */
  agents(): readonly AgentDefinition[];
  inspect(agentId: string): Promise<{ attestation: ClaudeMediaReviewerAttestation } | { refused: string }>;
  /** Republish agents. Called only when an attestation appeared, changed or disappeared. */
  publish(): void;
  /** False while the control plane cannot yet receive an agents update (it will get a full one). */
  canPublish(): boolean;
}

/** Which native Claude Code agents currently have a re-proven media-only reviewer (#1321).
 * Registration and every discovery pass request a refresh: an agent discovered after registration,
 * or a key provisioned while connected, is advertised without a reconnect. Refreshes are serialized;
 * a request during a run schedules exactly one more run over the then-current agent list. */
export class MediaReviewerAdvertisement {
  private readonly attestations = new Map<string, ClaudeMediaReviewerAttestation>();
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private readonly deps: MediaReviewerAdvertisementDeps) {}

  attestation(agentId: string): ClaudeMediaReviewerAttestation | undefined { return this.attestations.get(agentId); }

  refresh(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.once(); } while (this.again);
      } finally { this.running = null; }
    })();
    return this.running;
  }

  private async once(): Promise<void> {
    let changed = false;
    const candidates = this.deps.agents().filter((agent) => agent.driver === "claude-code" && (agent.context?.kind ?? "native") === "native");
    const live = new Set(candidates.map((agent) => agent.id));
    for (const id of [...this.attestations.keys()]) if (!live.has(id)) { this.attestations.delete(id); changed = true; }
    for (const agent of candidates) {
      const result = await this.deps.inspect(agent.id).catch(() => ({ refused: "media reviewer inspection failed" }));
      const previous = this.attestations.get(agent.id);
      if ("attestation" in result) {
        if (JSON.stringify(previous) !== JSON.stringify(result.attestation)) { this.attestations.set(agent.id, result.attestation); changed = true; }
      } else if (previous) { this.attestations.delete(agent.id); changed = true; }
    }
    if (changed && this.deps.canPublish()) this.deps.publish();
  }
}
