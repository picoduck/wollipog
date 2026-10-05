import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ReleaseStaging, stagingFilesystem, validateSelectedAssets, type StagingFilesystem } from "./release-staging.js";
import { Readable } from "node:stream";
import {
  RUNNER_TARGET_TRIPLES,
  controlPlaneArtifactName,
  runnerArtifactNames,
  WEB_BUNDLE_ASSET_NAME as PRODUCER_WEB_BUNDLE,
} from "../scripts/runner-artifacts.mjs";
import {
  WEB_BUNDLE_ASSET_NAME,
  controlPlaneAssetName,
  downloadVerifiedAsset,
  downloadToFile,
  findAsset,
  hostTargetTriple,
  parseChecksumManifest,
  resolveRelease,
  runnerAssetName,
  type Downloader,
} from "./release-assets.js";

test("release asset names stay in sync with the release producer", () => {
  assert.equal(WEB_BUNDLE_ASSET_NAME, PRODUCER_WEB_BUNDLE);
  for (const triple of RUNNER_TARGET_TRIPLES as readonly string[]) {
    assert.equal(runnerAssetName(triple), runnerArtifactNames(triple).canonical);
    assert.equal(controlPlaneAssetName(triple), controlPlaneArtifactName(triple));
  }
  assert.equal(hostTargetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(hostTargetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(hostTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(hostTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTargetTriple("freebsd", "x64"), null);
  assert.equal(hostTargetTriple("linux", "ia32"), null);
});

test("resolveRelease reads latest or an exact tag and keeps only usable digests", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchJson = async (url: string, headers: Record<string, string>) => {
    seen.push({ url, headers });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        tag_name: "v1.2.3",
        assets: [
          { name: "wollipog-runner-x86_64-unknown-linux-gnu", digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://dl/r", size: 10 },
          { name: "odd", digest: "md5:nope", browser_download_url: "https://dl/o", size: 1 },
          { name: "broken" },
        ],
      }),
    };
  };
  const latest = await resolveRelease(fetchJson, { token: "tok" });
  assert.equal(latest.tag, "v1.2.3");
  assert.equal(latest.version, "1.2.3");
  assert.equal(seen[0]!.url, "https://api.github.com/repos/picoduck/wollipog/releases/latest");
  assert.equal(seen[0]!.headers.authorization, "Bearer tok");
  assert.deepEqual(latest.assets.map((asset) => [asset.name, asset.digest]), [
    ["wollipog-runner-x86_64-unknown-linux-gnu", `sha256:${"a".repeat(64)}`],
    ["odd", null],
  ]);
  await resolveRelease(fetchJson, { tag: "v1.2.3" });
  assert.equal(seen[1]!.url, "https://api.github.com/repos/picoduck/wollipog/releases/tags/v1.2.3");
  assert.equal(seen[1]!.headers.authorization, undefined);
  await assert.rejects(resolveRelease(fetchJson, { tag: "latest" }), /must look like v1\.2\.3/u);
  await assert.rejects(resolveRelease(async () => ({ ok: false, status: 404, text: async () => "" }), {}), /no published release found/u);
  await assert.rejects(resolveRelease(async () => ({ ok: true, status: 200, text: async () => "<html>" }), {}), /not valid JSON/u);
  await assert.rejects(resolveRelease(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "nightly", assets: [] }) }), {}), /no usable tag name/u);
  // A tag the tags endpoint does not know (a draft) is found through the release list when a
  // token is present; without a token the 404 stands.
  const draftFetch = async (url: string) => url.includes("/releases/tags/")
    ? { ok: false, status: 404, text: async () => "" }
    : { ok: true, status: 200, text: async () => JSON.stringify([
        { tag_name: "v1.2.3", draft: false, assets: [] },
        { tag_name: "v0.0.0-test.9", draft: true, assets: [{ name: "SHA256SUMS", digest: `sha256:${"b".repeat(64)}`, browser_download_url: "https://dl/s", size: 3 }] },
      ]) };
  const draft = await resolveRelease(draftFetch, { tag: "v0.0.0-test.9", token: "tok" });
  assert.equal(draft.tag, "v0.0.0-test.9");
  assert.equal(draft.version, "0.0.0-test.9");
  assert.deepEqual(draft.assets.map((asset) => asset.name), ["SHA256SUMS"]);
  await assert.rejects(resolveRelease(draftFetch, { tag: "v0.0.0-test.9" }), /no release v0\.0\.0-test\.9 found/u);
  await assert.rejects(resolveRelease(draftFetch, { tag: "v9.9.9", token: "tok" }), /no release v9\.9\.9 found/u);
  // The tag names a staging directory, so a "latest" release with a path-like tag is refused too.
  await assert.rejects(resolveRelease(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "v1.2.3/../../etc", assets: [] }) }), {}), /no usable tag name/u);
  assert.throws(() => findAsset(latest, "missing"), /has no asset named missing/u);
});

