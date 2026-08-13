import { randomBytes, randomUUID } from "node:crypto";
import type { ResourceScope, RunnerCredentialSecret } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import type { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";

export const RUNNER_CREDENTIAL_PENDING_MS = 24 * 60 * 60 * 1_000;
export const LEGACY_RUNNER_CREDENTIAL_PREFIX = "mamr_";
export const WOLLIPOG_RUNNER_CREDENTIAL_PREFIX = "wollipogr_";
const RUNNER_CREDENTIAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Keep runner ids URL/config friendly without narrowing existing internal ids to one platform. */
export function normalizeRunnerCredentialId(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value) return null;
  return /[\u0000-\u0020\u007f/\\?#]/u.test(value) ? null : value;
}

export function newRunnerCredentialToken(): string {
  return `${WOLLIPOG_RUNNER_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Record one value-free warning per authenticated runner when rollback-era credentials remain. */
export function markLegacyRunnerCredentialWarning(
  token: string,
  runnerId: string,
  warnedRunnerIds: Set<string>,
): boolean {
  if (!token.startsWith(LEGACY_RUNNER_CREDENTIAL_PREFIX)) return false;
  if (!RUNNER_CREDENTIAL_SECRET_PATTERN.test(token.slice(LEGACY_RUNNER_CREDENTIAL_PREFIX.length))) return false;
  if (warnedRunnerIds.has(runnerId)) return false;
  warnedRunnerIds.add(runnerId);
  return true;
}

export function issueRunnerCredential(
  db: ControlPlaneDb,
  input: {
    runnerId: string;
    scope: ResourceScope;
    createdByUserId?: string;
    label?: string;
    now: number;
  },
): RunnerCredentialSecret {
  const token = newRunnerCredentialToken();
  const label = input.label?.trim().slice(0, 80) || "Runner credential";
  const ownerKind = input.scope.owner.kind;
  const ownerId = ownerKind === "organization"
    ? input.scope.owner.organizationId
    : ownerKind === "user"
      ? input.scope.owner.userId
      : input.scope.owner.teamId;
  const credential = db.issueRunnerCredential({
    credentialId: `rcred_${randomUUID().replace(/-/g, "")}`,
    runnerId: input.runnerId,
    organizationId: input.scope.organizationId,
    ownerKind,
    ownerId,
    label,
    tokenHash: hashToken(token),
    createdByUserId: input.createdByUserId,
    now: input.now,
    expiresAt: input.now + RUNNER_CREDENTIAL_PENDING_MS,
  });
  return { credential, token };
}

/** The SSH-box orchestrator and managed-desktop route use these exported issuers so their real
 * application wiring stays covered without importing the side-effectful control-plane entrypoint. */
export function makeManagedBoxRunnerCredentialIssuer(
  db: ControlPlaneDb,
  now: () => number = Date.now,
): (runnerId: string) => RunnerCredentialSecret {
  return (runnerId) => issueRunnerCredential(db, {
    runnerId,
    scope: db.runnerCredentialScope(runnerId) ?? db.runnerScope(runnerId) ?? {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
    },
    label: "Managed box runner",
    now: now(),
  });
}

export function makeManagedDesktopRunnerCredentialIssuer(
  db: ControlPlaneDb,
  now: () => number = Date.now,
): (runnerId: string) => RunnerCredentialSecret {
  return (runnerId) => {
    const local = db.localIdentityContext();
    const scope = db.runnerCredentialScope(runnerId) ?? db.runnerScope(runnerId) ?? {
      organizationId: local.organizationId,
      owner: { kind: "organization" as const, organizationId: local.organizationId },
    };
    if (scope.organizationId !== local.organizationId) {
      throw new Error("runner belongs to another organization");
    }
    return issueRunnerCredential(db, {
      runnerId,
      scope,
      createdByUserId: local.userId,
      label: "Wollipog local runner",
      now: now(),
    });
  };
}
