import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { captureProviderAccountsConfigPreimage, writeProviderAccountsConfig } from "./config.js";
import { AccountConfigPublicationError } from "./provider-account-config-publication.js";
import type { NativeCapture } from "./provider-account-config-windows-protocol.js";
declare const __WACW_FIXTURE_ENGINE_SHA__: string;
const onlyWindows = { skip: process.platform !== "win32" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function fixtureEngine(): {
  capture(path: string): NativeCapture;
  publish(request: object): void;
  createSyntheticFixture(path: string, mode: "private" | "foreign-write" | "null-dacl" | "full-store"): void;
  foreignOwnerPath(): string;
} {
  const file = join(dirname(__filename), "provider-account-config-windows-fixture-engine.cjs");
  assert.equal(sha(readFileSync(file)), __WACW_FIXTURE_ENGINE_SHA__);
  return createRequire(__filename)(file);
}
// Fixtures are retained: no implicit recursive cleanup or credential/HOME retirement claim.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-config-")), path = join(root, "runner.json");
  fixtureEngine().createSyntheticFixture(path, "private");
  return { root, path, prefix: ".runner.json.account-publications-win-v1." };
}
function refused(action: () => unknown) { assert.throws(action, (e: unknown) => e instanceof AccountConfigPublicationError && e.publication === "not_published"); }

test("native Windows account-config default dispatch enrolls add and remove without changing HOME strings", onlyWindows, () => {
  const f = fixture(), keep = { id: "work", label: "Work", provider: "claude" as const, directory: "C:\\canonical\\HOME" };
  const before = readFileSync(f.path); const pre = captureProviderAccountsConfigPreimage(f.path, []);
  assert.equal(pre.backend, "windows-wacw1"); assert.equal(readdirSync(f.root).length, 1, "capture creates no producers");
  writeProviderAccountsConfig(f.path, [keep], pre);
  const saved = JSON.parse(readFileSync(f.path, "utf8")); assert.equal(saved.untouched, true); assert.equal(saved.providerAccounts[0].directory, keep.directory);
  assert.notDeepEqual(readFileSync(f.path), before);
  for (const slot of ["anchor","header","journal"]) assert.ok(existsSync(join(f.root, f.prefix + slot)));
  assert.equal(existsSync(join(f.root, f.prefix + "guard")), false);
  const second = captureProviderAccountsConfigPreimage(f.path, [keep]); assert.equal(second.revision, 1);
  writeProviderAccountsConfig(f.path, [], second); assert.equal(captureProviderAccountsConfigPreimage(f.path, []).revision, 2);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).untouched, true);
});

test("native Windows account-config rejects foreign writable and null DACL plus actual foreign owner", onlyWindows, () => {
  for (const mode of ["foreign-write", "null-dacl"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-account-config-")), path = join(root, "runner.json");
    fixtureEngine().createSyntheticFixture(path, mode); const before = readFileSync(path);
    refused(() => captureProviderAccountsConfigPreimage(path, [])); assert.deepEqual(readFileSync(path), before); assert.equal(readdirSync(root).length, 1);
  }
  // Fixture assembly first verifies the returned OS file really has a foreign owner; no owner spoof or host ACL edit.
  refused(() => captureProviderAccountsConfigPreimage(fixtureEngine().foreignOwnerPath(), []));
});

test("native Windows account-config refuses hardlinks streams and reparse ancestors", onlyWindows, () => {
  const hard = fixture(); linkSync(hard.path, join(hard.root, "linked")); refused(() => captureProviderAccountsConfigPreimage(hard.path, []));
  const stream = fixture(); writeFileSync(stream.path + ":unexpected", "synthetic"); refused(() => captureProviderAccountsConfigPreimage(stream.path, []));
  const junction = fixture(), alias = join(junction.root, "alias"); symlinkSync(junction.root, alias, "junction");
  refused(() => captureProviderAccountsConfigPreimage(join(alias, "runner.json"), []));
});

test("native Windows account-config fences stale preimages and refuses retained partial stores", onlyWindows, () => {
  const f = fixture(), pre = captureProviderAccountsConfigPreimage(f.path, []); writeProviderAccountsConfig(f.path, [], pre);
  const saved = readFileSync(f.path); refused(() => writeProviderAccountsConfig(f.path, [], pre)); assert.deepEqual(readFileSync(f.path), saved);
  for (const slot of ["guard", "config.pending", "unknown", "header"] as const) {
    const p = fixture(); writeFileSync(join(p.root, p.prefix + slot), "retained"); const before = readFileSync(p.path);
    refused(() => captureProviderAccountsConfigPreimage(p.path, [])); assert.deepEqual(readFileSync(p.path), before);
  }
  const legacy = fixture(); mkdirSync(join(legacy.root, ".runner.json.account-publications-v1"));
  refused(() => captureProviderAccountsConfigPreimage(legacy.path, []));
});

test("native Windows account-config reserves capacity before producer growth", onlyWindows, () => {
  const f = fixture(), pre = captureProviderAccountsConfigPreimage(f.path, []), before = readFileSync(f.path);
  const accounts = [{ id: "large", label: "x".repeat(2 * 1024 * 1024), provider: "claude" as const, directory: "C:\\synthetic" }];
  refused(() => writeProviderAccountsConfig(f.path, accounts, pre)); assert.deepEqual(readFileSync(f.path), before); assert.equal(readdirSync(f.root).length, 1);
});

test("native Windows account-config retains a full store and refuses the next intent before growth", onlyWindows, () => {
  const root=mkdtempSync(join(tmpdir(),"wollipog-account-config-")),path=join(root,"runner.json");
  fixtureEngine().createSyntheticFixture(path,"full-store");const pre=captureProviderAccountsConfigPreimage(path,[]);assert.equal(pre.revision,4096);
  const names=readdirSync(root).sort(),bytes=names.map(name=>readFileSync(join(root,name)));
  refused(()=>writeProviderAccountsConfig(path,[],pre));assert.deepEqual(readdirSync(root).sort(),names);
  assert.deepEqual(names.map(name=>readFileSync(join(root,name))),bytes);
});

test("native Windows account-config fault-build boundaries retain evidence and classify known publication", onlyWindows, () => {
  const engine = fixtureEngine();
  for (let fault = 1; fault <= 6; fault++) {
    const f = fixture(), old = engine.capture(f.path), next = Buffer.from('{"providerAccounts":[],"untouched":true,"after":true}');
    let error: unknown;
    try { engine.publish({ path: f.path, stamp: old.stamp, parentBirth: old.parentBirth, beforeAccounts: sha("[]"), afterAccounts: sha("[]"), next, fault }); }
    catch (e) { error = e; }
    assert.ok(error && typeof error === "object" && "publication" in error);
    assert.equal((error as { publication: string }).publication, fault >= 5 ? "committed" : fault === 4 ? "unknown" : "not_published");
    assert.equal(existsSync(join(f.root, f.prefix + "guard")), true);
    assert.equal(JSON.parse(readFileSync(f.path, "utf8")).after === true, fault >= 5);
    refused(() => captureProviderAccountsConfigPreimage(f.path, []));
  }
});
