import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ResourceScope, RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb, RUNNER_CREDENTIAL_REVOKED_HISTORY_LIMIT } from "./db.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";
import {
  issueRunnerCredential,
  makeManagedBoxRunnerCredentialIssuer,
  makeManagedDesktopRunnerCredentialIssuer,
  markLegacyRunnerCredentialWarning,
  newRunnerCredentialToken,
  normalizeRunnerCredentialId,
  RUNNER_CREDENTIAL_PENDING_MS,
} from "./runner-credentials.js";

const organizationScope: ResourceScope = {
  organizationId: PERSONAL_ORGANIZATION_ID,
  owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
};

function runner(runnerId = "runner-1", hostname: string | null = "host-1"): RunnerMetadata {
  return {
    runnerId,
    hostname: hostname as string,
    os: "linux",
    version: "1.0.0",
    agents: [{ id: "agent-1", name: "Agent", command: "agent", args: [], env: {}, driver: "acp" }],
    workspaces: [{ id: "workspace-1", name: "Workspace", path: "/repo" }],
  };
}

test("runner credential tokens are 256-bit Wollipog secrets and ids reject unsafe path characters", () => {
  const first = newRunnerCredentialToken();
  const second = newRunnerCredentialToken();
  assert.match(first, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first, second);
  assert.equal(normalizeRunnerCredentialId("runner.example-1"), "runner.example-1");
  for (const invalid of ["", " runner", "runner ", "runner/id", "runner\\id", "runner?id", "runner#id", "a".repeat(129)]) {
    assert.equal(normalizeRunnerCredentialId(invalid), null);
  }
});

test("SSH-box and managed-desktop issuers share the canonical hash-only credential path", () => {
  const db = ControlPlaneDb.open(":memory:");
  const issueManagedBox = makeManagedBoxRunnerCredentialIssuer(db, () => 1_000);
  const issueManagedDesktop = makeManagedDesktopRunnerCredentialIssuer(db, () => 2_000);

  const box = issueManagedBox("ssh-box-runner");
  const desktop = issueManagedDesktop("managed-desktop-runner");

  assert.match(box.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
  assert.match(desktop.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
  assert.equal(box.credential.label, "Managed box runner");
  assert.equal(desktop.credential.label, "Wollipog local runner");
  assert.deepEqual(box.credential.scope, organizationScope);
  assert.deepEqual(desktop.credential.scope, organizationScope);
  assert.equal("token" in box.credential, false);
  assert.equal("token" in desktop.credential, false);

  const reusableMetadata = JSON.stringify(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID));
  assert.equal(reusableMetadata.includes(box.token), false);
  assert.equal(reusableMetadata.includes(desktop.token), false);
  assert.doesNotMatch(reusableMetadata, /(?:mamr|wollipogr)_[A-Za-z0-9_-]{43}/u);
  db.close();
});

test("plaintext is returned once while SQLite stores only its SHA-256 digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-runner-credential-"));
  const path = join(dir, "control-plane.db");
  try {
    const db = ControlPlaneDb.open(path);
    const issued = issueRunnerCredential(db, {
      runnerId: "runner-1",
      scope: organizationScope,
      label: "First runner",
      now: 1_000,
    });
    assert.match(issued.token, /^wollipogr_/u);
    assert.equal(issued.credential.status, "pending");
    assert.equal(issued.credential.expiresAt, 1_000 + RUNNER_CREDENTIAL_PENDING_MS);
    assert.equal("token" in issued.credential, false);
    db.close();

    const raw = new DatabaseSync(path);
    const stored = raw.prepare("SELECT token_hash FROM runner_credentials WHERE credential_id=?")
      .get(issued.credential.credentialId) as { token_hash: string };
    raw.close();
    assert.equal(stored.token_hash, hashToken(issued.token));
    assert.equal(readFileSync(path).includes(Buffer.from(issued.token)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-store attestation accepts a live pending credential without activating or touching it", () => {
  const db = ControlPlaneDb.open(":memory:");
  const issued = issueRunnerCredential(db, {
    runnerId: "runner-attest",
    scope: organizationScope,
    now: 1_000,
  });
  const hash = hashToken(issued.token);
  assert.equal(db.verifyRunnerCredentialForAttestation("runner-attest", hash, 2_000), true);
  assert.equal(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)[0]?.status, "pending");
  assert.equal(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)[0]?.lastUsedAt, null);
  assert.equal(db.verifyRunnerCredentialForAttestation("another-runner", hash, 2_000), false);
  assert.equal(db.verifyRunnerCredentialForAttestation("runner-attest", hash, issued.credential.expiresAt!), false);
  assert.equal(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)[0]?.status, "pending");
  db.close();
});

