import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  CheckpointRefOwnershipLedger,
  type CheckpointRefOwnershipClaim,
} from "./checkpoint-ref-ownership.js";

function tempLedger(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never, limit = 4) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ledger: new CheckpointRefOwnershipLedger(root, limit) };
}

function nativeClaim(root: string, sessionId = "s_owned"): CheckpointRefOwnershipClaim {
  return { sessionId, repoPath: resolve(root, "repo"), context: { kind: "native" } };
}

test("ownership claims survive restart and exact duplicate claims are idempotent", (t) => {
  const { root, ledger } = tempLedger(t);
  const claim = nativeClaim(root);
  const first = ledger.claim(claim);
  const duplicate = ledger.claim(claim);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(ledger.get(claim), first);
  assert.equal(ledger.get(nativeClaim(root, "s_missing")), null);
  assert.deepEqual(ledger.listSession("s_owned"), [first]);
  assert.deepEqual(new CheckpointRefOwnershipLedger(root, 4).list(), [first]);
  assert.equal(readdirSync(join(root, "checkpoint-ref-ownership")).filter((name) => name.endsWith(".json")).length, 1);
});

test("unsupported hard links fall back to exclusive durable publication", (t) => {
  const { root, ledger } = tempLedger(t);
  const claim = nativeClaim(root);
  (ledger as any).linkRecord = () => {
    throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
  };

  const first = ledger.claim(claim);
  assert.deepEqual(first, { version: 2, ...claim });
  assert.deepEqual(ledger.claim(claim), first, "an exact repeated claim remains idempotent");
  assert.deepEqual(new CheckpointRefOwnershipLedger(root, 4).list(), [first]);
  assert.equal(readdirSync(join(root, "checkpoint-ref-ownership")).some((name) => name.endsWith(".tmp")), false);
});

test("unsupported hard-link fallback rereads an identical concurrent publication", (t) => {
  const { root, ledger } = tempLedger(t);
  const claim = nativeClaim(root);
  const peer = new CheckpointRefOwnershipLedger(root, 4);
  let raced = false;
  (ledger as any).linkRecord = () => {
    if (!raced) {
      raced = true;
      peer.claim(claim);
    }
    throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
  };

  const accepted = ledger.claim(claim);
  assert.deepEqual(accepted, peer.get(claim));
  assert.equal(ledger.list().length, 1);
});

test("one session can own independent repository and execution-context tuples", (t) => {
  const { root, ledger } = tempLedger(t);
  const nativeA = ledger.claim(nativeClaim(root));
  const nativeB = ledger.claim({ ...nativeClaim(root), repoPath: resolve(root, "other") });
  const wsl = ledger.claim({ sessionId: "s_owned", repoPath: "/repo", context: { kind: "wsl", distro: "Ubuntu" } });
  assert.deepEqual(
    new Set(ledger.listSession("s_owned").map((record) => `${record.context.kind}:${record.repoPath}`)),
    new Set([nativeA, nativeB, wsl].map((record) => `${record.context.kind}:${record.repoPath}`)),
  );
  assert.deepEqual(ledger.get(nativeA), nativeA);
  assert.deepEqual(ledger.get(nativeB), nativeB);
  assert.deepEqual(ledger.get(wsl), wsl);
});

test("independent ledger instances publish concurrent tuple claims without clobbering", async (t) => {
  const { root, ledger } = tempLedger(t);
  const peer = new CheckpointRefOwnershipLedger(root, 4);
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => ledger.claim(nativeClaim(root))),
    Promise.resolve().then(() => peer.claim({ ...nativeClaim(root), repoPath: resolve(root, "other") })),
  ]);
  assert.deepEqual(
    new Set(ledger.listSession("s_owned").map((record) => record.repoPath)),
    new Set([first.repoPath, second.repoPath]),
  );
});

test("execution-context transfer retains and reclaims each exact tuple independently", (t) => {
  const { root, ledger } = tempLedger(t);
  const native = ledger.claim(nativeClaim(root));
  const wsl = ledger.claim({
    sessionId: "s_owned",
    repoPath: "/srv/repo",
    context: { kind: "wsl", distro: "Ubuntu" },
  });
  ledger.remove(native);
  assert.deepEqual(ledger.listSession("s_owned"), [wsl]);
  ledger.remove(wsl);
  assert.deepEqual(ledger.listSession("s_owned"), []);
});

test("claims require safe session ids, canonical absolute repository paths, and strict contexts", (t) => {
  const { root, ledger } = tempLedger(t);
  assert.throws(() => ledger.claim({ ...nativeClaim(root), sessionId: "../escape" }), /record is invalid/);
  assert.throws(() => ledger.claim({ ...nativeClaim(root), repoPath: "relative/repo" }), /record is invalid/);
  assert.throws(
    () => ledger.claim({ sessionId: "s_wsl", repoPath: "/srv/../repo", context: { kind: "wsl", distro: "Ubuntu" } }),
    /record is invalid/,
  );
  assert.throws(
    () => ledger.claim({ sessionId: "s_wsl", repoPath: "/srv/repo", context: { kind: "wsl", distro: " Ubuntu " } }),
    /record is invalid/,
  );
});

test("the ledger fails closed at its hard record limit without evicting proof", (t) => {
  const { root, ledger } = tempLedger(t, 2);
  ledger.claim(nativeClaim(root, "s_one"));
  ledger.claim({ ...nativeClaim(root, "s_one"), repoPath: resolve(root, "other") });
  assert.throws(() => ledger.claim(nativeClaim(root, "s_three")), /reached its 2-record safety limit/);
  assert.equal(ledger.listSession("s_one").length, 2);
});

test("corrupt or filename-mismatched records stop reconciliation and remain for inspection", (t) => {
  const { root, ledger } = tempLedger(t);
  ledger.claim(nativeClaim(root));
  const dir = join(root, "checkpoint-ref-ownership");
  const [name] = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  assert.ok(name);
  const path = join(dir, name);
  writeFileSync(path, readFileSync(path, "utf8").replace("s_owned", "s_other"));
  assert.throws(() => ledger.list(), /does not match its filename/);
  assert.equal(existsSync(path), true);
});

test("removal requires the exact durable claim and persists across restart", (t) => {
  const { root, ledger } = tempLedger(t);
  const record = ledger.claim(nativeClaim(root));
  ledger.claim({ ...nativeClaim(root), repoPath: resolve(root, "other") });
  assert.equal(ledger.list().length, 2);
  ledger.remove(record);
  ledger.remove(record);
  assert.deepEqual(new CheckpointRefOwnershipLedger(root, 4).listSession("s_owned").map((item) => item.repoPath), [
    resolve(root, "other"),
  ]);
});

test("Windows tolerates filesystem-specific directory fsync errors for claim and removal", {
  skip: process.platform !== "win32",
}, (t) => {
  const { root, ledger } = tempLedger(t);
  (ledger as any).openDirectoryForSync = () => {
    throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
  };

  const record = ledger.claim(nativeClaim(root));
  assert.deepEqual(ledger.list(), [record]);
  assert.doesNotThrow(() => ledger.remove(record));
  assert.deepEqual(new CheckpointRefOwnershipLedger(root, 4).list(), []);
});