test("checksum manifests parse strictly and downloads are verified against publisher and manifest digests", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-release-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified bytes\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = parseChecksumManifest(`${digest}  wollipog-runner-x86_64-unknown-linux-gnu\n${"b".repeat(64)}  wollipog-web.tar.gz\n`);
  assert.equal(manifest.get("wollipog-runner-x86_64-unknown-linux-gnu"), digest);
  assert.throws(() => parseChecksumManifest("garbage\n"), /invalid SHA256SUMS line/u);
  assert.throws(() => parseChecksumManifest(`${digest}  a\n${digest}  a\n`), /duplicate SHA256SUMS entry/u);
  assert.throws(() => parseChecksumManifest(`${digest}  ../evil\n`), /invalid SHA256SUMS line/u);

  const download: Downloader = async (_url, sink) => { sink.end(bytes); };
  const asset = { name: "wollipog-runner-x86_64-unknown-linux-gnu", digest: `sha256:${digest}`, url: "https://dl/r", size: bytes.length };
  const staging = ReleaseStaging.create(root, { mode: "user", serviceUid: null }, "v1.2.3", [asset]);
  t.after(() => staging.finish());
  const destination = join(staging.path, asset.name);
  assert.equal(await downloadVerifiedAsset(download, asset, destination, { staging, manifest }), digest);
  assert.deepEqual(readFileSync(destination), bytes);

  await assert.rejects(downloadVerifiedAsset(download, { ...asset, digest: null }, join(root, "x"), { staging }), /no valid GitHub SHA-256 digest/u);
  await assert.rejects(downloadVerifiedAsset(download, { ...asset, name: "wollipog-web.tar.gz" }, join(root, "y"), { staging, manifest }), /SHA256SUMS and the GitHub digest disagree/u);
  await assert.rejects(downloadVerifiedAsset(download, { ...asset, name: "unlisted" }, join(root, "z"), { staging, manifest }), /SHA256SUMS has no entry for unlisted/u);
  assert.equal(staging.finish(), null);
  const next = ReleaseStaging.create(root, { mode: "user", serviceUid: null }, "v1.2.4", [asset]);
  const tampered: Downloader = async (_url, sink) => { sink.end(Buffer.alloc(bytes.length)); };
  await assert.rejects(downloadVerifiedAsset(tampered, asset, join(next.path, asset.name), { staging: next, manifest }), /failed SHA-256 verification/u);
  assert.equal(existsSync(join(next.path, asset.name)), false);
  assert.equal(next.finish(), null);
  const headersSeen: Record<string, string>[] = [];
  const recording: Downloader = async (_url, sink, headers) => { headersSeen.push(headers); sink.end(bytes); };
  const last = ReleaseStaging.create(root, { mode: "user", serviceUid: null }, "v1.2.5", [asset]);
  await downloadVerifiedAsset(recording, asset, join(last.path, asset.name), { staging: last, token: "tok" });
  assert.equal(headersSeen[0]!.authorization, "Bearer tok");
  assert.equal(headersSeen[0]!.accept, "application/octet-stream");
  assert.equal(last.finish(), null);
});

