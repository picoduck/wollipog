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
  canIgnoreRunnerDataDirDirectorySyncError,
  normalizeControlPlaneEndpoint,
  runnerDataDirOwnerHash,
  scopedRunnerCredentialFile,
  type RunnerDataDirIdentity,
} from "./runner-data-dir.js";

const FIRST: RunnerDataDirIdentity = {
  runnerId: "runner-first",
  controlPlaneUrl: "ws://127.0.0.1:4317/runner",
};
const SECOND: RunnerDataDirIdentity = {
  runnerId: "runner-second",
  controlPlaneUrl: "wss://manager.example.test/runner",
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
    const recoveryPath = join(root, ".wollipog-runner-lease-recovery-v1");
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
      leaseId: "00000000-0000-4000-8000-000000000001",
      pid: 424242,
      hostname: "test-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    let competingAttempted = false;
    const operations: Array<{ operation: string; path: string }> = [];
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
      beforeDurabilityOperationForTest: (operation, path) => operations.push({ operation, path }),
    });
    assert.equal(competingAttempted, true);
    const guardMkdir = operations.findIndex((entry) => entry.operation === "mkdir" && entry.path === recoveryPath);
    const guardPublished = operations.findIndex(
      (entry, index) => index > guardMkdir && entry.operation === "fsync-directory" && entry.path === root,
    );
    const staleLeaseRemoved = operations.findIndex(
      (entry, index) => index > guardPublished && entry.operation === "unlink" && entry.path === leasePath,
    );
    const replacementLeaseLink = operations.findIndex(
      (entry, index) => index > staleLeaseRemoved && entry.operation === "link" && entry.path === leasePath,
    );
    const replacementLeasePublished = operations.findIndex(
      (entry, index) => index > replacementLeaseLink && entry.operation === "fsync-directory" && entry.path === root,
    );
    const guardRemoved = operations.findIndex(
      (entry, index) => index > replacementLeasePublished && entry.operation === "unlink" && entry.path === recoveryPath,
    );
    const guardRemovalPublished = operations.findIndex(
      (entry, index) => index > guardRemoved && entry.operation === "fsync-directory" && entry.path === root,
    );
    assert.ok(guardMkdir >= 0 && guardMkdir < guardPublished);
    assert.ok(guardPublished < staleLeaseRemoved);
    assert.ok(staleLeaseRemoved < replacementLeaseLink);
    assert.ok(replacementLeaseLink < replacementLeasePublished);
    assert.ok(replacementLeasePublished < guardRemoved);
    assert.ok(guardRemoved < guardRemovalPublished);
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
    const beforeRejectedClaim = readFileSync(join(root, "credentials", "active-runner-token"));
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST),
      /stop every pre-upgrade runner.*--adopt-legacy-data-dir/,
    );
    assert.equal(existsSync(join(root, ".wollipog-runner-active-v1.lock")), false);
    assert.equal(existsSync(join(root, ".wollipog-runner-owner-v1.json")), false);
    assert.deepEqual(readFileSync(join(root, "credentials", "active-runner-token")), beforeRejectedClaim);

    const adopted = acquireRunnerDataDirLease(root, FIRST, { adoptLegacyDataDir: true });
    assert.equal(adopted.migratedLegacyDataDir, true);
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "legacy-token");
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");
    if (process.platform !== "win32") assert.equal(statSync(adopted.credentialFile).mode & 0o777, 0o600);
    const pending = stageRunnerCredentialFile(root, "newly-issued-token", FIRST);
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "legacy-token");
    pending.promote();
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "newly-issued-token");
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");
    const owner = JSON.parse(readFileSync(join(root, ".wollipog-runner-owner-v1.json"), "utf8")) as {
      ownerHash: string;
      legacyMigration: { authorization: string; authorizedAt: string };
    };
    assert.equal(owner.ownerHash, runnerDataDirOwnerHash(FIRST));
    assert.equal(owner.legacyMigration.authorization, "--adopt-legacy-data-dir");
    assert.equal(Number.isNaN(Date.parse(owner.legacyMigration.authorizedAt)), false);
    adopted.release();

    mkdirSync(join(mismatchRoot, "credentials"));
    writeFileSync(join(mismatchRoot, "credentials", "active-runner-token"), "other-token", { mode: 0o600 });
    const rotated = acquireRunnerDataDirLease(mismatchRoot, FIRST, { adoptLegacyDataDir: true });
    assert.equal(readFileSync(rotated.credentialFile, "utf8"), "other-token");
    rotated.release();

    mkdirSync(join(missingRoot, "sessions"));
    assert.throws(() => acquireRunnerDataDirLease(missingRoot, FIRST), /--adopt-legacy-data-dir/);
    const neverRegistered = acquireRunnerDataDirLease(missingRoot, FIRST, { adoptLegacyDataDir: true });
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

