import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import type { AntigravityManagedRelease } from "@wollipog/protocol";
import {
  AntigravityInstallError,
  AntigravityManagedStore,
  antigravityReleasePlatform,
  detectAntigravityMusl,
  downloadAntigravityArchive,
  extractAntigravityBinary,
  parseAntigravityInstaller,
  parseAntigravityManifest,
  resolveAntigravityRelease,
} from "./antigravity-install.js";
import {
  FakeReleaseServer,
  FIXTURE_INSTALLER_URL,
  FIXTURE_MANIFEST_BASE,
  fakeInstallerScript,
  fakeTarGz,
  paxPathEntry,
  sha512,
} from "./fixtures/antigravity/fake-release.js";

const root = mkdtempSync(join(tmpdir(), "antigravity-install-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => join(mkdtempSync(join(root, `${name}-`)), `${++counter}`);

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    assert.ok(error instanceof AntigravityInstallError, `unexpected error ${String(error)}`);
    return error.failure;
  }
  assert.fail("expected an install failure");
}

test("platforms map exactly as Google's installer names them, and nothing else maps", () => {
  assert.equal(antigravityReleasePlatform({ platform: "linux", arch: "x64", musl: false }), "linux_amd64");
  assert.equal(antigravityReleasePlatform({ platform: "linux", arch: "arm64", musl: false }), "linux_arm64");
  assert.equal(antigravityReleasePlatform({ platform: "linux", arch: "x64", musl: true }), "linux_amd64_musl");
  assert.equal(antigravityReleasePlatform({ platform: "linux", arch: "arm64", musl: true }), "linux_arm64_musl");
  assert.equal(antigravityReleasePlatform({ platform: "darwin", arch: "arm64", musl: false }), "darwin_arm64");
  assert.equal(antigravityReleasePlatform({ platform: "darwin", arch: "x64", musl: true }), "darwin_amd64");
  for (const unmapped of [
    { platform: "linux", arch: "ia32" }, { platform: "linux", arch: "riscv64" }, { platform: "win32", arch: "x64" },
    { platform: "android", arch: "arm64" }, { platform: "freebsd", arch: "x64" },
  ] as const) {
    assert.equal(antigravityReleasePlatform({ ...unmapped, musl: false }), null, JSON.stringify(unmapped));
  }
});

test("musl detection mirrors the installer: its loader paths, else the C library the runner runs on", () => {
  assert.equal(detectAntigravityMusl((path) => path === "/lib/libc.musl-x86_64.so.1", () => "2.39"), true);
  assert.equal(detectAntigravityMusl((path) => path === "/lib/libc.musl-aarch64.so.1", () => "2.39"), true);
  assert.equal(detectAntigravityMusl(() => false, () => undefined), true);
  assert.equal(detectAntigravityMusl(() => false, () => "2.39"), false);
});

test("the installer script is read for its manifest service, and any other layout is refused", async () => {
  assert.deepEqual(parseAntigravityInstaller(fakeInstallerScript()), { manifestBase: FIXTURE_MANIFEST_BASE });
  const refused = [
    fakeInstallerScript({ base: "http://fixture-updater.run.app" }),
    fakeInstallerScript({ base: "https://fixture-updater.example.com" }),
    fakeInstallerScript({ base: "https://fixture-updater.run.app.example.com" }),
    fakeInstallerScript({ base: "https://run.app" }),
    fakeInstallerScript({ base: "https://fixture-updater.run.app/prefix" }),
    fakeInstallerScript({ base: "https://fixture-updater.run.app:8443" }),
    fakeInstallerScript({ base: "https://user:secret@fixture-updater.run.app" }),
    fakeInstallerScript({ extraBase: "https://other.run.app" }),
    fakeInstallerScript({ manifestLine: 'MANIFEST_URL="$DOWNLOAD_BASE_URL/v2/$platform.json"' }),
    fakeInstallerScript({ extractLine: 'tar -xzf "$staging_payload" -C "$STAGING_DIR" agy' }),
    "#!/bin/bash\necho hello\n",
  ];
  for (const script of refused) assert.equal(await failure(() => parseAntigravityInstaller(script)), "installer_not_recognized", script);
});

