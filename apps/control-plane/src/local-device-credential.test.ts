import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  defaultLocalDeviceTokenPath,
  loadOrCreateLocalDeviceToken,
  localDeviceTokenPath,
  localPairingUrl,
  validLocalDeviceToken,
} from "./local-device-credential.js";

function createCredentialInChild(path: string): Promise<string> {
  const moduleUrl = new URL("./local-device-credential.ts", import.meta.url).href;
  const source = `const mod = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(mod.loadOrCreateLocalDeviceToken(process.env.LOCAL_TOKEN_TEST_PATH));`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    env: { ...process.env, LOCAL_TOKEN_TEST_PATH: path },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`credential child exited ${code}: ${stderr}`)));
  });
}

test("local credential is stable, protected, newline-terminated, and database-specific", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstPath = defaultLocalDeviceTokenPath(join(root, "first.db"));
  const secondPath = defaultLocalDeviceTokenPath(join(root, "second.db"));
  const first = loadOrCreateLocalDeviceToken(firstPath);
  const loaded = loadOrCreateLocalDeviceToken(firstPath);
  const second = loadOrCreateLocalDeviceToken(secondPath);

  assert.equal(loaded, first);
  assert.notEqual(second, first);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(firstPath, "utf8"), `${first}\n`);
  assert.equal(readFileSync(secondPath, "utf8"), `${second}\n`);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(firstPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
  }
});

test("concurrent first starts atomically converge on one complete credential", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "token");
  const tokens = await Promise.all([
    createCredentialInChild(path),
    createCredentialInChild(path),
    createCredentialInChild(path),
  ]);
  assert.equal(new Set(tokens).size, 1);
  assert.match(tokens[0]!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(path, "utf8"), `${tokens[0]}\n`);
});

test("filesystems without hard-link support fall back to exclusive publication", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-no-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "token");
  const unsupported = Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
  const token = loadOrCreateLocalDeviceToken(path, {
    link() { throw unsupported; },
  });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(path, "utf8"), `${token}\n`);
  assert.equal(loadOrCreateLocalDeviceToken(path), token);
});

test("configured credential path wins and resolves to an absolute path", () => {
  assert.equal(
    localDeviceTokenPath("ignored.db", { CONTROL_PLANE_LOCAL_TOKEN_FILE: "./secure/local.token" }),
    resolve("./secure/local.token"),
  );
  assert.equal(localDeviceTokenPath("./data/test.db", {}), defaultLocalDeviceTokenPath("./data/test.db"));
});

test("existing malformed credentials fail closed instead of silently rotating", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "token");
  writeFileSync(path, "short\n", { mode: 0o600 });
  assert.throws(() => loadOrCreateLocalDeviceToken(path), /invalid contents/);
  assert.equal(readFileSync(path, "utf8"), "short\n");
});

test("credential symlinks are rejected", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const link = join(root, "token");
  writeFileSync(target, `${"a".repeat(43)}\n`, { mode: 0o600 });
  symlinkSync(target, link);
  assert.throws(() => loadOrCreateLocalDeviceToken(link), /not a regular file/);
});

test("pairing URLs and credential shape are strict", () => {
  const token = "a".repeat(43);
  assert.equal(validLocalDeviceToken(token), true);
  assert.equal(validLocalDeviceToken("a".repeat(42)), false);
  assert.equal(localPairingUrl(4317, token), `http://127.0.0.1:4317/#pair=${token}`);
  assert.throws(() => localPairingUrl(0, token), /invalid control-plane port/);
  assert.throws(() => localPairingUrl(4317, "bad"), /invalid local device credential/);
});

test("credential permissions are healed on load", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-local-device-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "token");
  writeFileSync(path, `${"b".repeat(43)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.equal(loadOrCreateLocalDeviceToken(path), "b".repeat(43));
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
});
