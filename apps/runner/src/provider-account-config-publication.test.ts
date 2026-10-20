import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureProviderAccountsConfigPreimage, validateProviderAccounts, writeProviderAccountsConfig, type RunnerProviderAccount } from "./config.js";
import { AccountConfigPublicationError, accountConfigPublicationErrorMessage, publishAccountConfig, type AccountConfigPublicationTestHooks } from "./provider-account-config-publication.js";

const posixOnly = { skip: process.platform === "win32" };
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-account-publication-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "runner.json"), store = join(root, ".runner.json.account-publications-v1");
  const anchor = join(root, ".runner.json.account-publications-anchor-v1");
  const home = join(root, "operator-home"); mkdirSync(home);
  writeFileSync(join(home, "auth.json"), "synthetic credentials");
  writeFileSync(config, JSON.stringify({ secret: "synthetic-config-token", unrelated: { retained: true }, providerAccounts: [] }), { mode: 0o600 });
  const account: RunnerProviderAccount = { id: "work", label: "Private Label", provider: "claude", directory: home };
  const capture = (accounts: RunnerProviderAccount[] = []) => captureProviderAccountsConfigPreimage(config, accounts);
  const rows = () => readFileSync(join(store, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const publish = (hooks: AccountConfigPublicationTestHooks = {}) => publishAccountConfig(capture(), [account], validateProviderAccounts, hooks);
  return { root, config, store, anchor, home, account, capture, rows, publish };
}
function refusal(code: AccountConfigPublicationError["code"], publication: AccountConfigPublicationError["publication"] = "not_published") {
  return (e: unknown) => e instanceof AccountConfigPublicationError && e.code === code && e.publication === publication;
}

test("intent is durable before publication; only digests enter bounded history-incomplete evidence", posixOnly, t => {
  const f = fixture(t), before = readFileSync(f.config), observed: string[] = [];
  f.publish({ boundary: phase => {
    observed.push(phase);
    if (phase === "intent") {
      assert.deepEqual(readFileSync(f.config), before);
      assert.equal(f.rows()[0].kind, "intent");
      assert.equal(f.rows()[0].historyIncomplete, true);
      assert.equal(existsSync(f.anchor), true);
    }
  } });
  assert.deepEqual(observed, ["guard", "intent", "temporary", "before_rename", "renamed", "outcome"]);
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), {
    secret: "synthetic-config-token", unrelated: { retained: true }, providerAccounts: [f.account],
  });
  const rows = f.rows();
  assert.deepEqual(rows.map(r => [r.kind, r.revision, r.historyIncomplete]), [["intent", 1, true], ["published", 1, true]]);
  assert.equal(rows[0].ticket, rows[1].ticket);
  const evidence = readdirSync(f.store).map(name => readFileSync(join(f.store, name), "utf8")).join("\n") + readFileSync(f.anchor, "utf8");
  for (const sensitive of ["Private Label", "synthetic-config-token", f.home]) assert.equal(evidence.includes(sensitive), false);
  assert.equal(readFileSync(join(f.home, "auth.json"), "utf8"), "synthetic credentials");
  assert.equal(existsSync(join(f.store, "guard.json")), false);
  assert.equal(f.capture([f.account]).revision, 1);
});