const linuxTest = (name: string, fn: (t: TestContext) => Promise<void> | void) => test(name, { skip: process.platform !== "linux" }, fn);
const fixtureBytes = Buffer.from("fixture");
const fixtureAsset = { name: "wollipog-runner-x86_64-unknown-linux-gnu", size: fixtureBytes.length,
  digest: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`, url: "https://fixture.invalid/runner" };
function dataDirectory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-download-owned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function attempt(root: string, fs: StagingFilesystem = stagingFilesystem, tag = "v1.2.3"): ReleaseStaging {
  return ReleaseStaging.create(root, { mode: "user", serviceUid: null }, tag, [fixtureAsset], fs);
}

linuxTest("failed, short, oversized and mismatched streams never publish and current receipts retire", async (t) => {
  const cases: Array<{ name: string; download: Downloader; error: RegExp }> = [
    { name: "callback rejection", download: async (_url, sink) => { sink.write(fixtureBytes); throw new Error("fixture rejection"); }, error: /fixture rejection/u },
    { name: "short", download: async (_url, sink) => { sink.end("x"); }, error: /download length/u },
    { name: "oversized", download: async (_url, sink) => { sink.end(Buffer.alloc(fixtureBytes.length + 1)); }, error: /exceeds its declared/u },
    { name: "hash mismatch", download: async (_url, sink) => { sink.end(Buffer.alloc(fixtureBytes.length)); }, error: /failed SHA-256/u },
  ];
  for (const { name, download, error } of cases) {
    const root = dataDirectory(t);
    const owned = attempt(root);
    const destination = join(owned.path, fixtureAsset.name);
    await assert.rejects(downloadVerifiedAsset(download, fixtureAsset, destination, { staging: owned }), error, name);
    assert.equal(existsSync(destination), false, name);
    if (name === "oversized") {
      const partial = readdirSync(owned.path).find((entry) => entry.endsWith(".partial"))!;
      assert.equal(readFileSync(join(owned.path, partial)).length, 0, "oversized chunk rejected before disk write");
    }
    assert.equal(owned.finish(), null, name);
    assert.equal(existsSync(owned.path), false, name);
    const retry = attempt(root, stagingFilesystem, "v9.8.7");
    assert.equal(retry.finish(), null, "caught failure allows a different-tag retry without stale adoption");
  }
});

linuxTest("production stream failure and asynchronous verification leave the final name absent", async (t) => {
  const root = dataDirectory(t);
  const owned = attempt(root);
  const destination = join(owned.path, fixtureAsset.name);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Readable.toWeb(Readable.from((async function* () {
    yield fixtureBytes;
    throw new Error("fixture stream failure");
  })())));
  try { await assert.rejects(downloadVerifiedAsset(downloadToFile, fixtureAsset, destination, { staging: owned }), /fixture stream failure/u); }
  finally { globalThis.fetch = fetch; }
  assert.equal(existsSync(destination), false);
  assert.equal(owned.finish(), null);
  const retry = attempt(root);
  await downloadVerifiedAsset(async (_url, sink) => {
    sink.write(fixtureBytes);
    assert.equal(existsSync(join(retry.path, fixtureAsset.name)), false, "streamed bytes remain private before hash");
  }, fixtureAsset, join(retry.path, fixtureAsset.name), { staging: retry });
  assert.deepEqual(readFileSync(join(retry.path, fixtureAsset.name)), fixtureBytes);
  let duplicateBodies = 0;
  await assert.rejects(downloadVerifiedAsset(async () => { duplicateBodies++; }, fixtureAsset, join(retry.path, fixtureAsset.name), { staging: retry }), /already admitted/u);
  assert.equal(duplicateBodies, 0, "a retry cannot allocate extra bytes beyond this attempt's admitted sum");
  assert.equal(retry.finish(), null);
});

linuxTest("same and different tags preserve live or simulated interrupted reservations and legacy bytes", (t) => {
  const root = dataDirectory(t);
  const owned = attempt(root);
  const marker = readFileSync(join(owned.path, "owner.json"));
  for (const tag of ["v1.2.3", "v9.8.7"]) {
    assert.throws(() => attempt(root, stagingFilesystem, tag), /occupied|unknown/u);
    assert.deepEqual(readFileSync(join(owned.path, "owner.json")), marker);
  }
  assert.equal(owned.finish(), null);
  const parent = join(root, "upgrades");
  const interrupted = join(parent, "download-attempt-v1");
  mkdirSync(interrupted, { recursive: true, mode: 0o700 });
  writeFileSync(join(interrupted, "owner.json"), "{incomplete", { mode: 0o600 });
  for (const tag of ["v1.2.3", "v9.8.7"]) assert.throws(() => attempt(root, stagingFilesystem, tag), /occupied|unknown/u);
  assert.equal(readFileSync(join(interrupted, "owner.json"), "utf8"), "{incomplete");
  assert.deepEqual(readdirSync(parent), ["download-attempt-v1"]);
  const legacyRoot = dataDirectory(t);
  mkdirSync(join(legacyRoot, "upgrades", "v0.0.1"), { recursive: true, mode: 0o700 });
  writeFileSync(join(legacyRoot, "upgrades", "v0.0.1", "foreign"), "legacy");
  assert.throws(() => attempt(legacyRoot), /occupied|unknown/u);
  assert.equal(readFileSync(join(legacyRoot, "upgrades", "v0.0.1", "foreign"), "utf8"), "legacy");
});

linuxTest("no-replace publication and uncertain inventory preserve existing, symlinked and hardlinked evidence", async (t) => {
  for (const kind of ["existing", "symlink", "hardlink", "unknown"]) {
    const root = dataDirectory(t);
    const owned = attempt(root);
    const destination = join(owned.path, fixtureAsset.name);
    const foreign = join(root, "foreign");
    writeFileSync(foreign, "foreign");
    if (kind === "existing") writeFileSync(destination, "existing");
    if (kind === "symlink") symlinkSync(foreign, destination);
    if (kind === "unknown") writeFileSync(join(owned.path, "unknown"), "foreign");
    const download: Downloader = async (_url, sink) => {
      sink.end(fixtureBytes);
      if (kind === "hardlink") {
        const partial = readdirSync(owned.path).find((entry) => entry.endsWith(".partial"))!;
        linkSync(join(owned.path, partial), join(root, "extra-link"));
      }
    };
    if (kind === "unknown") await downloadVerifiedAsset(download, fixtureAsset, destination, { staging: owned });
    else await assert.rejects(downloadVerifiedAsset(download, fixtureAsset, destination, { staging: owned }));
    assert.match(owned.finish()!, /retained|uncertain/u);
    assert.equal(readFileSync(foreign, "utf8"), "foreign");
    assert.equal(existsSync(owned.path), true);
    if (kind === "existing") assert.equal(readFileSync(destination, "utf8"), "existing");
    if (kind === "symlink") assert.equal(readFileSync(destination, "utf8"), "foreign");
    if (kind === "hardlink") assert.deepEqual(readFileSync(join(root, "extra-link")), fixtureBytes);
  }
});

linuxTest("substituted attempt and incomplete inventory refuse cleanup without deleting evidence", (t) => {
  const root = dataDirectory(t);
  const owned = attempt(root);
  const retained = `${owned.path}-retained`;
  renameSync(owned.path, retained);
  mkdirSync(owned.path, { mode: 0o700 });
  writeFileSync(join(owned.path, "foreign"), "keep");
  assert.match(owned.finish()!, /substituted/u);
  assert.equal(existsSync(join(retained, "owner.json")), true);
  assert.equal(readFileSync(join(owned.path, "foreign"), "utf8"), "keep");

  const nextRoot = dataDirectory(t);
  let failInventory = false;
  const fs = { ...stagingFilesystem, directory: ((path, options) => {
    if (failInventory) throw new Error("fixture incomplete directory read");
    return stagingFilesystem.directory(path, options);
  }) as typeof stagingFilesystem.directory };
  const next = attempt(nextRoot, fs);
  failInventory = true;
  assert.match(next.finish()!, /incomplete directory read/u);
  assert.equal(existsSync(join(next.path, "owner.json")), true);
});

test("unsupported mutation platforms and invalid sizes refuse before creation", () => {
  for (const platform of ["win32", "darwin"] as const) {
    let mutations = 0;
    const fs = { ...stagingFilesystem, platform, mkdir: (() => { mutations++; }) as typeof stagingFilesystem.mkdir };
    assert.throws(() => attempt("/not-created", fs), /supported Linux/u);
    assert.equal(mutations, 0);
  }
  for (const size of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateSelectedAssets([{ ...fixtureAsset, size }]), /declared asset sizes/u);
  assert.throws(() => validateSelectedAssets([{ ...fixtureAsset, size: Number.MAX_SAFE_INTEGER }, { ...fixtureAsset, name: "SHA256SUMS" }]), /safe total/u);
  assert.throws(() => validateSelectedAssets([fixtureAsset, fixtureAsset]), /duplicate/u);
});

linuxTest("unsafe ancestry, symlink dataDir and unsupported filesystem preserve paths and refuse", (t) => {
  const root = dataDirectory(t);
  assert.throws(() => attempt(root, { ...stagingFilesystem, type: () => 0x6969n }), /unsupported filesystem/u);
  assert.equal(existsSync(join(root, "upgrades")), false);
  const alias = `${root}-symlink`;
  symlinkSync(root, alias);
  t.after(() => rmSync(alias));
  assert.throws(() => attempt(alias), /canonical|symlink/u);
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  chmodSync(root, 0o777);
  assert.throws(() => attempt(data), /unsafe ancestor/u);
  assert.equal(existsSync(join(data, "upgrades")), false);
});

linuxTest("initialization failures before and after current receipts safely adjudicate retirement and close handles", (t) => {
  for (const phase of ["parent-mkdir", "reservation-mkdir", "data-receipt", "parent-receipt", "parent-sync", "reservation-sync", "record-write", "record-sync", "record-read", "record-parent-sync", "reservation-receipt", "record-receipt"]) {
    const root = dataDirectory(t);
    const handles = new Map<number, string>();
    let faulted = false;
    const trigger = (name: string) => { if (!faulted && phase === name) { faulted = true; throw new Error(`fixture ${phase}`); } };
    const fs: StagingFilesystem = {
      ...stagingFilesystem,
      open: (...args) => { const fd = stagingFilesystem.open(...args); handles.set(fd, String(args[0])); return fd; },
      close: (fd) => { stagingFilesystem.close(fd); handles.delete(fd); },
      mkdir: ((path, options) => {
        if (String(path).endsWith("/upgrades")) trigger("parent-mkdir");
        if (String(path).endsWith("/download-attempt-v1")) trigger("reservation-mkdir");
        return stagingFilesystem.mkdir(path, options);
      }) as typeof stagingFilesystem.mkdir,
      fstat: (fd) => {
        const name = handles.get(fd)!;
        if (name === root) trigger("data-receipt");
        if (name.endsWith("/upgrades")) trigger("parent-receipt");
        if (name.endsWith("/download-attempt-v1")) trigger("reservation-receipt");
        if (name.endsWith("/owner.json")) trigger("record-receipt");
        return stagingFilesystem.fstat(fd);
      },
      write: ((...args: Parameters<typeof stagingFilesystem.write>) => { trigger("record-write"); return stagingFilesystem.write(...args); }) as typeof stagingFilesystem.write,
      read: ((...args: Parameters<typeof stagingFilesystem.read>) => { trigger("record-read"); return stagingFilesystem.read(...args); }) as typeof stagingFilesystem.read,
      sync: (fd) => {
        const name = handles.get(fd)!;
        if (name === root) trigger("parent-sync");
        if (name.endsWith("/upgrades")) trigger("reservation-sync");
        if (name.endsWith("/owner.json")) trigger("record-sync");
        if (name.endsWith("/download-attempt-v1")) trigger("record-parent-sync");
        stagingFilesystem.sync(fd);
      },
    };
    assert.throws(() => attempt(root, fs), new RegExp(`fixture ${phase}`, "u"));
    assert.equal(handles.size, 0, `${phase} closes all current handles`);
    const occupied = existsSync(join(root, "upgrades", "download-attempt-v1"));
    assert.equal(occupied, phase === "reservation-receipt" || phase === "record-receipt", `${phase} preserves only unreceipted evidence`);
    if (phase === "parent-receipt") assert.equal(existsSync(join(root, "upgrades")), true, "unreceipted parent remains intact");
    if (occupied) assert.throws(() => attempt(root), /occupied|unknown/u);
    else { const retry = attempt(root); assert.equal(retry.finish(), null); }
  }
});

linuxTest("immutable owner bytes and admitted sizes cannot be changed into publication or cleanup authority", async (t) => {
  const root = dataDirectory(t);
  const owned = attempt(root);
  const marker = join(owned.path, "owner.json");
  const bytes = readFileSync(marker);
  bytes[0] = "!".charCodeAt(0);
  writeFileSync(marker, bytes);
  assert.match(owned.finish()!, /immutable owner record changed/u);
  assert.deepEqual(readFileSync(marker), bytes);
  assert.throws(() => attempt(root), /occupied|unknown/u);

  const nextRoot = dataDirectory(t);
  const mutable = { ...fixtureAsset };
  const next = ReleaseStaging.create(nextRoot, { mode: "user", serviceUid: null }, "v1.2.3", [mutable]);
  let bodies = 0;
  await assert.rejects(downloadVerifiedAsset(async () => { bodies++; }, { ...mutable, size: mutable.size + 1 }, join(next.path, mutable.name), { staging: next }), /metadata is outside/u);
  assert.equal(bodies, 0);
  await assert.rejects(downloadVerifiedAsset(async (_url, sink) => {
    mutable.size = Number.MAX_SAFE_INTEGER;
    sink.end(Buffer.alloc(fixtureBytes.length + 1));
  }, mutable, join(next.path, mutable.name), { staging: next }), /exceeds its declared/u);
  assert.equal(next.finish(), null);
});

linuxTest("publication durability failures retain evidence and safe two-link failures retire only current receipts", async (t) => {
  for (const phase of ["partial-unlink", "publication-fsync"]) {
    const root = dataDirectory(t);
    const handles = new Map<number, string>();
    let linked = false;
    let failed = false;
    const fs: StagingFilesystem = {
      ...stagingFilesystem,
      open: (...args) => { const fd = stagingFilesystem.open(...args); handles.set(fd, String(args[0])); return fd; },
      close: (fd) => { stagingFilesystem.close(fd); handles.delete(fd); },
      link: (from, to) => { stagingFilesystem.link(from, to); linked = true; },
      unlink: (path) => {
        if (phase === "partial-unlink" && linked && !failed && String(path).endsWith(".partial")) { failed = true; throw new Error("fixture partial unlink"); }
        stagingFilesystem.unlink(path);
      },
      sync: (fd) => {
        if (phase === "publication-fsync" && linked && !failed && handles.get(fd)?.endsWith("/download-attempt-v1")) { failed = true; throw new Error("fixture publication fsync"); }
        stagingFilesystem.sync(fd);
      },
    };
    const owned = attempt(root, fs);
    const destination = join(owned.path, fixtureAsset.name);
    await assert.rejects(downloadVerifiedAsset(async (_url, sink) => { sink.end(fixtureBytes); }, fixtureAsset, destination, { staging: owned }), /fixture/u);
    assert.deepEqual(readFileSync(destination), fixtureBytes, "only already-verified bytes have been linked");
    if (phase === "partial-unlink") { assert.equal(owned.finish(), null); assert.equal(existsSync(owned.path), false); }
    else { assert.match(owned.finish()!, /uncertain/u); assert.equal(existsSync(destination), true); }
    assert.equal(handles.size, 0);
  }
});