test("existing legacy credentials stay active until an exact Wollipog rotation registers", () => {
  const db = ControlPlaneDb.open(":memory:");
  const legacyToken = `mamr_${"a".repeat(43)}`;
  db.issueRunnerCredential({
    credentialId: "rcred_legacy_prefix_upgrade",
    runnerId: "runner-1",
    organizationId: PERSONAL_ORGANIZATION_ID,
    ownerKind: "organization",
    ownerId: PERSONAL_ORGANIZATION_ID,
    label: "Legacy runner credential",
    tokenHash: hashToken(legacyToken),
    now: 100,
    expiresAt: 1_000,
  });
  assert.equal(db.registerRunnerWithCredential(runner(), hashToken(legacyToken), 200, 53)?.activated, true);

  const replacement = issueRunnerCredential(db, {
    runnerId: "runner-1",
    scope: organizationScope,
    now: 300,
  });
  assert.match(replacement.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(legacyToken)), true);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), false);

  assert.equal(
    db.registerRunnerWithCredential(runner(), hashToken(replacement.token), 400, 53)?.activated,
    true,
  );
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(legacyToken)), false);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), true);
  db.close();
});

test("legacy credential warnings are exact, value-free, and deduplicated per runner", () => {
  const warned = new Set<string>();
  const legacyToken = `mamr_${"a".repeat(43)}`;

  assert.equal(markLegacyRunnerCredentialWarning(legacyToken, "runner-1", warned), true);
  assert.equal(markLegacyRunnerCredentialWarning(legacyToken, "runner-1", warned), false);
  assert.equal(markLegacyRunnerCredentialWarning(legacyToken, "runner-2", warned), true);
  assert.equal(markLegacyRunnerCredentialWarning(`wollipogr_${"a".repeat(43)}`, "runner-3", warned), false);
  assert.equal(markLegacyRunnerCredentialWarning("mamr_invalid", "runner-4", warned), false);
  assert.deepEqual([...warned], ["runner-1", "runner-2"]);
});

test("reissuing a same-runner credential immediately revokes the prior pending token", () => {
  const db = ControlPlaneDb.open(":memory:");
  const first = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 100 });
  const second = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 200 });

  assert.equal(db.registerRunnerWithCredential(runner(), hashToken(first.token), 300, 53), null,
    "the first pending token is revoked at issuance, before any replacement process starts");
  assert.equal(db.registerRunnerWithCredential(runner(), hashToken(second.token), 300, 53)?.activated, true);
  assert.deepEqual(
    db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)
      .map((credential) => [credential.credentialId, credential.status]),
    [[second.credential.credentialId, "active"], [first.credential.credentialId, "revoked"]],
  );
  db.close();
});

test("registration activates a pending credential and rotation preserves the old token until cutover", () => {
  const db = ControlPlaneDb.open(":memory:");
  const initial = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 100 });
  assert.equal(db.registerRunnerWithCredential(runner(), hashToken(initial.token), 200, 53)?.activated, true);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(initial.token)), true);

  const replacement = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 300 });
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), false,
    "a conductor check must not promote pending credentials");
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(initial.token)), true,
    "issuing a rotation must leave the current runner working");

  const cutover = db.registerRunnerWithCredential(runner(), hashToken(replacement.token), 400, 53);
  assert.equal(cutover?.activated, true);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(initial.token)), false);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), true);
  assert.deepEqual(
    db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID).map((credential) => [credential.credentialId, credential.status]),
    [[replacement.credential.credentialId, "active"], [initial.credential.credentialId, "revoked"]],
  );
  db.close();
});

test("wrong runner ids and expired pending credentials fail without revoking the active token", () => {
  const db = ControlPlaneDb.open(":memory:");
  const initial = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 100 });
  db.registerRunnerWithCredential(runner(), hashToken(initial.token), 200, 53);
  const replacement = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 300 });

  assert.equal(db.registerRunnerWithCredential(runner("runner-2"), hashToken(replacement.token), 400, 53), null);
  assert.equal(
    db.registerRunnerWithCredential(runner(), hashToken(replacement.token), 300 + RUNNER_CREDENTIAL_PENDING_MS, 53),
    null,
  );
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(initial.token)), true);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), false);
  db.close();
});

test("repeated failed bootstraps retain only bounded revoked credential metadata", () => {
  const db = ControlPlaneDb.open(":memory:");
  const issuedIds: string[] = [];
  for (let index = 0; index < RUNNER_CREDENTIAL_REVOKED_HISTORY_LIMIT + 10; index += 1) {
    issuedIds.push(issueRunnerCredential(db, {
      runnerId: "flaky-box",
      scope: organizationScope,
      now: 100 + index,
    }).credential.credentialId);
  }

  const retained = db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)
    .filter((credential) => credential.runnerId === "flaky-box");
  assert.equal(retained.filter((credential) => credential.status === "revoked").length,
    RUNNER_CREDENTIAL_REVOKED_HISTORY_LIMIT);
  assert.equal(retained.filter((credential) => credential.status === "pending").length, 1);
  assert.equal(retained.some((credential) => credential.credentialId === issuedIds[0]), false,
    "the oldest unusable hash is pruned instead of growing SQLite and list responses forever");
  assert.equal(retained.some((credential) => credential.credentialId === issuedIds.at(-1)), true);
  db.close();
});

