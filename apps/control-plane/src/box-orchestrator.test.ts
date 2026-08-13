import assert from "node:assert/strict";
import { test } from "node:test";
import {
  binaryIsCurrent,
  binaryDeployIdentity,
  buildPromoteCommand,
  buildRemoteCommand,
  buildSshArgs,
  buildStageSweepCommand,
  buildTokenDeployCommand,
  classifyRunnerUpdate,
  deploymentAttemptIsCurrent,
  githubAssetDownloadUrl,
  githubCliDownloadArgs,
  githubCliReleaseMetadataArgs,
  githubMetadataRequestError,
  posixQuote,
  resolveReleaseArtifactWithFallback,
  ReleaseAssetNotFoundError,
  remoteCredentialPath,
  runnerAssetNames,
  stagedRunnerPath,
  tripleFromUname,
} from "./box-orchestrator.js";

const LEGACY_RUNNER_ASSET_WARNING =
  "Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed.";

test("runner release assets are canonical-first for all six target triples", () => {
  assert.deepEqual(runnerAssetNames("aarch64-apple-darwin"), [
    "wollipog-runner-aarch64-apple-darwin", "agent-manager-runner-aarch64-apple-darwin",
  ]);
  assert.deepEqual(runnerAssetNames("x86_64-apple-darwin"), [
    "wollipog-runner-x86_64-apple-darwin", "agent-manager-runner-x86_64-apple-darwin",
  ]);
  assert.deepEqual(runnerAssetNames("aarch64-unknown-linux-gnu"), [
    "wollipog-runner-aarch64-unknown-linux-gnu", "agent-manager-runner-aarch64-unknown-linux-gnu",
  ]);
  assert.deepEqual(runnerAssetNames("x86_64-unknown-linux-gnu"), [
    "wollipog-runner-x86_64-unknown-linux-gnu", "agent-manager-runner-x86_64-unknown-linux-gnu",
  ]);
  assert.deepEqual(runnerAssetNames("aarch64-pc-windows-msvc"), [
    "wollipog-runner-aarch64-pc-windows-msvc.exe", "agent-manager-runner-aarch64-pc-windows-msvc.exe",
  ]);
  assert.deepEqual(runnerAssetNames("x86_64-pc-windows-msvc"), [
    "wollipog-runner-x86_64-pc-windows-msvc.exe", "agent-manager-runner-x86_64-pc-windows-msvc.exe",
  ]);
  assert.throws(() => runnerAssetNames("../../escape"), /invalid runner target triple/);
});

test("GitHub CLI release arguments remain fixed and exact", () => {
  const request = {
    repo: "owner/private-repo",
    releaseTag: "v1.2.3",
    assetName: "agent-manager-runner-aarch64-unknown-linux-gnu",
  };
  assert.deepEqual(githubCliDownloadArgs(request, "C:/tmp/runner"), [
    "release", "download", "v1.2.3",
    "--repo", "owner/private-repo",
    "--pattern", "agent-manager-runner-aarch64-unknown-linux-gnu",
    "--output", "C:/tmp/runner",
    "--clobber",
  ]);
  assert.deepEqual(githubCliReleaseMetadataArgs(request), [
    "api", "repos/owner/private-repo/releases/tags/v1.2.3",
  ]);
});

test("public bytes use the exact browser URL while explicit-token bytes use the asset API", () => {
  const name = "wollipog-runner-x86_64-unknown-linux-gnu";
  const asset = {
    name,
    url: "https://api.github.com/repos/owner/private-repo/releases/assets/101",
    browser_download_url: `https://github.com/owner/private-repo/releases/download/v1.2.3/${name}`,
  };
  const request = { repo: "owner/private-repo", releaseTag: "v1.2.3" };
  assert.equal(githubAssetDownloadUrl(asset, request), asset.browser_download_url);
  assert.equal(githubAssetDownloadUrl(asset, { ...request, token: "secret" }), asset.url);
  assert.throws(
    () => githubAssetDownloadUrl({ ...asset, browser_download_url: `https://evil.example/${name}` }, request),
    /no valid .* asset URL/,
  );
  assert.throws(
    () => githubAssetDownloadUrl({ ...asset, url: "https://api.github.com/repos/other/repo/releases/assets/101" },
      { ...request, token: "secret" }),
    /no valid .* asset URL/,
  );
});

test("GitHub metadata rate-limit errors include bounded reset and retry context", () => {
  assert.equal(
    githubMetadataRequestError(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1800000000",
      "retry-after": "60",
    }),
    "GitHub release metadata request was rate limited (403); rate limit resets at 2027-01-15T08:00:00.000Z; retry after 60 seconds",
  );
  assert.equal(
    githubMetadataRequestError(429, {}),
    "GitHub release metadata request was rate limited (429)",
  );
  assert.equal(
    githubMetadataRequestError(429, { "x-ratelimit-reset": String(Number.MAX_SAFE_INTEGER) }),
    "GitHub release metadata request was rate limited (429)",
    "hostile reset metadata cannot throw while formatting the original failure",
  );
  assert.equal(
    githubMetadataRequestError(403, { "x-ratelimit-remaining": "4999" }),
    "GitHub release metadata request failed (403)",
    "ordinary authorization failures are not mislabeled as rate limits",
  );
});