test("the manifest must name an HTTPS tar.gz on storage.googleapis.com with a SHA-512", async () => {
  const sha = "AB".repeat(64);
  const url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/linux-x64/cli_linux_x64.tar.gz";
  assert.deepEqual(parseAntigravityManifest(JSON.stringify({ version: "1.5.14", url, sha512: sha, extra: true })),
    { version: "1.5.14", archiveUrl: url, archiveSha512: sha.toLowerCase() });
  const refused = [
    "not json", "[]", "null",
    JSON.stringify({ url, sha512: sha }),
    JSON.stringify({ version: "1.5 beta", url, sha512: sha }),
    JSON.stringify({ version: "1.5.14", url: url.replace("https:", "http:"), sha512: sha }),
    JSON.stringify({ version: "1.5.14", url: url.replace("storage.googleapis.com", "storage.googleapis.com.example.com"), sha512: sha }),
    JSON.stringify({ version: "1.5.14", url: url.replace("storage.googleapis.com", "example.com"), sha512: sha }),
    JSON.stringify({ version: "1.5.14", url: url.replace(".tar.gz", ".zip"), sha512: sha }),
    JSON.stringify({ version: "1.5.14", url, sha512: sha.slice(2) }),
    JSON.stringify({ version: "1.5.14", url, sha512: `${sha.slice(2)}zz` }),
  ];
  for (const manifest of refused) assert.equal(await failure(() => parseAntigravityManifest(manifest)), "installer_not_recognized", manifest);
});

test("the release chain follows only same-origin redirects and records its provenance", async () => {
  const server = new FakeReleaseServer();
  const archive = fakeTarGz([{ name: "antigravity", content: "binary" }]);
  const { archiveUrl, manifestUrl } = server.publish({ platform: "linux_amd64", version: "1.5.14", archive });
  const release = await resolveAntigravityRelease("linux_amd64", { fetch: server.fetch, timeoutMs: 5_000 });
  assert.equal(release.manifestUrl, manifestUrl);
  assert.equal(release.archiveUrl, archiveUrl);
  assert.equal(release.archiveSha512, sha512(archive));
  assert.match(release.installerSha256, /^[0-9a-f]{64}$/u);

  // A redirect within antigravity.google is followed.
  const moved = new FakeReleaseServer();
  moved.publish({ platform: "linux_amd64", version: "1.5.14", archive });
  moved.set(FIXTURE_INSTALLER_URL, { status: 302, headers: { location: "/cli/v2/install.sh" } });
  moved.set("https://antigravity.google/cli/v2/install.sh", { body: fakeInstallerScript() });
  assert.equal((await resolveAntigravityRelease("linux_amd64", { fetch: moved.fetch, timeoutMs: 5_000 })).version, "1.5.14");

  // A redirect to another origin is refused, for the installer, the manifest and the archive.
  const offOrigin = new FakeReleaseServer();
  offOrigin.set(FIXTURE_INSTALLER_URL, { status: 301, headers: { location: "https://attacker.example/install.sh" } });
  assert.equal(await failure(resolveAntigravityRelease("linux_amd64", { fetch: offOrigin.fetch, timeoutMs: 5_000 })), "redirect_refused");
  assert.deepEqual(offOrigin.requests, [FIXTURE_INSTALLER_URL]);
  const manifestMoved = new FakeReleaseServer();
  manifestMoved.publish({ platform: "linux_amd64", version: "1.5.14", archive });
  manifestMoved.set(manifestUrl, { status: 307, headers: { location: "https://other.run.app/manifests/linux_amd64.json" } });
  assert.equal(await failure(resolveAntigravityRelease("linux_amd64", { fetch: manifestMoved.fetch, timeoutMs: 5_000 })), "redirect_refused");
  server.set(archiveUrl, { status: 302, headers: { location: "https://mirror.example/cli.tar.gz" } });
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, fresh("redirect"), { fetch: server.fetch, timeoutMs: 5_000 })), "redirect_refused");

  const missing = new FakeReleaseServer();
  assert.equal(await failure(resolveAntigravityRelease("linux_amd64", { fetch: missing.fetch, timeoutMs: 5_000 })), "download_failed");
  const hanging = new FakeReleaseServer();
  hanging.set(FIXTURE_INSTALLER_URL, { hang: true });
  assert.equal(await failure(resolveAntigravityRelease("linux_amd64", { fetch: hanging.fetch, timeoutMs: 50 })), "timed_out");
});