test("explicit legacy adoption fails closed when the requested root belongs to another owner", () => {
  const root = tempRoot();
  try {
    const first = acquireRunnerDataDirLease(root, FIRST);
    first.release();
    const ownerBefore = readFileSync(join(root, ".wollipog-runner-owner-v1.json"));
    const replacementRoot = join(root, "runner-instances", runnerDataDirOwnerHash(SECOND));
    assert.throws(
      () => acquireRunnerDataDirLease(root, SECOND, { adoptLegacyDataDir: true }),
      /already owned by another runner.*refusing to record legacy adoption/,
    );
    assert.deepEqual(readFileSync(join(root, ".wollipog-runner-owner-v1.json")), ownerBefore);
    assert.equal(existsSync(replacementRoot), false, "an adoption attempt never creates a replacement namespace");

    const isolated = acquireRunnerDataDirLease(root, SECOND);
    assert.equal(isolated.dataDir, replacementRoot, "ordinary foreign-owner startup remains safely namespaced");
    isolated.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit legacy adoption fails closed if a foreign owner appears after its lease is published", () => {
  const root = tempRoot();
  try {
    const ownerPath = join(root, ".wollipog-runner-owner-v1.json");
    const leasePath = join(root, ".wollipog-runner-active-v1.lock");
    const foreignOwner = {
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
    };
    let injected = false;
    assert.throws(
      () => acquireRunnerDataDirLease(root, SECOND, {
        adoptLegacyDataDir: true,
        beforeDurabilityOperationForTest: (operation, path) => {
          if (!injected && operation === "fsync-directory" && path === root && existsSync(leasePath)) {
            injected = true;
            writeFileSync(ownerPath, `${JSON.stringify(foreignOwner)}\n`, { mode: 0o600 });
          }
        },
      }),
      /became owned by another runner.*refusing to record adoption/,
    );
    assert.equal(injected, true, "the owner race is injected only after lease publication");
    assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), foreignOwner);
    assert.equal(existsSync(leasePath), false, "the failed claimant releases only its own lease");
    assert.equal(
      existsSync(join(root, "runner-instances", runnerDataDirOwnerHash(SECOND))),
      false,
      "an explicit adoption never falls through to a replacement namespace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected publication orders file and directory durability before ownership", () => {
  const root = tempRoot();
  const operations: Array<{ operation: string; path: string }> = [];
  try {
    mkdirSync(join(root, "credentials"));
    writeFileSync(join(root, "credentials", "active-runner-token"), "legacy-token", { mode: 0o600 });
    const claimed = acquireRunnerDataDirLease(root, FIRST, {
      adoptLegacyDataDir: true,
      beforeDurabilityOperationForTest: (operation, path) => operations.push({ operation, path }),
    });
    const credential = scopedRunnerCredentialFile(root, FIRST);
    const lease = join(root, ".wollipog-runner-active-v1.lock");
    const owner = join(root, ".wollipog-runner-owner-v1.json");
    const leaseLink = operations.findIndex((entry) => entry.operation === "link" && entry.path === lease);
    const leaseDirectorySync = operations.findIndex(
      (entry, index) => index > leaseLink && entry.operation === "fsync-directory" && entry.path === root,
    );
    const credentialLink = operations.findIndex((entry) => entry.operation === "link" && entry.path === credential);
    const credentialFileSync = operations.findIndex((entry) => entry.operation === "fsync-file" && entry.path.includes("active-runner-token.publish"));
    const credentialDirectorySync = operations.findIndex(
      (entry, index) => index > credentialLink && entry.operation === "fsync-directory" && entry.path === join(root, "credentials", "instances", runnerDataDirOwnerHash(FIRST)),
    );
    const ownerLink = operations.findIndex((entry) => entry.operation === "link" && entry.path === owner);
    const ownerDirectorySync = operations.findIndex(
      (entry, index) => index > ownerLink && entry.operation === "fsync-directory" && entry.path === root,
    );
    assert.ok(leaseLink >= 0 && leaseLink < leaseDirectorySync);
    assert.ok(leaseDirectorySync < credentialFileSync);
    assert.ok(credentialFileSync >= 0 && credentialFileSync < credentialLink);
    assert.ok(credentialLink < credentialDirectorySync);
    assert.ok(credentialDirectorySync < ownerLink);
    assert.ok(ownerLink < ownerDirectorySync);
    claimed.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory durability fault aborts migration before ownership and preserves legacy bytes", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "credentials"));
    writeFileSync(join(root, "credentials", "active-runner-token"), "legacy-token", { mode: 0o600 });
    const credentialDirectory = join(root, "credentials", "instances", runnerDataDirOwnerHash(FIRST));
    let injected = false;
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST, {
        adoptLegacyDataDir: true,
        beforeDurabilityOperationForTest: (operation, path) => {
          if (!injected && operation === "fsync-directory" && path === credentialDirectory) {
            injected = true;
            const error = new Error("injected directory sync failure") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
        },
      }),
      /injected directory sync failure/,
    );
    assert.equal(injected, true);
    assert.equal(existsSync(join(root, ".wollipog-runner-owner-v1.json")), false);
    assert.equal(existsSync(join(root, ".wollipog-runner-active-v1.lock")), false);
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");

    const retried = acquireRunnerDataDirLease(root, FIRST, { adoptLegacyDataDir: true });
    assert.equal(readFileSync(retried.credentialFile, "utf8"), "legacy-token");
    retried.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory sync error tolerance is narrowly limited to known Windows limitations", () => {
  for (const code of ["EINVAL", "EISDIR", "EPERM"]) {
    assert.equal(canIgnoreRunnerDataDirDirectorySyncError({ code } as NodeJS.ErrnoException, "win32"), true);
    assert.equal(canIgnoreRunnerDataDirDirectorySyncError({ code } as NodeJS.ErrnoException, "linux"), false);
  }
  for (const code of ["EACCES", "EBADF", "EIO"]) {
    assert.equal(canIgnoreRunnerDataDirDirectorySyncError({ code } as NodeJS.ErrnoException, "win32"), false);
  }
  assert.equal(canIgnoreRunnerDataDirDirectorySyncError({} as NodeJS.ErrnoException, "win32"), false);
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

test("credential scopes include both runner identity and normalized control-plane endpoint", () => {
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
  assert.notEqual(
    scopedRunnerCredentialFile(root, SECOND),
    scopedRunnerCredentialFile(root, { ...SECOND, controlPlaneUrl: "wss://manager.example.test:9443/runner" }),
  );
  assert.notEqual(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: `${FIRST.controlPlaneUrl}?tenant=other` }),
  );
  assert.notEqual(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, runnerId: "another-runner" }),
  );
});