test("release metadata selection uses one raw REST response for canonical-to-legacy fallback", async () => {
  const canonical = "wollipog-runner-aarch64-unknown-linux-gnu";
  const legacy = "agent-manager-runner-aarch64-unknown-linux-gnu";
  const sha256 = "ab".repeat(32);
  const rawRestRelease = {
    url: "https://api.github.com/repos/owner/private-repo/releases/42",
    tag_name: "v1.2.3",
    assets: [{
      id: 101,
      name: legacy,
      url: "https://api.github.com/repos/owner/private-repo/releases/assets/101",
      browser_download_url: `https://github.com/owner/private-repo/releases/download/v1.2.3/${legacy}`,
      digest: `sha256:${sha256}`,
      size: 1234,
    }],
  };
  let directMetadataCalls = 0;
  let directDownloadCalls = 0;
  const selected = await resolveReleaseArtifactWithFallback({
    repo: "owner/private-repo",
    releaseTag: "v1.2.3",
    assetNames: [canonical, legacy],
  }, {
    directMetadata: async () => { directMetadataCalls += 1; return rawRestRelease; },
    ghMetadata: async () => { throw new Error("gh metadata should not be needed"); },
    directDownload: async (asset) => {
      directDownloadCalls += 1;
      assert.equal(asset, rawRestRelease.assets[0]);
    },
    ghDownload: async () => { throw new Error("gh download should not be needed"); },
  });
  assert.equal(selected.assetName, legacy);
  assert.deepEqual(await selected.download("C:/tmp/runner"), { sha256 });
  assert.equal(directMetadataCalls, 1, "canonical absence and legacy selection share one metadata request");
  assert.equal(directDownloadCalls, 1);
});

test("authenticated gh metadata fallback preserves the raw REST asset digest", async () => {
  const name = "wollipog-runner-x86_64-unknown-linux-gnu";
  const sha256 = "cd".repeat(32);
  let ghMetadataCalls = 0;
  let ghDownloadCalls = 0;
  const selected = await resolveReleaseArtifactWithFallback({
    repo: "owner/private-repo",
    releaseTag: "v1.2.3",
    assetNames: [name, `agent-manager-runner-x86_64-unknown-linux-gnu`],
  }, {
    directMetadata: async () => { throw new Error("HTTP 404"); },
    ghMetadata: async () => {
      ghMetadataCalls += 1;
      return {
        tag_name: "v1.2.3",
        assets: [{
          id: 202,
          name,
          url: "https://api.github.com/repos/owner/private-repo/releases/assets/202",
          digest: `sha256:${sha256}`,
        }],
      };
    },
    directDownload: async () => { throw new Error("direct download should not be used"); },
    ghDownload: async (request) => {
      ghDownloadCalls += 1;
      assert.equal(request.assetName, name);
      assert.equal(request.token, undefined);
    },
  });
  assert.deepEqual(await selected.download("C:/tmp/private-runner"), { sha256 });
  assert.equal(ghMetadataCalls, 1);
  assert.equal(ghDownloadCalls, 1);
});

test("release-level resolution keeps explicit-token and digest checks fail closed", async () => {
  const request = {
    repo: "owner/private-repo",
    releaseTag: "v1.2.3",
    assetNames: ["wollipog-runner-x86_64-unknown-linux-gnu"],
    token: "secret-token",
  };
  let ghMetadataCalled = false;
  await assert.rejects(
    resolveReleaseArtifactWithFallback(request, {
      directMetadata: async () => { throw new Error("HTTP 401"); },
      ghMetadata: async () => { ghMetadataCalled = true; return {}; },
      directDownload: async () => {},
      ghDownload: async () => {},
    }),
    /authenticated GitHub API download failed: HTTP 401/,
  );
  assert.equal(ghMetadataCalled, false, "an explicit token never falls through to ambient gh authentication");

  let downloadCalled = false;
  await assert.rejects(
    resolveReleaseArtifactWithFallback({ ...request, token: undefined }, {
      directMetadata: async () => ({
        assets: [{
          name: request.assetNames[0],
          url: "https://api.github.com/repos/owner/private-repo/releases/assets/303",
        }],
      }),
      ghMetadata: async () => ({}),
      directDownload: async () => { downloadCalled = true; },
      ghDownload: async () => { downloadCalled = true; },
    }),
    /has no valid SHA-256 digest/,
  );
  assert.equal(downloadCalled, false, "missing publisher digest prevents every download path");
});

test("posixQuote wraps in single quotes and escapes embedded quotes", () => {
  assert.equal(posixQuote("hello"), "'hello'");
  assert.equal(posixQuote("/home/me/my repo"), "'/home/me/my repo'");
  assert.equal(posixQuote("it's"), "'it'\\''s'");
});