test("the archive download is hashed while it streams and bounded in size", async () => {
  const server = new FakeReleaseServer();
  const archive = fakeTarGz([{ name: "antigravity", content: "x".repeat(10_000) }]);
  const { archiveUrl } = server.publish({ platform: "linux_amd64", version: "1.5.14", archive });
  const file = fresh("download");
  mkdirSync(join(file, ".."), { recursive: true });
  assert.equal(await downloadAntigravityArchive(archiveUrl, file, { fetch: server.fetch, timeoutMs: 5_000 }), sha512(archive));
  assert.deepEqual(readFileSync(file), archive);
  // The archive is never written over an existing file.
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, file, { fetch: server.fetch, timeoutMs: 5_000 })), "activation_failed");
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, fresh("big"), { fetch: server.fetch, timeoutMs: 5_000, maxBytes: 100 })), "download_failed");
  server.set(archiveUrl, { body: archive });
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, fresh("big-undeclared"), { fetch: server.fetch, timeoutMs: 5_000, maxBytes: 100 })), "download_failed");
  server.set(archiveUrl, { status: 500 });
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, fresh("error"), { fetch: server.fetch, timeoutMs: 5_000 })), "download_failed");
  server.set(archiveUrl, { hang: true });
  assert.equal(await failure(downloadAntigravityArchive(archiveUrl, fresh("hang"), { fetch: server.fetch, timeoutMs: 50 })), "timed_out");
});

async function extract(archive: Buffer, limits: { maxBinaryBytes?: number } = {}): Promise<{ destination: string; error?: string }> {
  const folder = mkdtempSync(join(root, "extract-"));
  const file = join(folder, "release.tar.gz");
  writeFileSync(file, archive);
  const destination = join(folder, "agy");
  try {
    await extractAntigravityBinary(file, destination, limits);
    return { destination };
  } catch (error) {
    assert.ok(error instanceof AntigravityInstallError, String(error));
    assert.equal(existsSync(destination), false, "a refused archive leaves no binary behind");
    return { destination, error: error.failure };
  }
}

test("only the single regular antigravity member is extracted, executable", async () => {
  const plain = await extract(fakeTarGz([{ name: "antigravity", content: "#!/bin/sh\necho fixture\n" }]));
  assert.equal(plain.error, undefined);
  assert.equal(readFileSync(plain.destination, "utf8"), "#!/bin/sh\necho fixture\n");
  assert.equal(statSync(plain.destination).mode & 0o777, 0o755);

  // A folder entry, a "./" prefix, a pax path and unrelated regular members are fine.
  const varied = await extract(fakeTarGz([
    { name: "./", type: "5" },
    { name: "./README", content: "notes" },
    paxPathEntry("antigravity"),
    { name: "placeholder-name", content: "pax-named" },
    { name: "LICENSE", content: "license" },
  ]));
  assert.equal(varied.error, undefined);
  assert.equal(readFileSync(varied.destination, "utf8"), "pax-named");
  const prefixed = await extract(fakeTarGz([{ name: "antigravity", prefix: ".", content: "prefixed" }]));
  assert.equal(readFileSync(prefixed.destination, "utf8"), "prefixed");
});

