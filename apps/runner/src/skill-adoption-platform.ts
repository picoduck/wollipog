import { validSkillName, type SkillAdoptionRecoveryOperation } from "@wollipog/protocol";
import { macosSkillAdoptionHelper } from "./macos-skill-snapshots.js";
import { windowsSkillAdoptionHelper } from "./windows-skill-adoption.js";

/** One adoption transaction delegated to a fixed platform helper. Paths are the runner's own
 * configured roots; the helper resolves and pins them itself and never receives client input. */
export interface PlatformAdoptionRequest {
  home: string;
  /** Harness-relative directory below `home`; account scopes use `skills`. */
  localSourceDirectory: string;
  /** Public harness directory recorded in the journal and returned to the control plane. */
  sourceDirectory: string;
  name: string;
  generation: string;
  digest: string;
  dataDir: string;
  operationId: string;
  providerAccountId?: string;
}

/** `journal` means the helper reached its first mutation, so any later stop can leave recovery
 * evidence; `adopted` is reported only after the managed link and completion record exist. */
export interface PlatformAdoptionOutcome {
  journal: boolean;
  adopted: boolean;
}

export type RecoverySourceFacts =
  | { kind: "absent" }
  | { kind: "directory"; identity: string | null }
  | { kind: "link"; role: "managed" | "recovery" | "foreign" }
  | { kind: "other" };

/** Handle-anchored observations for one journal. The runner parses the journal and decides the
 * recovery state; the helper only reports what it saw through no-follow handles. */
export interface RecoveryJournalFacts {
  operationId: string;
  intent: string;
  /** Name and digest the helper read from the journal to probe the source. They must equal the
   * runner's parsed journal, or the observation does not describe that operation. */
  name: string;
  digest: string;
  originalIdentity: string | null;
  source: RecoverySourceFacts;
}

export interface RecoveryDirectoryFacts {
  /** Null when the harness directory is unavailable; it then has no inspectable operations. */
  parentIdentity: string | null;
  journals: RecoveryJournalFacts[];
  truncated: boolean;
}

export interface PlatformRestoreRequest {
  home: string;
  /** The OS home whose `.agents/skills` holds the canonical links reconciliation routes harness
   * links through; it differs from `home` for a provider-account scope. */
  canonicalHome: string;
  localSourceDirectory: string;
  dataDir: string;
  operationId: string;
  name: string;
  digest: string;
  parentIdentity: string;
  sourceIdentity: string;
}

export interface PlatformInspectRequest {
  home: string;
  canonicalHome: string;
  localSourceDirectory: string;
  dataDir: string;
  operationId?: string;
}

export interface SkillAdoptionPlatformHelper {
  adopt(request: PlatformAdoptionRequest): PlatformAdoptionOutcome;
  /** Throws when the scope exists but cannot be inspected; a missing scope is empty. */
  inspect(request: PlatformInspectRequest): RecoveryDirectoryFacts;
  /** True only after the recovery link and completion record were verified. */
  restore(request: PlatformRestoreRequest): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTITY = /^\d+:\d+$/u;

/** Validate and project the JSON inspection shape shared by the Windows and WSL helpers. */
export function parseRecoveryInspection(value: unknown): RecoveryDirectoryFacts {
  if (!value || typeof value !== "object") throw new Error("invalid helper result");
  const output = value as { parentIdentity?: unknown; journals?: unknown; truncated?: unknown };
  const parentIdentity = output.parentIdentity;
  if (typeof parentIdentity !== "string" || (parentIdentity !== "" && !IDENTITY.test(parentIdentity)) ||
      !Array.isArray(output.journals) || output.journals.length > 64 || typeof output.truncated !== "boolean" ||
      (parentIdentity === "" && output.journals.length !== 0)) throw new Error("invalid helper result");
  const text = (entry: unknown, pattern: RegExp) => {
    if (typeof entry !== "string" || (entry !== "" && !pattern.test(entry))) throw new Error("invalid helper result");
    return entry;
  };
  const journals = output.journals.map((item): RecoveryJournalFacts => {
    const journal = item as Record<string, unknown>;
    const operationId = text(journal.OperationId, UUID);
    const name = journal.Name;
    const kind = journal.Kind;
    const role = journal.Role;
    const sourceIdentity = text(journal.SourceIdentity, IDENTITY);
    if (!operationId || typeof journal.Intent !== "string" || journal.Intent.length > 8192 ||
        typeof name !== "string" || (name !== "" && !validSkillName(name)) ||
        !Number.isInteger(kind) || !Number.isInteger(role) || (kind as number) < 0 || (kind as number) > 3 ||
        (role as number) < 0 || (role as number) > 3 || (kind === 2) !== (role !== 0) ||
        (kind !== 1 && sourceIdentity !== "")) throw new Error("invalid helper result");
    const originalIdentity = text(journal.OriginalIdentity, IDENTITY);
    const source: RecoverySourceFacts = kind === 0 ? { kind: "absent" }
      : kind === 1 ? { kind: "directory", identity: sourceIdentity || null }
        : kind === 2 ? { kind: "link", role: role === 1 ? "managed" : role === 2 ? "recovery" : "foreign" }
          : { kind: "other" };
    return { operationId, intent: journal.Intent, name, digest: text(journal.Digest, DIGEST),
      originalIdentity: originalIdentity || null, source };
  });
  return { parentIdentity: parentIdentity || null, journals, truncated: output.truncated };
}

/** Platforms whose adoption transaction runs in a fixed native helper. Linux keeps its in-process
 * descriptor implementation; everything else refuses. */
export function platformSkillAdoptionHelper(platform: NodeJS.Platform): SkillAdoptionPlatformHelper | null {
  if (platform === "darwin") return macosSkillAdoptionHelper();
  if (platform === "win32") return windowsSkillAdoptionHelper();
  return null;
}

/** Shared recovery state machine for every platform. Only an exact identity match can make a
 * state restorable; anything else is blocked for manual inspection. */
export function recoveryState(
  intent: { parentIdentity: string; sourceIdentity: string },
  parentIdentity: string,
  originalIdentity: string | null,
  source: RecoverySourceFacts,
): Pick<SkillAdoptionRecoveryOperation, "state" | "detail"> {
  if (parentIdentity !== intent.parentIdentity) {
    return { state: "blocked", detail: "The source parent identity changed." };
  }
  if (source.kind === "directory" && originalIdentity === null && source.identity === intent.sourceIdentity) {
    return { state: "intent_only", detail: "The original source is still in place; no restore is needed." };
  }
  if (originalIdentity !== null && originalIdentity === intent.sourceIdentity) {
    if (source.kind === "absent") {
      return { state: "source_preserved", detail: "The original is preserved and the source path is empty." };
    }
    if (source.kind === "link" && source.role === "managed") {
      return { state: "managed_linked", detail: "The managed link is active and the original is preserved." };
    }
    if (source.kind === "link" && source.role === "recovery") {
      return { state: "restored", detail: "A recovery link exposes the preserved original at its source path." };
    }
  }
  return { state: "blocked", detail: "The journal or source path does not match a safe automatic recovery state." };
}