test("tripleFromUname maps uname -s -m to runner triples", () => {
  assert.equal(tripleFromUname("Linux x86_64"), "x86_64-unknown-linux-gnu");
  assert.equal(tripleFromUname("Linux aarch64"), "aarch64-unknown-linux-gnu");
  assert.equal(tripleFromUname("Darwin arm64"), "aarch64-apple-darwin");
  assert.equal(tripleFromUname("Darwin x86_64"), "x86_64-apple-darwin");
  assert.equal(tripleFromUname("Linux  aarch64\n"), "aarch64-unknown-linux-gnu"); // tolerant of whitespace
  assert.equal(tripleFromUname("FreeBSD amd64"), null);
  assert.equal(tripleFromUname("Linux mips"), null);
});

test("buildRemoteCommand quotes every value, uses --token-file, and repeats --workspace", () => {
  const cmd = buildRemoteCommand({
    runnerPath: ".agent-manager/agent-manager-runner",
    runnerId: "box-abc",
    controlPlaneUrl: "ws://127.0.0.1:47100/runner",
    tokenFile: ".agent-manager/credentials/rcred_0123456789abcdef0123456789abcdef",
    workspaces: [
      { id: "repo", path: "/home/me/repo" },
      { id: "docs", path: "/srv/my docs" },
    ],
  });
  assert.equal(
    cmd,
    "'.agent-manager/agent-manager-runner' --runner-id 'box-abc' " +
      "--control-plane-url 'ws://127.0.0.1:47100/runner' " +
      "--token-file '.agent-manager/credentials/rcred_0123456789abcdef0123456789abcdef' " +
      "--workspace 'repo:/home/me/repo' --workspace 'docs:/srv/my docs'",
  );
  // The secret token never appears in the command (it's delivered as a file).
  assert.ok(!cmd.includes("--token "));
});

test("buildRemoteCommand is injection-safe for hostile workspace paths", () => {
  const cmd = buildRemoteCommand({
    runnerPath: "r",
    runnerId: "id",
    controlPlaneUrl: "u",
    tokenFile: "t",
    workspaces: [{ id: "w", path: "/x; rm -rf ~" }],
  });
  // The `;` stays inside single quotes — it cannot break out into a second command.
  assert.ok(cmd.includes("--workspace 'w:/x; rm -rf ~'"));
});

test("binaryIsCurrent gates deploy by content, so a pre-fix remote runner is not 'already deployed'", () => {
  // The old code skipped deploy on any successful `--version`; a box stamped with a runner VERSION
  // string ("0.4.0") must NOT be treated as current vs the new binary's content hash → redeploy.
  assert.equal(binaryIsCurrent("0.4.0", "deadbeefdeadbeef"), false);
  assert.equal(binaryIsCurrent(null, "deadbeefdeadbeef"), false);
  assert.equal(binaryIsCurrent("deadbeefdeadbeef", "deadbeefdeadbeef"), true);
});

test("deployment identity reuses the resolver's verified full digest", () => {
  const sha256 = "ab".repeat(32);
  assert.equal(binaryDeployIdentity({ path: "runner", sha256, source: "release-cache" }), sha256.slice(0, 16));
  assert.throws(
    () => binaryDeployIdentity({ path: "runner", sha256: "not-a-digest", source: "staged" }),
    /invalid SHA-256/,
  );
});

test("runner update preflight does not restart an identical artifact and identifies a changed build", () => {
  const candidate = {
    path: "/tmp/runner",
    sha256: "a".repeat(64),
    source: "staged" as const,
  };
  assert.deepEqual(
    classifyRunnerUpdate({
      boxId: "box-1",
      triple: "aarch64-unknown-linux-gnu",
      deployedVersion: "a".repeat(16),
      candidate,
      startEpoch: 7,
    }),
    {
      status: "already_current",
      boxId: "box-1",
      triple: "aarch64-unknown-linux-gnu",
      expectedVersion: "a".repeat(16),
      source: "staged",
    },
  );
  assert.deepEqual(
    classifyRunnerUpdate({
      boxId: "box-1",
      triple: "aarch64-unknown-linux-gnu",
      deployedVersion: "b".repeat(16),
      candidate,
      startEpoch: 7,
    }),
    {
      status: "ready",
      boxId: "box-1",
      triple: "aarch64-unknown-linux-gnu",
      expectedVersion: "a".repeat(16),
      source: "staged",
      startEpoch: 7,
    },
  );
});

test("buildSshArgs opens the reverse tunnel and runs the remote command last", () => {
  const args = buildSshArgs({
    sshTarget: "me@devbox",
    sshPort: 2222,
    remotePort: 47100,
    cpPort: 4317,
    remoteCommand: "RC",
  });
  assert.deepEqual(args.slice(0, 2), ["-p", "2222"]);
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  const ri = args.indexOf("-R");
  assert.equal(args[ri + 1], "47100:127.0.0.1:4317");
  // `--` then target then the remote command are the final positional args (option terminator
  // keeps a `-`-leading target from being read as an option).
  assert.deepEqual(args.slice(-3), ["--", "me@devbox", "RC"]);
});