test("credential activation and runner metadata persistence roll back atomically", () => {
  const db = ControlPlaneDb.open(":memory:");
  const initial = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 100 });
  db.registerRunnerWithCredential(runner(), hashToken(initial.token), 200, 53);
  const replacement = issueRunnerCredential(db, { runnerId: "runner-1", scope: organizationScope, now: 300 });

  assert.throws(
    () => db.registerRunnerWithCredential(runner("runner-1", null), hashToken(replacement.token), 400, 53),
    /NOT NULL constraint failed/u,
  );
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(initial.token)), true);
  assert.equal(db.verifyActiveRunnerCredential("runner-1", hashToken(replacement.token)), false);
  assert.equal(db.getRunner("runner-1")?.hostname, "host-1");
  db.close();
});

test("full ownership scope is reserved with the credential and cannot be changed at registration", () => {
  const db = ControlPlaneDb.open(":memory:");
  const userScope: ResourceScope = {
    organizationId: PERSONAL_ORGANIZATION_ID,
    owner: { kind: "user", userId: "usr_local_owner" },
  };
  const issued = issueRunnerCredential(db, { runnerId: "runner-user", scope: userScope, now: 100 });
  db.registerRunnerWithCredential(runner("runner-user"), hashToken(issued.token), 200, 53);
  assert.deepEqual(db.runnerScope("runner-user"), userScope);
  assert.throws(
    () => issueRunnerCredential(db, { runnerId: "runner-user", scope: organizationScope, now: 300 }),
    /another owner/u,
  );
  db.close();
});

test("single-runner legacy token migration is exact-id, idempotent, and never reseeds revoked credentials", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("known-runner"), 100, 52);
  const legacyHash = hashToken("former-fleet-token");
  assert.deepEqual(db.backfillLegacyRunnerCredentials(legacyHash, 200), { migrated: 1, blocked: 0 });
  assert.equal(db.verifyActiveRunnerCredential("known-runner", legacyHash), true);
  assert.equal(db.registerRunnerWithCredential(runner("unknown-runner"), legacyHash, 300, 53), null);
  assert.deepEqual(db.backfillLegacyRunnerCredentials(legacyHash, 400), { migrated: 0, blocked: 0 });

  assert.equal(db.revokeRunnerCredential("known-runner", PERSONAL_ORGANIZATION_ID, 500), true);
  assert.deepEqual(db.backfillLegacyRunnerCredentials(legacyHash, 600), { migrated: 0, blocked: 0 });
  assert.equal(db.verifyActiveRunnerCredential("known-runner", legacyHash), false);
  db.close();
});

test("legacy fleet token fails closed when more than one runner could be impersonated", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-a"), 100, 52);
  db.registerRunner(runner("runner-b"), 100, 52);
  const legacyHash = hashToken("former-fleet-token");

  assert.deepEqual(db.backfillLegacyRunnerCredentials(legacyHash, 200), { migrated: 0, blocked: 2 });
  assert.equal(db.verifyActiveRunnerCredential("runner-a", legacyHash), false);
  assert.equal(db.verifyActiveRunnerCredential("runner-b", legacyHash), false);

  const runnerA = issueRunnerCredential(db, { runnerId: "runner-a", scope: organizationScope, now: 300 });
  db.registerRunnerWithCredential(runner("runner-a"), hashToken(runnerA.token), 400, 53);
  assert.deepEqual(db.backfillLegacyRunnerCredentials(legacyHash, 500), { migrated: 0, blocked: 1 },
    "a token known by the wider former fleet must not be assigned even to the last unrotated runner");
  assert.equal(db.verifyActiveRunnerCredential("runner-b", legacyHash), false);
  db.close();
});

test("runner deletion invalidates credentials and reused ids inherit no previous secret or scope", () => {
  const db = ControlPlaneDb.open(":memory:");
  const old = issueRunnerCredential(db, { runnerId: "runner-reused", scope: organizationScope, now: 100 });
  db.registerRunnerWithCredential(runner("runner-reused"), hashToken(old.token), 200, 53);
  assert.ok(db.deleteRunner("runner-reused"));
  assert.equal(db.verifyActiveRunnerCredential("runner-reused", hashToken(old.token)), false);
  assert.deepEqual(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID), []);

  const replacementScope: ResourceScope = {
    organizationId: PERSONAL_ORGANIZATION_ID,
    owner: { kind: "user", userId: "usr_local_owner" },
  };
  const replacement = issueRunnerCredential(db, { runnerId: "runner-reused", scope: replacementScope, now: 300 });
  db.registerRunnerWithCredential(runner("runner-reused"), hashToken(replacement.token), 400, 53);
  assert.deepEqual(db.runnerScope("runner-reused"), replacementScope);
  assert.equal(db.verifyActiveRunnerCredential("runner-reused", hashToken(old.token)), false);
  db.close();
});
