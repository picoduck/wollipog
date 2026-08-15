import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageRunnerCredentialFile } from "./conductor.js";
import { fetchPromptImageReference } from "./prompt-image-fetch.js";
import {
  acquireRunnerDataDirLease,
  legacyRunnerDataDirOwnerHash,
  normalizeControlPlaneEndpoint,
  readV1RunnerCredentialForAttestation,
  runnerDataDirOwnerHash,
  scopedRunnerCredentialFile,
  type RunnerDataDirIdentity,
} from "./runner-data-dir.js";

const FIRST: RunnerDataDirIdentity = {
  runnerId: "runner-first",
  controlPlaneUrl: "ws://127.0.0.1:4317/runner",
  controlPlaneInstanceId: "11111111-1111-4111-8111-111111111111",
};
const SECOND: RunnerDataDirIdentity = {
  runnerId: "runner-second",
  controlPlaneUrl: "wss://manager.example.test/runner",
  controlPlaneInstanceId: "22222222-2222-4222-8222-222222222222",
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "wollipog-runner-owner-"));
}

test("same-owner concurrency is rejected while different owners receive deterministic isolated roots", () => {
  const root = tempRoot();
  try {
    const first = acquireRunnerDataDirLease(root, FIRST);
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST),
      /already in use.*distinct --data-dir/,
    );
    const second = acquireRunnerDataDirLease(root, SECOND);
    assert.notEqual(second.dataDir, first.dataDir);
    assert.equal(second.dataDir, join(root, "runner-instances", runnerDataDirOwnerHash(SECOND)));
    stageRunnerCredentialFile(first.dataDir, "token-first", FIRST).promote();
    stageRunnerCredentialFile(second.dataDir, "token-second", SECOND).promote();
    assert.equal(readFileSync(first.credentialFile, "utf8"), "token-first");
    assert.equal(readFileSync(second.credentialFile, "utf8"), "token-second");

    first.release();
    second.release();
    const restarted = acquireRunnerDataDirLease(root, FIRST);
    const secondRestarted = acquireRunnerDataDirLease(root, SECOND);
    assert.equal(secondRestarted.dataDir, second.dataDir);
    assert.equal(readFileSync(secondRestarted.credentialFile, "utf8"), "token-second");
    restarted.release();
    secondRestarted.release();
    assert.equal(existsSync(join(root, ".wollipog-runner-active-v1.lock")), false);

    const marker = readFileSync(join(root, ".wollipog-runner-owner-v1.json"), "utf8");
    assert.equal(marker.includes("token-first"), false);
    assert.equal(marker.includes(FIRST.controlPlaneUrl), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale same-host leases are reclaimed but foreign-host leases fail closed", () => {
  const root = tempRoot();
  try {
    const leasePath = join(root, ".wollipog-runner-active-v1.lock");
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
      leaseId: "00000000-0000-4000-8000-000000000001",
      pid: 424242,
      hostname: "test-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    let competingAttempted = false;
    const reclaimed = acquireRunnerDataDirLease(root, FIRST, {
      pid: 101,
      hostname: "test-host",
      isProcessAlive: () => {
        competingAttempted = true;
        assert.throws(
          () => acquireRunnerDataDirLease(root, FIRST, { hostname: "test-host", isProcessAlive: () => false }),
          /lease recovery (?:is already in progress|is present)/,
        );
        return false;
      },
    });
    assert.equal(competingAttempted, true);
    reclaimed.release();

    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
      leaseId: "00000000-0000-4000-8000-000000000002",
      pid: 202,
      hostname: "other-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST, { hostname: "test-host" }),
      /leased by host other-host.*distinct --data-dir/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed lease identity and interrupted recovery metadata fail closed", () => {
  const malformedRoot = tempRoot();
  const interruptedRoot = tempRoot();
  try {
    writeFileSync(join(malformedRoot, ".wollipog-runner-active-v1.lock"), JSON.stringify({
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
      leaseId: "../../untrusted",
      pid: 303,
      hostname: "test-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    assert.throws(
      () => acquireRunnerDataDirLease(malformedRoot, FIRST, { hostname: "test-host", isProcessAlive: () => false }),
      /invalid active lease.*unsafe recovery/,
    );
    assert.equal(existsSync(join(malformedRoot, ".wollipog-runner-active-v1.lock")), true);
    assert.equal(existsSync(join(malformedRoot, ".wollipog-runner-lease-recovery-v1")), false);

    mkdirSync(join(interruptedRoot, ".wollipog-runner-lease-recovery-v1"));
    assert.throws(
      () => acquireRunnerDataDirLease(interruptedRoot, FIRST),
      /lease recovery is present.*verify no runner is active/,
    );
    assert.equal(existsSync(join(interruptedRoot, ".wollipog-runner-active-v1.lock")), false);
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
    rmSync(interruptedRoot, { recursive: true, force: true });
  }
});

test("legacy migration preserves the last active token through a newly issued credential cutover", () => {
  const root = tempRoot();
  const mismatchRoot = tempRoot();
  const missingRoot = tempRoot();
  try {
    mkdirSync(join(root, "credentials"));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "credentials", "active-runner-token"), "legacy-token", { mode: 0o600 });
    const adopted = acquireRunnerDataDirLease(root, FIRST);
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "legacy-token");
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");
    if (process.platform !== "win32") assert.equal(statSync(adopted.credentialFile).mode & 0o777, 0o600);
    const pending = stageRunnerCredentialFile(root, "newly-issued-token", FIRST);
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "legacy-token");
    pending.promote();
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "newly-issued-token");
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");
    adopted.release();

    mkdirSync(join(mismatchRoot, "credentials"));
    writeFileSync(join(mismatchRoot, "credentials", "active-runner-token"), "other-token", { mode: 0o600 });
    const rotated = acquireRunnerDataDirLease(mismatchRoot, FIRST);
    assert.equal(readFileSync(rotated.credentialFile, "utf8"), "other-token");
    rotated.release();

    mkdirSync(join(missingRoot, "sessions"));
    const neverRegistered = acquireRunnerDataDirLease(missingRoot, FIRST);
    assert.equal(existsSync(neverRegistered.credentialFile), false);
    stageRunnerCredentialFile(missingRoot, "first-working-token", FIRST).promote();
    assert.equal(readFileSync(neverRegistered.credentialFile, "utf8"), "first-working-token");
    neverRegistered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mismatchRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("separate runner roots keep image authentication independent across credential rotation", async () => {
  const firstRoot = tempRoot();
  const secondRoot = tempRoot();
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const reference = {
    artifactId: "artifact-one",
    mimeType: "image/png",
    sizeBytes: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
  } as never;
  try {
    const first = acquireRunnerDataDirLease(firstRoot, FIRST);
    const second = acquireRunnerDataDirLease(secondRoot, SECOND);
    stageRunnerCredentialFile(first.dataDir, "token-first", FIRST).promote();
    stageRunnerCredentialFile(second.dataDir, "token-second", SECOND).promote();
    assert.notEqual(first.credentialFile, second.credentialFile);

    const authorizations: string[] = [];
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      authorizations.push((init?.headers as Record<string, string>).authorization);
      return new Response(image, {
        headers: { "content-type": "image/png", "content-length": String(image.length) },
      });
    }) as typeof fetch;
    const request = (identity: RunnerDataDirIdentity, tokenFile: string) => fetchPromptImageReference({
      controlPlaneUrl: identity.controlPlaneUrl,
      runnerId: identity.runnerId,
      tokenFile,
      fetchImpl,
    }, "session-one", reference);

    await Promise.all([request(FIRST, first.credentialFile), request(SECOND, second.credentialFile)]);
    assert.deepEqual(new Set(authorizations), new Set(["Bearer token-first", "Bearer token-second"]));

    stageRunnerCredentialFile(second.dataDir, "token-second-rotated", SECOND).promote();
    authorizations.length = 0;
    await Promise.all([request(FIRST, first.credentialFile), request(SECOND, second.credentialFile)]);
    assert.deepEqual(new Set(authorizations), new Set(["Bearer token-first", "Bearer token-second-rotated"]));
    first.release();
    second.release();
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("credential scopes use runner identity and stable control-plane identity, not the endpoint", () => {
  const root = "/runner-data";
  assert.equal(
    normalizeControlPlaneEndpoint("ws://EXAMPLE.test:4317/runner/#fragment"),
    "ws://example.test:4317/runner",
  );
  assert.equal(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: `${FIRST.controlPlaneUrl}/` }),
  );
  assert.equal(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: "ws://127.0.0.1:9999/runner" }),
  );
  assert.equal(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: "ws://localhost:7777/runner" }),
  );
  assert.equal(
    scopedRunnerCredentialFile(root, SECOND),
    scopedRunnerCredentialFile(root, { ...SECOND, controlPlaneUrl: "wss://manager.example.test:9443/runner" }),
  );
  assert.equal(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: `${FIRST.controlPlaneUrl}?tenant=other` }),
  );
  assert.notEqual(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, runnerId: "another-runner" }),
  );
  assert.notEqual(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneInstanceId: SECOND.controlPlaneInstanceId }),
  );
});