test("deployment commands are atomic, zsh-safe, permission-safe, and epoch-isolated", () => {
  assert.equal(stagedRunnerPath(7), ".agent-manager/agent-manager-runner.new-7");
  assert.notEqual(stagedRunnerPath(7), stagedRunnerPath(8), "reconnect attempts never share an scp destination");
  assert.throws(() => stagedRunnerPath(0), /invalid deployment epoch/);

  const sweep = buildStageSweepCommand();
  assert.match(sweep, /find \.agent-manager .* -name 'agent-manager-runner\.new-\*'/);
  assert.ok(!sweep.includes("rm .agent-manager/agent-manager-runner.new-*"), "never expose an unmatched glob to zsh");

  const promote = buildPromoteCommand(7);
  assert.equal(
    promote,
    "chmod +x .agent-manager/agent-manager-runner.new-7 && " +
      "mv -f .agent-manager/agent-manager-runner.new-7 .agent-manager/agent-manager-runner",
  );
  const credentialId = "rcred_0123456789abcdef0123456789abcdef";
  assert.equal(remoteCredentialPath(credentialId), `.agent-manager/credentials/${credentialId}`);
  assert.throws(() => remoteCredentialPath("../token"), /invalid runner credential id/);
  const token = buildTokenDeployCommand(credentialId);
  assert.match(token, /^umask 077;/);
  assert.match(token, /mkdir -p \.agent-manager\/credentials/);
  assert.match(token, /-mmin \+10080 -delete/);
  assert.match(token, /cat > \.agent-manager\/credentials\/rcred_[a-f0-9]+\.new-\$\$/);
  assert.match(token, /chmod 600 \.agent-manager\/credentials\/rcred_[a-f0-9]+\.new-\$\$/);
  assert.match(token, /mv -f \.agent-manager\/credentials\/rcred_[a-f0-9]+\.new-\$\$ \.agent-manager\/credentials\/rcred_[a-f0-9]+$/);
  assert.doesNotMatch(token, /\.agent-manager\/token/, "never touch the legacy shared token path");
});

test("reconnect, removal, and shutdown supersede every older deployment attempt", () => {
  assert.equal(deploymentAttemptIsCurrent(4, 4, false, false), true);
  assert.equal(deploymentAttemptIsCurrent(5, 4, false, false), false, "manual reconnect bumped the epoch");
  assert.equal(deploymentAttemptIsCurrent(4, 4, true, false), false, "box removal wins an in-flight scp race");
  assert.equal(deploymentAttemptIsCurrent(4, 4, false, true), false, "shutdown prevents late promotion or launch");
});

test("makeBinaryResolver prefers the Wollipog staged directory and warns once on legacy fallback", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const currentDir = join(root, "current");
  const legacyDir = join(root, "legacy");
  const distBinDir = join(root, "dist");
  const name = "wollipog-runner-aarch64-unknown-linux-gnu";
  const legacyName = "agent-manager-runner-aarch64-unknown-linux-gnu";
  mkdirSync(currentDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(currentDir, name), "current");
  writeFileSync(join(currentDir, legacyName), "legacy-shadowed");
  writeFileSync(join(legacyDir, legacyName), "legacy");

  const preferredWarnings: string[] = [];
  const preferred = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache-current"),
    distBinDir,
    env: { WOLLIPOG_RUNNER_BIN_DIR: currentDir, MAM_RUNNER_BIN_DIR: legacyDir },
    warn: (warning) => preferredWarnings.push(warning),
  });
  assert.equal((await preferred("aarch64-unknown-linux-gnu")).path, join(currentDir, name));
  assert.equal(preferredWarnings.some((warning) => warning.includes("MAM_RUNNER_BIN_DIR is deprecated")), false);

  const legacyWarnings: string[] = [];
  const legacy = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache-legacy"),
    distBinDir,
    env: { MAM_RUNNER_BIN_DIR: legacyDir },
    warn: (warning) => legacyWarnings.push(warning),
  });
  assert.equal((await legacy("aarch64-unknown-linux-gnu")).path, join(legacyDir, legacyName));
  assert.equal(
    legacyWarnings.filter((warning) => warning === "MAM_RUNNER_BIN_DIR is deprecated; use WOLLIPOG_RUNNER_BIN_DIR").length,
    1,
  );
  assert.equal(legacyWarnings.filter((warning) => warning === LEGACY_RUNNER_ASSET_WARNING).length, 1);
  assert.equal(legacyWarnings.some((warning) => warning.includes(legacyDir)), true, "staged-path warning remains useful");

  const laterWarnings: string[] = [];
  const later = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache-legacy"),
    distBinDir,
    env: { WOLLIPOG_RUNNER_BIN_DIR: legacyDir },
    warn: (warning) => laterWarnings.push(warning),
  });
  assert.equal((await later("aarch64-unknown-linux-gnu")).path, join(legacyDir, legacyName));
  assert.equal(
    laterWarnings.includes(LEGACY_RUNNER_ASSET_WARNING),
    false,
    "the staged warning marker prevents restart spam",
  );

  const releaseWarnings: string[] = [];
  const release = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache-legacy"),
    distBinDir,
    env: {},
    warn: (warning) => releaseWarnings.push(warning),
    release: async (request) => ({
      assetName: request.assetNames[1]!,
      download: async (dest) => { writeFileSync(dest, "legacy release"); return {}; },
    }),
  });
  assert.equal((await release("aarch64-unknown-linux-gnu")).path, join(
    root,
    "cache-legacy",
    "v0.8.0",
    legacyName,
  ));
  assert.equal(
    releaseWarnings.filter((warning) => warning === LEGACY_RUNNER_ASSET_WARNING).length,
    1,
    "a prior staged fallback cannot silence the first release fallback warning",
  );

  const restartWarnings: string[] = [];
  const restartedRelease = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache-legacy"),
    distBinDir,
    env: {},
    warn: (warning) => restartWarnings.push(warning),
    release: async () => { throw new Error("release cache should avoid the network"); },
  });
  await restartedRelease("aarch64-unknown-linux-gnu");
  assert.equal(
    restartWarnings.includes(LEGACY_RUNNER_ASSET_WARNING),
    false,
    "the independent release warning marker prevents restart spam",
  );
});