test("another process completing an ABA publication fences a pre-await ticket", posixOnly, t => {
  const f = fixture(t), ticket = f.capture();
  const code = `import {captureProviderAccountsConfigPreimage as capture,writeProviderAccountsConfig as write} from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
    const path=${JSON.stringify(f.config)}, account=${JSON.stringify(f.account)};
    write(path,[account],capture(path,[])); write(path,[],capture(path,[account]));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 0, String(result.error ?? "") + result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).providerAccounts, []);
  const history = readFileSync(join(f.store, "journal.jsonl"));
  assert.throws(() => writeProviderAccountsConfig(f.config, [f.account], ticket), refusal("SOURCE_CHANGED"));
  assert.deepEqual(readFileSync(join(f.store, "journal.jsonl")), history);
  assert.equal(f.capture().revision, 2);
});

test("cooperating contender cannot acquire or steal the live guard", posixOnly, t => {
  const f = fixture(t);
  f.publish({ boundary: phase => {
    if (phase === "intent") {
      const guard = readFileSync(join(f.store, "guard.json"));
      assert.throws(() => f.capture(), refusal("SOURCE_BUSY"));
      assert.deepEqual(readFileSync(join(f.store, "guard.json")), guard);
    }
  } });
});

test("crashes at every durable boundary retain uncertainty and suppress further publication", posixOnly, t => {
  for (const phase of ["guard", "intent", "temporary", "before_rename", "renamed", "outcome"] as const) {
    const f = fixture(t), before = readFileSync(f.config);
    const expected = phase === "renamed" || phase === "outcome" ? "committed" : phase === "before_rename" ? "unknown" : "not_published";
    assert.throws(() => f.publish({ boundary: reached => { if (reached === phase) throw new Error("synthetic crash"); } }), refusal("IO", expected));
    if (expected === "committed") assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).providerAccounts, [f.account]);
    else assert.deepEqual(readFileSync(f.config), before);
    assert.throws(() => f.capture(expected === "committed" ? [f.account] : []), AccountConfigPublicationError);
    const retained = readdirSync(f.store).map(name => [name, readFileSync(join(f.store, name))] as const);
    assert.throws(() => f.capture(), AccountConfigPublicationError);
    for (const [name, bytes] of retained) assert.deepEqual(readFileSync(join(f.store, name)), bytes);
    assert.equal(readFileSync(join(f.home, "auth.json"), "utf8"), "synthetic credentials");
  }
});

test("operator edits between intent and rename are retained rather than overwritten", posixOnly, t => {
  const f = fixture(t), operatorBytes = '{"providerAccounts":[],"operator":"new decision"}';
  assert.throws(() => f.publish({ boundary: phase => { if (phase === "temporary") writeFileSync(f.config, operatorBytes); } }), refusal("SOURCE_CHANGED"));
  assert.equal(readFileSync(f.config, "utf8"), operatorBytes);
  assert.equal(f.rows().length, 1);
  assert.equal(existsSync(join(f.store, "guard.json")), true);
});

test("capacity is reserved before any producer grows; exhaustion is permanent for this epoch", posixOnly, t => {
  for (const limits of [{ records: 1 }, { recordBytes: 1 }, { totalBytes: 70_000 }]) {
    const f = fixture(t), before = readFileSync(f.config);
    assert.throws(() => f.publish({ limits }), refusal("CAPACITY"));
    assert.deepEqual(readFileSync(f.config), before);
    // Tiny record limits can refuse while bootstrapping controls, but never publish a config.
    if (existsSync(join(f.store, "journal.jsonl"))) assert.equal(readFileSync(join(f.store, "journal.jsonl")).length, 0);
  }
  const f = fixture(t); f.publish({ limits: { intents: 1, records: 2 } });
  const history = readFileSync(join(f.store, "journal.jsonl"));
  assert.throws(() => publishAccountConfig(f.capture([f.account]), [], validateProviderAccounts, { limits: { intents: 1, records: 2 } }), refusal("CAPACITY"));
  assert.deepEqual(readFileSync(join(f.store, "journal.jsonl")), history);
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).providerAccounts, [f.account]);
});

test("missing, substituted, linked, partial or unexpected evidence never resets the store", posixOnly, t => {
  for (const fault of ["missing-root", "missing-anchor", "replacement-root", "anchor-link", "journal-hardlink", "partial", "extra", "mode"] as const) {
    const f = fixture(t); f.publish();
    if (fault === "missing-root") renameSync(f.store, `${f.store}-retained`);
    if (fault === "missing-anchor") renameSync(f.anchor, `${f.anchor}-retained`);
    if (fault === "replacement-root") { renameSync(f.store, `${f.store}-retained`); mkdirSync(f.store, { mode: 0o700 }); }
    if (fault === "anchor-link") { renameSync(f.anchor, `${f.anchor}-retained`); symlinkSync(`${f.anchor}-retained`, f.anchor); }
    if (fault === "journal-hardlink") linkSync(join(f.store, "journal.jsonl"), join(f.root, "journal-link"));
    if (fault === "partial") writeFileSync(join(f.store, "journal.jsonl"), "{", { flag: "a" });
    if (fault === "extra") writeFileSync(join(f.store, "unreserved-partial"), "x");
    if (fault === "mode") chmodSync(f.store, 0o750);
    const config = readFileSync(f.config);
    assert.throws(() => f.capture([f.account]), AccountConfigPublicationError, fault);
    assert.deepEqual(readFileSync(f.config), config);
  }
});

test("unsafe config files and changed account decisions refuse before creating evidence", posixOnly, t => {
  for (const fault of ["link", "hardlink", "writable", "accounts"] as const) {
    const f = fixture(t);
    if (fault === "link") { renameSync(f.config, `${f.config}-target`); symlinkSync(`${f.config}-target`, f.config); }
    if (fault === "hardlink") linkSync(f.config, `${f.config}-alias`);
    if (fault === "writable") chmodSync(f.config, 0o666);
    assert.throws(() => f.capture(fault === "accounts" ? [f.account] : []), AccountConfigPublicationError);
    assert.equal(existsSync(f.store), false);
  }
});

test("publication refusal guidance is actionable without disclosing raw filesystem errors", () => {
  const fallback = "The runner configuration could not be updated.";
  const guidance = accountConfigPublicationErrorMessage(new AccountConfigPublicationError("not_published", "STORE_UNVERIFIABLE"), fallback);
  assert.match(guidance, /owned by the runner OS account/u);
  assert.match(guidance, /not group- or world-writable/u);
  assert.match(guidance, /no automatic permission change or repair/u);
  assert.match(guidance, /Windows requires a supported native proof adapter/u);
  assert.equal(accountConfigPublicationErrorMessage(new Error("secret-config-path and credential-content"), fallback), fallback);
  assert.equal(accountConfigPublicationErrorMessage(new AccountConfigPublicationError("not_published", "IO"), fallback), fallback);
  for (const publication of ["unknown", "committed"] as const) {
    const error = new AccountConfigPublicationError(publication, "STORE_UNVERIFIABLE");
    assert.equal(accountConfigPublicationErrorMessage(error, fallback), error.message);
  }
});

test("a Windows backend ticket cannot enter the POSIX publisher", posixOnly, t => {
  const f=fixture(t), pre=captureProviderAccountsConfigPreimage(f.config,[]);
  assert.throws(()=>publishAccountConfig({...pre,backend:"windows-wacw1"},[],validateProviderAccounts),
    (e:unknown)=>e instanceof AccountConfigPublicationError && e.code==="SOURCE_CHANGED");
});
