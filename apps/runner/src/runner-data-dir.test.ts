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

test("data root rejects concurrent use and remains permanently bound to its runner and control plane", () => {
  const root = tempRoot();
  try {
    const first = acquireRunnerDataDirLease(root, FIRST, "token-first");
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST, "token-first"),
      /already in use.*distinct --data-dir/,
    );
    assert.throws(
      () => acquireRunnerDataDirLease(root, SECOND, "token-second"),
      /already in use.*distinct --data-dir/,
    );
    assert.equal(existsSync(scopedRunnerCredentialFile(root, SECOND)), false);

    first.release();
    const restarted = acquireRunnerDataDirLease(root, FIRST, "token-first");
    restarted.release();
    assert.throws(
      () => acquireRunnerDataDirLease(root, SECOND, "token-second"),
      /belongs to a different runner or control plane.*distinct --data-dir/,
    );
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
      leaseId: "dead-lease",
      pid: 424242,
      hostname: "test-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    const reclaimed = acquireRunnerDataDirLease(root, FIRST, "token-first", {
      pid: 101,
      hostname: "test-host",
      isProcessAlive: () => false,
    });
    reclaimed.release();

    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      ownerHash: runnerDataDirOwnerHash(FIRST),
      leaseId: "remote-lease",
      pid: 202,
      hostname: "other-host",
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    assert.throws(
      () => acquireRunnerDataDirLease(root, FIRST, "token-first", { hostname: "test-host" }),
      /leased by host other-host.*distinct --data-dir/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy state migration requires the matching active credential and preserves rollback bytes", () => {
  const root = tempRoot();
  const mismatchRoot = tempRoot();
  const missingRoot = tempRoot();
  try {
    mkdirSync(join(root, "credentials"));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "credentials", "active-runner-token"), "legacy-token", { mode: 0o600 });
    const adopted = acquireRunnerDataDirLease(root, FIRST, "legacy-token");
    assert.equal(readFileSync(adopted.credentialFile, "utf8"), "legacy-token");
    assert.equal(readFileSync(join(root, "credentials", "active-runner-token"), "utf8"), "legacy-token");
    if (process.platform !== "win32") assert.equal(statSync(adopted.credentialFile).mode & 0o777, 0o600);
    adopted.release();

    mkdirSync(join(mismatchRoot, "credentials"));
    writeFileSync(join(mismatchRoot, "credentials", "active-runner-token"), "other-token", { mode: 0o600 });
    assert.throws(
      () => acquireRunnerDataDirLease(mismatchRoot, FIRST, "legacy-token"),
      /bound to another credential.*distinct --data-dir/,
    );
    assert.equal(existsSync(join(mismatchRoot, ".wollipog-runner-owner-v1.json")), false);
    assert.equal(existsSync(join(mismatchRoot, ".wollipog-runner-active-v1.lock")), false);

    mkdirSync(join(missingRoot, "sessions"));
    assert.throws(
      () => acquireRunnerDataDirLease(missingRoot, FIRST, "legacy-token"),
      /has no ownership marker or active credential.*distinct --data-dir/,
    );
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
    const first = acquireRunnerDataDirLease(firstRoot, FIRST, "token-first");
    const second = acquireRunnerDataDirLease(secondRoot, SECOND, "token-second");
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
  assert.notEqual(
    scopedRunnerCredentialFile(root, FIRST),
    scopedRunnerCredentialFile(root, { ...FIRST, controlPlaneUrl: "ws://127.0.0.1:9999/runner" }),
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