test("makeBinaryResolver falls back only when the canonical release asset is absent", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-name-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseResolutions = 0;
  const warnings: string[] = [];
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    warn: (warning) => warnings.push(warning),
    release: async (request) => {
      releaseResolutions += 1;
      return {
        assetName: request.assetNames[1]!,
        download: async (dest) => { writeFileSync(dest, "legacy release"); return {}; },
      };
    },
  });
  const resolved = await resolve("x86_64-unknown-linux-gnu");
  assert.equal(releaseResolutions, 1, "canonical absence and legacy selection resolve release metadata once");
  assert.equal(resolved.path, join(root, "cache", "v0.8.0", "agent-manager-runner-x86_64-unknown-linux-gnu"));
  assert.deepEqual(warnings.filter((warning) => warning === LEGACY_RUNNER_ASSET_WARNING), [LEGACY_RUNNER_ASSET_WARNING]);

  assert.equal((await resolve("x86_64-unknown-linux-gnu")).path, resolved.path);
  assert.equal(
    warnings.filter((warning) => warning === LEGACY_RUNNER_ASSET_WARNING).length,
    1,
    "repeated resolutions do not repeat the migration warning",
  );

  const failClosed = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.9.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    download: async () => { throw new Error("canonical download failed"); },
  });
  await assert.rejects(() => failClosed("x86_64-unknown-linux-gnu"), /canonical download failed/);

  const attemptedNames: string[] = [];
  const injectedFallback = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.10.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    download: async (request, dest) => {
      attemptedNames.push(request.assetName);
      if (request.assetName.startsWith("wollipog-runner-")) {
        throw new ReleaseAssetNotFoundError("canonical asset absent");
      }
      writeFileSync(dest, "legacy release");
    },
  });
  assert.match((await injectedFallback("x86_64-unknown-linux-gnu")).path, /agent-manager-runner-/u);
  assert.deepEqual(attemptedNames, [
    "wollipog-runner-x86_64-unknown-linux-gnu",
    "agent-manager-runner-x86_64-unknown-linux-gnu",
  ]);
});

test("makeBinaryResolver does not warn when a canonical release asset succeeds", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-canonical-warning-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    warn: (warning) => warnings.push(warning),
    download: async (_request, dest) => writeFileSync(dest, "canonical release"),
  });
  assert.match((await resolve("x86_64-unknown-linux-gnu")).path, /wollipog-runner-/u);
  assert.equal(warnings.includes(LEGACY_RUNNER_ASSET_WARNING), false);
});

test("makeBinaryResolver verifies publisher digests and records their provenance", async (t) => {
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-publisher-digest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = "verified release bytes";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    download: async (_request, dest) => {
      writeFileSync(dest, bytes);
      return { sha256 };
    },
  });
  const resolved = await resolve("aarch64-apple-darwin");
  const manifest = JSON.parse(readFileSync(`${resolved.path}.manifest.json`, "utf8")) as Record<string, unknown>;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.digestProvenance, "github-release-asset");
  assert.equal(manifest.sha256, sha256);

  const rejected = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.9.0",
    token: null,
    cacheDir: join(root, "bad-cache"),
    distBinDir: join(root, "none"),
    download: async (_request, dest) => {
      writeFileSync(dest, bytes);
      return { sha256: "0".repeat(64) };
    },
  });
  await assert.rejects(() => rejected("aarch64-apple-darwin"), /did not match its GitHub release SHA-256/);
  assert.deepEqual(readdirSync(join(root, "bad-cache", "v0.9.0")), []);
});

test("makeBinaryResolver reuses an exact legacy-name schema-1 rollback cache", async (t) => {
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-legacy-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseDir = join(root, "cache", "v0.8.0");
  const name = "agent-manager-runner-x86_64-unknown-linux-gnu";
  const path = join(releaseDir, name);
  const bytes = "legacy cached release";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(path, bytes);
  writeFileSync(`${path}.manifest.json`, JSON.stringify({
    schemaVersion: 1,
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    assetName: name,
    sha256,
    size: Buffer.byteLength(bytes),
  }));
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    download: async () => { throw new Error("rollback cache should avoid the network"); },
  });
  assert.equal((await resolve("x86_64-unknown-linux-gnu")).path, path);
});