test("unsafe, partial or ambiguous archives are refused whole", async () => {
  const binary = { name: "antigravity", content: "binary" };
  const cases: Array<[string, Buffer]> = [
    ["traversal", fakeTarGz([{ name: "../antigravity", content: "x" }, binary])],
    ["nested traversal", fakeTarGz([{ name: "bin/../../etc/passwd", content: "x" }, binary])],
    ["absolute path", fakeTarGz([{ name: "/antigravity", content: "x" }])],
    ["pax traversal", fakeTarGz([paxPathEntry("../../antigravity"), { name: "safe", content: "x" }, binary])],
    ["symlink target", fakeTarGz([{ name: "antigravity", type: "2", linkname: "/bin/sh" }])],
    ["hard link elsewhere", fakeTarGz([binary, { name: "copy", type: "1", linkname: "antigravity" }])],
    ["device", fakeTarGz([{ name: "null", type: "3" }, binary])],
    ["fifo", fakeTarGz([{ name: "pipe", type: "6" }, binary])],
    ["missing member", fakeTarGz([{ name: "agy", content: "binary" }])],
    ["empty member", fakeTarGz([{ name: "antigravity", content: "" }])],
    ["duplicate member", fakeTarGz([binary, { name: "./antigravity", content: "other" }])],
    ["truncated member", fakeTarGz([{ ...binary, declaredSize: 4_096 }], { end: false })],
    ["no end marker", fakeTarGz([binary], { end: false })],
    ["not gzip", Buffer.from("plain bytes")],
    ["not tar", gzipSync(Buffer.alloc(1_024, 7))],
  ];
  for (const [name, archive] of cases) {
    assert.equal((await extract(archive)).error, "archive_invalid", name);
  }
  assert.equal((await extract(fakeTarGz([{ name: "antigravity", content: "x".repeat(2_000) }]), { maxBinaryBytes: 1_000 })).error, "archive_invalid");
});

function release(version: string): AntigravityManagedRelease {
  return {
    version,
    activatedAt: 1_795_000_000_000,
    installerSha256: "a".repeat(64),
    manifestUrl: `${FIXTURE_MANIFEST_BASE}/manifests/linux_amd64.json`,
    archiveUrl: `https://storage.googleapis.com/antigravity-public/${version}/cli.tar.gz`,
    archiveSha512: "b".repeat(128),
  };
}

async function stage(store: AntigravityManagedStore, now: number, content: string) {
  const staging = await store.createStaging(now);
  writeFileSync(join(staging.directory, "agy"), content, { mode: 0o755 });
  return staging;
}

test("activation swaps current atomically and keeps exactly one previous generation", async () => {
  const store = new AntigravityManagedStore(fresh("store"));
  assert.equal(store.read("current"), null);

  const first = await store.activate(await stage(store, 1, "one"), release("1.0.0"));
  assert.equal(readlinkSync(join(store.root, "current")), `generations/${first.id}`);
  assert.equal(readFileSync(store.executablePath(), "utf8"), "one");
  assert.equal(store.read("previous"), null);

  const second = await store.activate(await stage(store, 2, "two"), release("1.1.0"));
  assert.equal(readFileSync(store.executablePath(), "utf8"), "two");
  assert.equal(store.read("current")?.release.version, "1.1.0");
  assert.equal(store.read("previous")?.id, first.id);

  const third = await store.activate(await stage(store, 3, "three"), release("1.2.0"));
  assert.equal(store.read("current")?.id, third.id);
  assert.equal(store.read("previous")?.id, second.id);
  assert.equal(existsSync(first.directory), false, "a generation older than previous is removed");
  assert.equal(existsSync(join(store.root, "staging", first.id)), false);

  // A staging folder abandoned mid-install is cleared by the next one.
  const abandoned = await store.createStaging(4);
  await store.createStaging(5);
  assert.equal(existsSync(abandoned.directory), false);
  await store.discardStaging();
  assert.equal(existsSync(join(store.root, "staging")), false);
  assert.equal(store.read("current")?.id, third.id, "discarding staging never touches the active generation");

  // A damaged generation is not reported as installed.
  writeFileSync(join(third.directory, "release.json"), JSON.stringify({ ...release("1.2.0"), archiveUrl: "https://example.com/x.tar.gz" }));
  assert.equal(store.read("current"), null);
});
