import type {
  ControlPlaneToRunner,
  SkillSyncEntry,
  SkillsSyncManifestMessage,
  SkillsSyncNeedMessage,
} from "@wollipog/protocol";

type ManifestEntry = SkillsSyncManifestMessage["skills"][number];

interface PendingChunkedSkillsSync {
  syncId: string;
  requestId?: string;
  skills: ManifestEntry[];
  missing: Set<string>;
  received: Set<string>;
  expiresAt: number;
}

type ChunkedSyncFailure =
  | { kind: "ignored" }
  | { kind: "rejected"; error: string; requestId?: string };

export type ChunkedSyncStep<T extends object = Record<never, never>> =
  | ChunkedSyncFailure
  | ({ kind: "accepted" } & T);

function contentKey(name: string, versionDigest: string): string {
  return `${name}\0${versionDigest}`;
}

/** Ephemeral v96 assembly. Content is validated and cached one frame at a time, so retained
 * transaction memory is proportional to manifest metadata rather than aggregate skill bytes. */
export class ChunkedSkillsSyncAssembler {
  private pending: PendingChunkedSkillsSync | null = null;
  private readonly assemblyTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: {
    runnerId: string;
    needsContent(entry: ManifestEntry): boolean;
    cacheContent(entry: SkillSyncEntry): void;
    assemblyTtlMs?: number;
    now?: () => number;
  }) {
    this.assemblyTtlMs = options.assemblyTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get inProgress(): boolean {
    this.expireStale();
    return this.pending !== null;
  }

  reset(): void {
    this.pending = null;
  }

  begin(message: SkillsSyncManifestMessage): ChunkedSyncStep<{ need: SkillsSyncNeedMessage }> {
    this.pending = null;
    const requestId = message.requestId;
    if (message.runnerId !== this.options.runnerId) {
      return this.rejected("skills sync manifest targeted a different runner", requestId);
    }
    if (typeof message.syncId !== "string" || message.syncId.length < 1 || message.syncId.length > 128 ||
        !Array.isArray(message.skills)) {
      return this.rejected("invalid chunked skills sync manifest", requestId);
    }
    const seen = new Set<string>();
    const missing = new Set<string>();
    for (const entry of message.skills) {
      if (typeof entry?.name !== "string" || typeof entry?.versionDigest !== "string" ||
          !Array.isArray(entry.targets) || seen.has(entry.name)) {
        return this.rejected("invalid chunked skills sync manifest", requestId);
      }
      seen.add(entry.name);
      if (this.options.needsContent(entry)) missing.add(contentKey(entry.name, entry.versionDigest));
    }
    this.pending = {
      syncId: message.syncId,
      ...(requestId ? { requestId } : {}),
      skills: message.skills,
      missing,
      received: new Set(),
      expiresAt: this.now() + this.assemblyTtlMs,
    };
    return {
      kind: "accepted",
      need: {
        type: "skills_sync_need",
        runnerId: this.options.runnerId,
        syncId: message.syncId,
        missing: message.skills
          .filter((entry) => missing.has(contentKey(entry.name, entry.versionDigest)))
          .map(({ name, versionDigest }) => ({ name, versionDigest })),
      },
    };
  }

  acceptContent(
    message: Extract<ControlPlaneToRunner, { type: "skills_sync_content" }>,
  ): ChunkedSyncStep {
    this.expireStale();
    const pending = this.pending;
    if (!pending || message.runnerId !== this.options.runnerId || message.syncId !== pending.syncId) {
      return { kind: "ignored" };
    }
    const key = contentKey(message.name, message.versionDigest);
    const manifest = pending.skills.find(
      (entry) => entry.name === message.name && entry.versionDigest === message.versionDigest,
    );
    if (!manifest || !pending.missing.has(key) || pending.received.has(key)) {
      return this.rejectPending("chunked skills sync delivered unrequested content");
    }
    try {
      this.options.cacheContent({ ...manifest, files: message.files });
    } catch (error) {
      return this.rejectPending(
        `chunked skills sync rejected ${message.name}: ` +
          `${error instanceof Error ? error.message : "content could not be cached"}`,
      );
    }
    pending.received.add(key);
    pending.expiresAt = this.now() + this.assemblyTtlMs;
    return { kind: "accepted" };
  }

  complete(
    message: Extract<ControlPlaneToRunner, { type: "skills_sync_complete" }>,
  ): ChunkedSyncStep<{ desired: ManifestEntry[]; requestId?: string }> {
    this.expireStale();
    const pending = this.pending;
    if (!pending || message.runnerId !== this.options.runnerId || message.syncId !== pending.syncId) {
      return { kind: "ignored" };
    }
    const absent = [...pending.missing].filter((key) => !pending.received.has(key));
    if (absent.length > 0) {
      return this.rejectPending(
        `chunked skills sync incomplete: ${absent.length} requested skill version(s) were not delivered`,
      );
    }
    this.pending = null;
    return {
      kind: "accepted",
      desired: pending.skills,
      ...(pending.requestId ? { requestId: pending.requestId } : {}),
    };
  }

  private rejected(error: string, requestId?: string): ChunkedSyncFailure {
    return { kind: "rejected", error, ...(requestId ? { requestId } : {}) };
  }

  private rejectPending(error: string): ChunkedSyncFailure {
    const requestId = this.pending?.requestId;
    this.pending = null;
    return this.rejected(error, requestId);
  }

  private expireStale(): void {
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = null;
  }
}