test("makeBinaryResolver repairs damaged canonical cache without downgrading to valid legacy cache", async (t) => {
  const { createHash } = await import("node:crypto");
  const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-canonical-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseDir = join(root, "cache", "v0.8.0");
  const canonicalName = "wollipog-runner-x86_64-unknown-linux-gnu";
  const legacyName = "agent-manager-runner-x86_64-unknown-linux-gnu";
  const canonicalPath = join(releaseDir, canonicalName);
  const legacyPath = join(releaseDir, legacyName);
  const manifest = (assetName: string, bytes: string) => JSON.stringify({
    schemaVersion: 1,
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    assetName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: Buffer.byteLength(bytes),
  });
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(canonicalPath, "damaged canonical");
  writeFileSync(`${canonicalPath}.manifest.json`, manifest(canonicalName, "original canonical"));
  writeFileSync(legacyPath, "valid legacy");
  writeFileSync(`${legacyPath}.manifest.json`, manifest(legacyName, "valid legacy"));

  const attemptedDowngrade = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    release: async () => ({
      assetName: legacyName,
      download: async () => { throw new Error("legacy bytes must not be requested"); },
    }),
  });
  await assert.rejects(
    () => attemptedDowngrade("x86_64-unknown-linux-gnu"),
    /selected unexpected runner asset.*agent-manager-runner/u,
    "a release resolver cannot override a canonical cache generation pin",
  );

  let failCanonicalRepair = true;
  const requestedGenerations: string[][] = [];
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    release: async (request) => {
      requestedGenerations.push([...request.assetNames]);
      return {
        assetName: canonicalName,
        download: async (dest) => {
          if (failCanonicalRepair) throw new Error("canonical repair unavailable");
          writeFileSync(dest, "repaired canonical");
          return {};
        },
      };
    },
  });

  await assert.rejects(() => resolve("x86_64-unknown-linux-gnu"), /canonical repair unavailable/);
  assert.deepEqual(requestedGenerations, [[canonicalName]],
    "canonical cache state pins release resolution to the canonical generation");
  assert.equal(readFileSync(legacyPath, "utf8"), "valid legacy",
    "a failed canonical repair does not promote, corrupt, or consume the legacy cache");

  failCanonicalRepair = false;
  const repaired = await resolve("x86_64-unknown-linux-gnu");
  assert.equal(repaired.path, canonicalPath);
  assert.equal(readFileSync(canonicalPath, "utf8"), "repaired canonical");
  assert.deepEqual(requestedGenerations, [[canonicalName], [canonicalName]]);
  assert.equal(existsSync(legacyPath), false, "canonical promotion removes the superseded legacy binary");
  assert.equal(existsSync(`${legacyPath}.manifest.json`), false,
    "canonical promotion removes the superseded legacy manifest");
});

test("makeBinaryResolver: refresh bypasses the cache and re-downloads; dev dirs still win", async (t) => {
  const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");

  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const distBinDir = join(root, "dist-bin");
  mkdirSync(cacheDir, { recursive: true });
  const name = "wollipog-runner-aarch64-unknown-linux-gnu";
  const legacyName = "agent-manager-runner-aarch64-unknown-linux-gnu";
  writeFileSync(join(cacheDir, legacyName), "old release");

  const downloads: { repo: string; releaseTag: string; assetName: string; token?: string }[] = [];
  const warnings: string[] = [];
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir,
    distBinDir,
    warn: (message) => warnings.push(message),
    download: async (request, dest) => {
      downloads.push(request);
      writeFileSync(dest, "new release");
    },
  });

  // Plain resolution: the cached binary satisfies the lookup, no download.
  const cached = await resolve("aarch64-unknown-linux-gnu");
  assert.equal(cached.path, join(cacheDir, "v0.8.0", name));
  assert.equal(cached.source, "release-cache");
  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0], { repo: "acme/wollipog", releaseTag: "v0.8.0", assetName: name, token: undefined });
  assert.ok(warnings.some((message) => message.includes("unversioned legacy runner cache")));
  assert.equal(existsSync(join(cacheDir, legacyName)), false, "successful exact-release resolution removes the legacy file");
  assert.equal((await resolve("aarch64-unknown-linux-gnu")).path, cached.path);
  assert.equal(downloads.length, 1);

  // Refresh bypasses the valid cache and downloads this packaged app's exact release again.
  const refreshed = await resolve("aarch64-unknown-linux-gnu", { refresh: true });
  assert.equal(refreshed.path, join(cacheDir, "v0.8.0", name));
  assert.equal(downloads.length, 2);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(refreshed.path, "utf8"), "new release");

  // A dev-staged build outranks the release even under refresh: it is fresher by definition.
  mkdirSync(distBinDir, { recursive: true });
  writeFileSync(join(distBinDir, name), "dev build");
  const dev = await resolve("aarch64-unknown-linux-gnu", { refresh: true });
  assert.equal(dev.path, join(distBinDir, name));
  assert.equal(dev.source, "staged");
  assert.equal(downloads.length, 2, "no third download when a dev dir supplies the binary");
  assert.ok(warnings.some((message) => message.includes("release identity cannot be verified")));
});