test("attested restart atomically upgrades a v1 endpoint owner and credential to stable v2", () => {
  const root = tempRoot();
  try {
    const legacyHash = legacyRunnerDataDirOwnerHash(FIRST);
    const oldCredential = join(root, "credentials", "instances", legacyHash, "active-runner-token");
    mkdirSync(join(root, "credentials", "instances", legacyHash), { recursive: true });
    writeFileSync(join(root, ".wollipog-runner-owner-v1.json"), JSON.stringify({
      version: 1,
      ownerHash: legacyHash,
    }), { mode: 0o600 });
    writeFileSync(oldCredential, "last-known-good", { mode: 0o600 });

    assert.equal(readV1RunnerCredentialForAttestation(root, FIRST), "last-known-good");
    const upgraded = acquireRunnerDataDirLease(root, FIRST, { allowLegacyEndpointMigration: true });
    assert.equal(upgraded.dataDir, root);
    assert.equal(upgraded.ownerHash, runnerDataDirOwnerHash(FIRST));
    assert.equal(readFileSync(upgraded.credentialFile, "utf8"), "last-known-good");
    assert.equal(readFileSync(oldCredential, "utf8"), "last-known-good", "rollback credential is preserved");
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".wollipog-runner-owner-v1.json"), "utf8")), {
      version: 2,
      ownerHash: runnerDataDirOwnerHash(FIRST),
    });
    upgraded.release();

    const movedEndpoint = acquireRunnerDataDirLease(root, {
      ...FIRST,
      controlPlaneUrl: "wss://new-address.example.test:9443/runner",
    });
    assert.equal(movedEndpoint.dataDir, root);
    assert.equal(readFileSync(movedEndpoint.credentialFile, "utf8"), "last-known-good");
    movedEndpoint.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unproven v1 endpoint ownership remains untouched when an endpoint is reused", () => {
  const root = tempRoot();
  try {
    const legacyHash = legacyRunnerDataDirOwnerHash(FIRST);
    const oldCredential = join(root, "credentials", "instances", legacyHash, "active-runner-token");
    mkdirSync(join(root, "credentials", "instances", legacyHash), { recursive: true });
    writeFileSync(join(root, ".wollipog-runner-owner-v1.json"), JSON.stringify({ version: 1, ownerHash: legacyHash }));
    writeFileSync(oldCredential, "credential-from-former-control-plane", { mode: 0o600 });

    const isolated = acquireRunnerDataDirLease(root, FIRST);
    assert.equal(isolated.dataDir, join(root, "runner-instances", runnerDataDirOwnerHash(FIRST)));
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".wollipog-runner-owner-v1.json"), "utf8")), {
      version: 1,
      ownerHash: legacyHash,
    });
    assert.equal(readFileSync(oldCredential, "utf8"), "credential-from-former-control-plane");
    isolated.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