test("makeBinaryResolver: a failed refresh keeps the previously-cached binary intact", async (t) => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");

  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-fail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  let fail = false;

  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir,
    distBinDir: join(root, "none"),
    download: async (_request, dest) => {
      writeFileSync(dest, fail ? "partial garbage" : "known good");
      if (fail) throw new Error("connection reset");
    },
  });

  const cached = await resolve("x86_64-unknown-linux-gnu");
  fail = true;
  await assert.rejects(() => resolve("x86_64-unknown-linux-gnu", { refresh: true }), /connection reset/);
  // The good cached binary survives, and no .partial-* debris is left behind.
  assert.equal(readFileSync(cached.path, "utf8"), "known good");
  assert.ok(readdirSync(join(cacheDir, "v0.8.0")).every((entry) => !entry.includes(".partial-")));
  // Plain resolution still serves the intact cache.
  assert.equal((await resolve("x86_64-unknown-linux-gnu")).path, cached.path);
});

test("makeBinaryResolver: release cache is rehashed before reuse and deployment receives that digest", async (t) => {
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-digest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let hashes = 0;
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    digest: async (path) => {
      hashes++;
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    },
    download: async (_request, dest) => writeFileSync(dest, "large-runner-binary"),
  });

  const first = await resolve("x86_64-unknown-linux-gnu");
  assert.equal(hashes, 1, "download is hashed once to create its manifest");
  const second = await resolve("x86_64-unknown-linux-gnu");
  assert.equal(hashes, 2, "a cache hit rehashes bytes instead of trusting timestamp metadata");
  assert.equal(second.sha256, first.sha256, "orchestrator receives the freshly verified digest");
});

test("makeBinaryResolver: an empty download is rejected and leaves no cache entry", async (t) => {
  const { mkdtempSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseDir = join(root, "cache", "v0.8.0");
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    download: async (_request, dest) => writeFileSync(dest, ""),
  });
  await assert.rejects(() => resolve("x86_64-unknown-linux-gnu"), /was empty/);
  assert.deepEqual(readdirSync(releaseDir), []);
});

test("makeBinaryResolver: concurrent refreshes of one triple share a single download", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");

  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-conc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");

  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir,
    distBinDir: join(root, "none"),
    download: async (_url, dest) => {
      calls++;
      await gate; // hold both callers in the download window
      writeFileSync(dest, "release");
    },
  });

  const [a, b] = [resolve("aarch64-apple-darwin", { refresh: true }), resolve("aarch64-apple-darwin", { refresh: true })];
  release();
  assert.equal(await a, await b);
  assert.equal(calls, 1, "second caller joined the in-flight download");
  // A later refresh (nothing in flight) downloads again.
  await resolve("aarch64-apple-darwin", { refresh: true });
  assert.equal(calls, 2);
});

test("makeBinaryResolver: corrupt content is rejected even when release identity matches", async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const warnings: string[] = [];
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir: join(root, "cache"),
    distBinDir: join(root, "none"),
    warn: (message) => warnings.push(message),
    download: async (_request, dest) => {
      calls++;
      writeFileSync(dest, calls === 1 ? "trusted-one" : "trusted-two");
    },
  });
  const path = await resolve("x86_64-unknown-linux-gnu");
  writeFileSync(path.path, "tampered-x!"); // same byte length, so the full hash check is decisive
  assert.equal((await resolve("x86_64-unknown-linux-gnu")).path, path.path);
  assert.equal(calls, 2);
  assert.equal(readFileSync(path.path, "utf8"), "trusted-two");
  assert.ok(warnings.some((message) => message.includes("content hash mismatch")));
});

test("makeBinaryResolver: malformed, wrong-release, and wrong-size manifests are never trusted", async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const cases: Array<{
    name: string;
    warning: string;
    mutate: (manifestPath: string) => void;
  }> = [
    {
      name: "malformed",
      warning: "missing or malformed cache manifest",
      mutate: (path) => writeFileSync(path, "not-json"),
    },
    {
      name: "string-schema",
      warning: "missing or malformed cache manifest",
      mutate: (path) => {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        manifest.schemaVersion = "1";
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
    {
      name: "wrong-release",
      warning: "release identity mismatch",
      mutate: (path) => {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        manifest.releaseTag = "v0.7.0";
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
    {
      name: "wrong-size",
      warning: "size mismatch",
      mutate: (path) => {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        manifest.size = Number(manifest.size) + 1;
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-resolver-${scenario.name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const warnings: string[] = [];
    const resolve = makeBinaryResolver({
      repo: "acme/wollipog",
      releaseTag: "v0.8.0",
      token: null,
      cacheDir: join(root, "cache"),
      distBinDir: join(root, "none"),
      warn: (message) => warnings.push(message),
      download: async (_request, dest) => {
        calls++;
        writeFileSync(dest, `download-${calls}`);
      },
    });
    const path = await resolve("x86_64-unknown-linux-gnu");
    scenario.mutate(`${path.path}.manifest.json`);
    await resolve("x86_64-unknown-linux-gnu");
    assert.equal(calls, 2, scenario.name);
    assert.ok(warnings.some((message) => message.includes(scenario.warning)), scenario.name);
  }
});

test("makeBinaryResolver: release tags partition cache and token never enters logs or manifests", async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs: string[] = [];
  const requests: { releaseTag: string; token?: string }[] = [];
  const build = (releaseTag: string) =>
    makeBinaryResolver({
      repo: "private/wollipog",
      releaseTag,
      token: "top-secret-token",
      cacheDir: join(root, "cache"),
      distBinDir: join(root, "none"),
      log: (message) => logs.push(message),
      download: async (request, dest) => {
        requests.push({ releaseTag: request.releaseTag, token: request.token });
        writeFileSync(dest, request.releaseTag);
      },
    });
  const oldPath = await build("v0.7.0")("aarch64-apple-darwin");
  const newPath = await build("v0.8.0")("aarch64-apple-darwin");
  assert.notEqual(oldPath.path, newPath.path);
  assert.deepEqual(requests, [
    { releaseTag: "v0.7.0", token: "top-secret-token" },
    { releaseTag: "v0.8.0", token: "top-secret-token" },
  ]);
  const persisted = [
    readFileSync(`${oldPath.path}.manifest.json`, "utf8"),
    readFileSync(`${newPath.path}.manifest.json`, "utf8"),
    ...logs,
  ].join("\n");
  assert.ok(!persisted.includes("top-secret-token"));
  assert.throws(
    () => build("../../escape"),
    /invalid runner release tag/,
    "release identity cannot escape its cache namespace",
  );
  assert.throws(
    () =>
      makeBinaryResolver({
        repo: "https://evil.invalid/wollipog",
        releaseTag: "v0.8.0",
        cacheDir: join(root, "cache"),
        distBinDir: join(root, "none"),
      }),
    /invalid GitHub repository/,
  );
  await assert.rejects(() => build("v0.8.0")("../../outside"), /invalid runner target triple/);
});

test("makeBinaryResolver: retention keeps current plus one rollback release", async (t) => {
  const { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const warnings: string[] = [];
  const resolveRelease = async (releaseTag: string) => {
    const resolve = makeBinaryResolver({
      repo: "acme/wollipog",
      releaseTag,
      token: null,
      cacheDir,
      distBinDir: join(root, "none"),
      warn: (message) => warnings.push(message),
      download: async (_request, dest) => writeFileSync(dest, releaseTag),
    });
    await resolve("x86_64-unknown-linux-gnu");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
  };

  await resolveRelease("v0.7.0");
  await resolveRelease("v0.8.0");
  const outside = join(root, "outside-release");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "outside");
  let linked = true;
  try {
    symlinkSync(outside, join(cacheDir, "v0.6.0-link"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    linked = false;
  }
  await resolveRelease("v0.9.0");
  assert.equal(existsSync(join(cacheDir, "v0.9.0")), true, "current release is never pruned");
  assert.equal(existsSync(join(cacheDir, "v0.8.0")), true, "one prior release remains for rollback");
  assert.equal(existsSync(join(cacheDir, "v0.7.0")), false, "older releases are bounded");
  if (linked) {
    assert.equal(existsSync(join(cacheDir, "v0.6.0-link")), true, "retention never removes a symlinked sibling");
    assert.equal(existsSync(join(outside, "keep.txt")), true, "retention never follows a symlink outside its root");
  }
  assert.ok(warnings.some((message) => message.includes("pruned stale runner release cache v0.7.0")));
});

test("makeBinaryResolver: release directory symlinks cannot redirect managed writes", async (t) => {
  const { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { makeBinaryResolver } = await import("./box-orchestrator.js");
  const root = mkdtempSync(join(tmpdir(), "wollipog-resolver-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const outside = join(root, "outside");
  mkdirSync(cacheDir);
  mkdirSync(outside);
  try {
    symlinkSync(outside, join(cacheDir, "v0.8.0"), process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    t.skip(`directory symlink unavailable: ${(err as Error).message}`);
    return;
  }
  const resolve = makeBinaryResolver({
    repo: "acme/wollipog",
    releaseTag: "v0.8.0",
    token: null,
    cacheDir,
    distBinDir: join(root, "none"),
    download: async (_request, dest) => writeFileSync(dest, "must-not-be-written"),
  });
  await assert.rejects(() => resolve("x86_64-unknown-linux-gnu"), /real directory, not a symlink/);
  assert.equal(existsSync(join(outside, "wollipog-runner-x86_64-unknown-linux-gnu")), false);
});

test("GitHub request headers keep auth on API hops and strip it before a CDN redirect", async () => {
  const { githubRequestHeaders, redirectedRequestHeaders } = await import("./box-orchestrator.js");
  const headers = githubRequestHeaders("secret", "application/octet-stream");
  assert.equal(headers.Authorization, "Bearer secret");
  assert.equal(redirectedRequestHeaders(headers, "https://api.github.com/next").Authorization, "Bearer secret");
  const cdn = redirectedRequestHeaders(headers, "https://objects.githubusercontent.com/release/file");
  assert.equal(cdn.Authorization, undefined);
  assert.equal(cdn.Accept, "application/octet-stream");
});
