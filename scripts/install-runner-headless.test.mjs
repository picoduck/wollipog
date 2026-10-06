import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ReleaseStaging, stagingFilesystem } from "../apps/runner/src/release-staging.ts";
import { defaultServiceHost, runServiceCli } from "../apps/runner/src/service-cli.ts";
import { CONTROL_PLANE_UNIT, parseEnvFile, serviceLayout } from "../apps/runner/src/systemd-service.ts";
import { resolveWebDist } from "../apps/control-plane/src/web-dist.ts";

const triple = "x86_64-unknown-linux-gnu";
const runnerAsset = `wollipog-runner-${triple}`;
const controlPlaneAsset = `wollipog-control-plane-${triple}`;
const webAsset = "wollipog-web.tar.gz";
const releaseTag = "v1.2.3";
const havePosixShell = process.platform !== "win32" && spawnSync("sh", ["-c", ":"], { stdio: "ignore" }).status === 0
  && spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
const posixTest = havePosixShell ? test : test.skip;
const installer = process.env.HEADLESS_INSTALLER_TEST_PATH ?? fileURLToPath(new URL("./install-runner.sh", import.meta.url));

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { encoding: "utf8" });
  chmodSync(path, 0o755);
}

// Signal only the fixture installer parent, once, at a confirmed utility boundary.
// Before skips the operation; after runs the real utility successfully before signaling.
const signalInjection = `
inject_signal() {
  [ "$TEST_SIGNAL_BOUNDARY:$TEST_SIGNAL_TIMING" = "$1:$2" ] || return 1
  [ ! -e "$TEST_SIGNAL_SENT" ] || return 1
  case "$TEST_SIGNAL" in HUP|INT|TERM) ;; *) exit 95 ;; esac
  printf '%s\\n' "$1:$2:$TEST_SIGNAL" > "$TEST_SIGNAL_SENT"
  echo "fixture signal $1:$2:$TEST_SIGNAL" >&2
  kill -s "$TEST_SIGNAL" "$PPID"
}
`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** A fake GitHub release with runner, control-plane, and web assets served by fake curl. */
function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-headless-installer-"));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const assetsDir = join(root, "assets");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(assetsDir, "web"), { recursive: true, mode: 0o755 });
  writeFileSync(join(assetsDir, runnerAsset), "runner bytes\n");
  writeFileSync(join(assetsDir, controlPlaneAsset), "control plane bytes\n");
  writeFileSync(join(assetsDir, "web", "index.html"), "<html>dashboard</html>");
  assert.equal(spawnSync("tar", ["-C", assetsDir, "-czf", join(assetsDir, webAsset), "web"], { stdio: "ignore" }).status, 0);
  const names = options.omitControlPlane ? [runnerAsset, webAsset] : [runnerAsset, controlPlaneAsset, webAsset];
  const digests = Object.fromEntries(names.map((name) => [name, sha256(readFileSync(join(assetsDir, name)))]));
  if (options.tamperControlPlane) writeFileSync(join(assetsDir, controlPlaneAsset), "tampered\n");
  const manifest = `${names.map((name) => `${digests[name]}  ${name}`).sort().join("\n")}\n`;
  writeFileSync(join(assetsDir, "SHA256SUMS"), manifest);
  const assetsJson = JSON.stringify({
    tag_name: releaseTag,
    assets: [
      ...names.map((name) => ({ name, digest: `sha256:${digests[name]}`, browser_download_url: `https://download.test/${releaseTag}/${name}` })),
      ...(options.omitManifest ? [] : [{ name: "SHA256SUMS", digest: `sha256:${sha256(Buffer.from(manifest))}`, browser_download_url: `https://download.test/${releaseTag}/SHA256SUMS` }]),
    ],
  });
  writeFileSync(join(root, "release.json"), assetsJson);
  executable(join(fakeBin, "uname"), `[ "\${1:-}" = "-s" ] && echo ${options.os ?? "Linux"} || echo x86_64\n`);
  executable(join(fakeBin, "hostname"), "echo test-host\n");
  executable(join(fakeBin, "curl"), `
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -fsSL | -fL) shift ;;
    https://*) url="$1"; shift ;;
    *) echo "unexpected fixture curl argument" >&2; exit 91 ;;
  esac
done
case "$url" in
  https://api.github.com/repos/picoduck/wollipog/releases/latest | https://api.github.com/repos/picoduck/wollipog/releases/tags/"$TEST_RELEASE_TAG")
    cat "$TEST_RELEASE_JSON"; exit 0 ;;
  https://api.github.com/repos/picoduck/wollipog/releases/tags/*) exit 22 ;;
  https://download.test/"$TEST_RELEASE_TAG"/wollipog-runner-x86_64-unknown-linux-gnu | https://download.test/"$TEST_RELEASE_TAG"/wollipog-control-plane-x86_64-unknown-linux-gnu | https://download.test/"$TEST_RELEASE_TAG"/wollipog-web.tar.gz | https://download.test/"$TEST_RELEASE_TAG"/SHA256SUMS)
    [ -n "$out" ] || exit 92
    cp "$TEST_ASSETS_DIR/$(basename "$url")" "$out" ;;
  *) echo "unexpected fixture curl URL" >&2; exit 93 ;;
esac
`);
  // Even a missing release must not fall through to ambient gh credentials or network.
  executable(join(fakeBin, "gh"), 'echo "unexpected fixture gh invocation" >&2\nexit 22\n');
  executable(join(fakeBin, "tar"), `
case "$1" in
  --version) ;;
  -xzf) case "$2:$3:$4" in "$TEST_ROOT/"*:-C:"$TEST_ROOT/"*) ;; *) exit 94 ;; esac ;;
  *) exit 94 ;;
esac
if [ "$TEST_FAULT" = extract ] && [ "$1" = -xzf ]; then exit 85; fi
PATH="$TEST_ORIGINAL_PATH"; export PATH
exec tar "$@"
`);
  executable(join(fakeBin, "mv"), `
${signalInjection}
for arg in "$@"; do case "$arg" in -f) ;; "$TEST_ROOT/"*) ;; *) exit 94 ;; esac; done
boundary=
if [ "$#" -eq 2 ]; then
  case "$1:$2" in
    "$TEST_WEB_DIR.previous":*/.wollipog-web.stage.*/previous) boundary=save-previous ;;
    "$TEST_WEB_DIR":"$TEST_WEB_DIR.previous") boundary=save-current ;;
    */.wollipog-web.stage.*/web:"$TEST_WEB_DIR") boundary=promote ;;
    "$TEST_WEB_DIR.previous":"$TEST_WEB_DIR") boundary=restore-current ;;
    */.wollipog-web.stage.*/previous:"$TEST_WEB_DIR.previous") boundary=restore-previous ;;
  esac
fi
if [ "$#" -eq 2 ] && [ "$2" = "$TEST_WEB_DIR" ]; then
  case "$1" in
    */.wollipog-web.stage.*/web) case "$TEST_FAULT" in promote|rollback) exit 86 ;; esac ;;
    "$TEST_WEB_DIR.previous") [ "$TEST_FAULT" != rollback ] || exit 87 ;;
  esac
fi
if [ "$#" -eq 2 ] && [ "$TEST_FAULT" = save-previous ] && [ "$1" = "$TEST_WEB_DIR.previous" ]; then
  case "$2" in */.wollipog-web.stage.*/previous) exit 89 ;; esac
fi
if [ "$#" -eq 2 ] && [ "$TEST_FAULT" = save-current ] && [ "$1" = "$TEST_WEB_DIR" ] && [ "$2" = "$TEST_WEB_DIR.previous" ]; then exit 89; fi
PATH="$TEST_ORIGINAL_PATH"; export PATH
if [ -n "$boundary" ]; then
  if inject_signal "$boundary" before; then exit 0; fi
  mv "$@"
  if inject_signal "$boundary" after; then exit 0; fi
  exit 0
fi
exec mv "$@"
`);
  executable(join(fakeBin, "rm"), `
${signalInjection}
for arg in "$@"; do case "$arg" in -f|-rf|"") ;; "$TEST_ROOT/"*) ;; *) exit 94 ;; esac; done
boundary=
if [ "$#" -eq 2 ] && [ "$1" = -rf ]; then
  case "$2" in */.wollipog-web.stage.*) boundary=cleanup-stage ;; esac
fi
PATH="$TEST_ORIGINAL_PATH"; export PATH
if [ -n "$boundary" ]; then
  if inject_signal "$boundary" before; then exit 0; fi
  rm "$@"
  if inject_signal "$boundary" after; then exit 0; fi
  exit 0
fi
exec rm "$@"
`);
  executable(join(fakeBin, "ln"), `
if [ "$#" -eq 2 ] && [ "$2" = "$TEST_WEB_MARKER" ] && [ "$TEST_FAULT" = marker ]; then exit 88; fi
if [ "$#" -eq 2 ] && [ "$2" = "$TEST_WEB_MARKER" ] && [ "$TEST_FAULT" = marker-collision ]; then
  printf 'concurrent unrelated marker\n' > "$TEST_WEB_MARKER"
fi
PATH="$TEST_ORIGINAL_PATH"; export PATH
exec ln "$@"
`);
  if (!options.omitCmp) executable(join(fakeBin, "cmp"), `
case "$TEST_FAULT" in compare-error) exit 2 ;; compare-unavailable) exit 127 ;; esac
PATH="$TEST_ORIGINAL_PATH"; export PATH
exec cmp "$@"
`);
  // A restricted PATH models an actually absent cmp, not a failing replacement.
  // Keep curl/gh fixture-owned so the installer cannot reach ambient credentials or network.
  if (options.omitCmp) {
    for (const command of ["awk", "basename", "cat", "chmod", "cp", "cut", "dirname", "grep", "head", "mkdir",
      "mktemp", "rmdir", "sed", "sh"]) {
      const found = spawnSync("sh", ["-c", 'command -v "$1"', "fixture-tool", command], { encoding: "utf8" });
      assert.equal(found.status, 0, `required fixture utility: ${command}`);
      symlinkSync(found.stdout.trim(), join(fakeBin, command));
    }
    const hashTool = spawnSync("sh", ["-c", "command -v sha256sum || command -v shasum"], { encoding: "utf8" });
    assert.equal(hashTool.status, 0, "required fixture SHA-256 utility");
    const hashPath = hashTool.stdout.trim();
    symlinkSync(hashPath, join(fakeBin, hashPath.endsWith("sha256sum") ? "sha256sum" : "shasum"));
    const cmpLookup = spawnSync("sh", ["-c", "command -v cmp"], { env: { PATH: fakeBin }, encoding: "utf8" });
    assert.equal(cmpLookup.error, undefined);
    assert.ok(cmpLookup.status === 1 || cmpLookup.status === 127, "cmp is absent from the fixture PATH");
    assert.equal(cmpLookup.stdout, "");
  }
  let fault = "";
  let interruption = {};
  const run = (...args) => spawnSync("sh", ["-c", 'umask 022\nexec sh "$@"', "installer-test", installer, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: options.omitCmp ? fakeBin : `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: home,
      LC_ALL: "C",
      TEST_RELEASE_JSON: join(root, "release.json"),
      TEST_ASSETS_DIR: assetsDir,
      TEST_RELEASE_TAG: releaseTag,
      TEST_ROOT: root,
      TEST_ORIGINAL_PATH: process.env.PATH ?? "",
      TEST_WEB_DIR: options.legacy ? join(home, ".local", "share", "wollipog", "web") : join(home, ".local", "bin", "web"),
      TEST_WEB_MARKER: join(home, ".local", "bin", ".wollipog-web-layout-v1"),
      TEST_FAULT: fault,
      TEST_SIGNAL: interruption.signal ?? "",
      TEST_SIGNAL_BOUNDARY: interruption.boundary ?? "",
      TEST_SIGNAL_TIMING: interruption.timing ?? "",
      TEST_SIGNAL_SENT: join(root, "signal-sent"),
    },
  });
  return { root, home, run, setFault: (value) => { fault = value; },
    setInterruption: (value) => { interruption = value; rmSync(join(root, "signal-sent"), { force: true }); } };
}

const admissionAsset = {
  name: runnerAsset, size: 1, digest: `sha256:${sha256(Buffer.from("x"))}`, url: "https://fixture.invalid/runner",
};
const identity = (path) => {
  const { dev, ino, uid, gid, mode } = lstatSync(path);
  return { dev, ino, uid, gid, mode };
};
// Model supported host ancestry only outside the private fixture. Some managed sandboxes
// present / and /tmp as UID 65534. Every fixture-owned identity, mode and syscall stays real.
function admissionFilesystem(root) {
  const externalAncestors = new Set();
  for (let path = dirname(root);; path = dirname(path)) {
    externalAncestors.add(path);
    if (path === dirname(path)) break;
  }
  return {
    ...stagingFilesystem,
    lstat: (path) => {
      const stat = stagingFilesystem.lstat(path);
      return externalAncestors.has(path)
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0n })
        : stat;
    },
  };
}
const admit = (data, root, fs = admissionFilesystem(root)) =>
  ReleaseStaging.create(data, { mode: "user", serviceUid: null }, releaseTag, [admissionAsset], fs);

const siblingWeb = (h) => join(h.home, ".local", "bin", "web");
const layoutMarker = (h) => join(h.home, ".local", "bin", ".wollipog-web-layout-v1");
const markerBytes = "wollipog-sibling-web-v1\n";
function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const id = identity(path);
  if (stat.isSymbolicLink()) return { ...id, link: readlinkSync(path) };
  if (stat.isDirectory()) return { ...id, entries: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) };
  return { ...id, bytes: readFileSync(path).toString("hex") };
}
function namespace(h) {
  return [siblingWeb(h), siblingWeb(h) + ".previous", layoutMarker(h)].map(snapshot);
}

posixTest("headless installer diagnoses missing cmp before publication and preserves installed state", async (t) => {
  for (const layout of ["fresh", "owned"]) await t.test(layout, (t) => {
    const h = harness({ omitCmp: true });
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const bin = join(h.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    if (layout === "owned") {
      for (const name of ["wollipog-runner", "agent-manager-runner", "wollipog", "wollipog-control-plane"]) {
        writeFileSync(join(bin, name), `existing ${name} bytes`);
        chmodSync(join(bin, name), 0o755); // Inert bytes, never executed.
      }
      for (const name of ["web", "web.previous"]) {
        mkdirSync(join(bin, name));
        writeFileSync(join(bin, name, "index.html"), `existing ${name} bytes`);
      }
      writeFileSync(layoutMarker(h), markerBytes);
      const data = join(h.home, ".local", "share", "wollipog");
      const config = join(h.home, ".config", "wollipog");
      mkdirSync(join(data, "control-plane"), { recursive: true, mode: 0o700 });
      mkdirSync(join(data, "runner"));
      mkdirSync(config, { recursive: true, mode: 0o700 });
      for (const [path, bytes] of [
        [join(data, "control-plane", "control-plane.db"), "inert database sentinel"],
        [join(data, "control-plane", "artifact"), "inert artifact sentinel"],
        [join(data, "runner", "state"), "inert runner state sentinel"],
        [join(config, "control-plane.env"), "inert existing environment sentinel"],
        [join(config, "runner.config.json"), "inert existing config sentinel"],
        [join(config, "runner.token"), "inert credential sentinel"],
      ]) writeFileSync(path, bytes, { mode: 0o600 });
    }
    const before = snapshot(h.home);
    const result = h.run("--control-plane");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required tool: cmp; cannot validate dashboard layout markers/u);
    assert.doesNotMatch(result.stderr, /invalid dashboard layout marker|not found/u);
    assert.doesNotMatch(result.stdout, /Downloading/u);
    assert.deepEqual(snapshot(h.home), before, "no publication, scratch, adoption or installed-state changes");
  });
});

posixTest("runner-only installation does not require cmp", (t) => {
  const h = harness({ omitCmp: true });
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const result = h.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(join(h.home, ".local", "bin", "wollipog-runner"), "utf8"), "runner bytes\n");
  assert.ok(existsSync(join(h.home, ".config", "wollipog", "runner.config.json")));
  assert.equal(existsSync(layoutMarker(h)), false);
});

posixTest("headless marker comparison errors refuse without publication or installed-state changes", async (t) => {
  for (const fault of ["compare-error", "compare-unavailable"]) await t.test(fault, (t) => {
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    assert.equal(h.run("--control-plane").status, 0);
    const before = snapshot(h.home);
    h.setFault(fault);
    const result = h.run("--control-plane");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing an invalid dashboard layout marker/u);
    assert.doesNotMatch(result.stdout, /Downloading/u);
    assert.deepEqual(snapshot(h.home), before);
  });
});

posixTest("fresh headless root creates supported missing share ancestors without changing the existing home", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  mkdirSync(h.home, { recursive: true, mode: 0o755 });
  const home = identity(h.home);
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(identity(h.home), home);
  for (const path of [join(h.home, ".local"), join(h.home, ".local", "share")]) {
    assert.equal(statSync(path).mode & 0o7777, 0o755, path);
  }
  const data = join(h.home, ".local", "share", "wollipog");
  assert.equal(statSync(data).mode & 0o7777, 0o700, "fresh headless root must satisfy exact 0700 admission");
  assert.equal(statSync(siblingWeb(h)).mode & 0o7777, 0o755);
  if (process.platform === "linux") assert.equal(admit(data, h.root).finish(), null);
});

// Evaluate only real fixture home/descendant POSIX DAC bits. The private mkdtemp wrapper
// and external sandbox ancestry are a declared supported-host boundary, not normalized paths.
function accountExists(home, uid, gid) {
  const allowed = (stat, bits) => {
    const shift = stat.uid === uid ? 6 : stat.gid === gid ? 3 : 0;
    return ((stat.mode >> shift) & bits) === bits;
  };
  return (path) => {
    const local = relative(home, path);
    if (local === ".." || local.startsWith(".." + sep)) return false;
    let current = home;
    try {
      const parts = local ? local.split(sep) : [];
      for (let i = 0; i <= parts.length; i++) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return false;
        if (i < parts.length) {
          if (!stat.isDirectory() || !allowed(stat, 0o1)) return false;
          current = join(current, parts[i]);
        } else return allowed(stat, stat.isDirectory() ? 0o1 : 0o4);
      }
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    return false;
  };
}

posixTest("headless system dashboard remains readable independently of the private user data root through an inert selected-account host", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  mkdirSync(h.home, { recursive: true, mode: 0o755 });
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const selectedUid = statSync(h.home).uid + 1;
  const selectedGid = statSync(h.home).gid + 1;
  const env = { WOLLIPOG_SYSTEM_PREFIX: join(h.root, "system") };
  const layout = serviceLayout("system", { home: h.home, user: "operator", account: "headless_svc", env });
  const effects = [];
  const refuse = async () => { throw new Error("unexpected live effect in inert selected-account host"); };
  const host = {
    ...defaultServiceHost(),
    platform: "linux", uid: 0, user: "operator", home: h.home, isSea: true,
    execPath: join(h.home, ".local", "bin", "wollipog"), env, cwd: () => h.root,
    exec: async (command, args) => {
      effects.push([command, ...args]);
      if (command === "id" && args.join(" ") === "-u headless_svc") return { code: 0, stdout: String(selectedUid) + "\n", stderr: "" };
      if (command === "chown" && args[0] === "-R" && args[1] === "headless_svc:headless_svc" &&
        args.slice(2).every((path) => path.startsWith(env.WOLLIPOG_SYSTEM_PREFIX + sep))) return { code: 0, stdout: "", stderr: "" };
      if (command === "systemctl" && (args.join(" ") === "--version" || args.join(" ") === "daemon-reload" ||
        args.join(" ") === "enable " + CONTROL_PLANE_UNIT)) return { code: 0, stdout: "systemd 255\n", stderr: "" };
      throw new Error("unexpected injected command: " + command + " " + args.join(" "));
    },
    spawnInherit: refuse, fetch: refuse, fetchJson: refuse, download: refuse, sleep: refuse,
  };
  let out = "", err = "";
  const io = { stdout: (value) => { out += value; }, stderr: (value) => { err += value; }, stdinIsTTY: false, confirm: async () => false };
  const data = join(h.home, ".local", "share", "wollipog");
  const before = identity(data);
  assert.equal(await runServiceCli(["service", "install", "--system", "--account", "headless_svc", "--control-plane",
    "--no-start", "--no-linger", "--json"], host, io), 0, err + out);
  assert.deepEqual(JSON.parse(out).started, []);
  assert.ok(readFileSync(join(layout.unitDir, CONTROL_PLANE_UNIT), "utf8").includes("User=headless_svc\n"));
  const settings = parseEnvFile(readFileSync(layout.controlPlaneEnvFile, "utf8"));
  const exists = accountExists(h.home, selectedUid, selectedGid);
  assert.equal(resolveWebDist(settings, h.root, join(h.home, ".local", "bin", "wollipog-control-plane"), exists),
    settings.WOLLIPOG_WEB_DIST, "selected system account must resolve the installed public dashboard");
  assert.ok(settings.WOLLIPOG_WEB_DIST, "fresh generated env must name its public dashboard");
  assert.equal(exists(data), false, "the selected account cannot traverse the private user data root");
  assert.deepEqual(identity(data), before);
  assert.equal(effects.some(([command, ...args]) => command !== "id" && command !== "chown" && command !== "systemctl" ||
    args.some((arg) => arg === "start" || arg === "restart" || arg === "--version" && command !== "systemctl")), false);
  chmodSync(join(h.home, ".local"), 0o700);
  const unsupported = identity(join(h.home, ".local"));
  assert.equal(resolveWebDist(settings, h.root, join(h.home, ".local", "bin", "wollipog-control-plane"), exists), null);
  assert.deepEqual(identity(join(h.home, ".local")), unsupported, "account model does not normalize private ancestors");
});

posixTest("headless sibling bundle durable provenance survives two modeled release generations, rollback and installer reinstall", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  assert.equal(h.run("--control-plane").status, 0);
  const marker = snapshot(layoutMarker(h));
  assert.equal(readFileSync(layoutMarker(h), "utf8"), markerBytes);
  const web = siblingWeb(h), previous = web + ".previous";
  const generation = (number) => {
    const stage = join(h.root, "generation-" + number);
    mkdirSync(stage, { mode: 0o755 });
    writeFileSync(join(stage, "index.html"), "generation " + number);
    rmSync(previous, { recursive: true, force: true }); // Model unchanged generic asset-generation promotion only.
    renameSync(web, previous);
    renameSync(stage, web);
    assert.equal(existsSync(join(web, ".wollipog-installer-layout-v1")), false);
    assert.deepEqual(snapshot(layoutMarker(h)), marker);
  };
  generation(1);
  const first = h.run("--control-plane");
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.deepEqual(snapshot(layoutMarker(h)), marker);
  generation(2);
  generation(3); // Two normal swaps before a rollback; no source code, asset executable or service is run.
  rmSync(web, { recursive: true });
  renameSync(previous, web);
  assert.equal(readFileSync(join(web, "index.html"), "utf8"), "generation 2");
  const second = h.run("--control-plane");
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual(snapshot(layoutMarker(h)), marker);
  assert.equal(readFileSync(join(web, "index.html"), "utf8"), "<html>dashboard</html>");
  assert.equal(readFileSync(join(previous, "index.html"), "utf8"), "generation 2");
});

posixTest("headless sibling bundle refuses arbitrary namespace, provenance and lock collisions without adoption or cleanup", async (t) => {
  const cases = ["current", "previous", "current-link", "previous-link", "marker-link", "malformed-marker",
    "extra-newline-marker", "missing-newline-marker", "marker-directory", "owned-current-file", "owned-previous-no-index", "owned-current-link", "owned-previous-link",
    "current-dangling-link", "previous-dangling-link", "marker-dangling-link", "lock"];
  for (const kind of cases) await t.test(kind, (t) => {
    if (process.platform === "win32" && kind.includes("link")) { t.skip("fixture symlinks require native POSIX permissions"); return; }
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const bin = join(h.home, ".local", "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    const target = join(h.root, "unrelated");
    mkdirSync(target);
    writeFileSync(join(target, "index.html"), "unrelated stored bytes");
    if (kind.startsWith("owned-")) writeFileSync(layoutMarker(h), markerBytes);
    if (kind === "current" || kind === "previous" || kind === "owned-previous-no-index") {
      const path = kind === "current" ? siblingWeb(h) : siblingWeb(h) + ".previous";
      mkdirSync(path); writeFileSync(join(path, "sentinel"), "arbitrary content");
    } else if (kind === "owned-current-file") writeFileSync(siblingWeb(h), "arbitrary file");
    else if (kind.includes("link")) {
      const path = kind.startsWith("marker-") ? layoutMarker(h) : siblingWeb(h) + (kind.includes("previous") ? ".previous" : "");
      symlinkSync(kind.includes("dangling") ? join(target, "absent") : target, path, "dir");
    } else if (kind === "marker-directory") mkdirSync(layoutMarker(h));
    else if (kind.includes("marker")) writeFileSync(layoutMarker(h), kind === "extra-newline-marker" ? markerBytes + "\n"
      : kind === "missing-newline-marker" ? markerBytes.trimEnd() : "foreign marker\n");
    else mkdirSync(join(bin, ".wollipog-web-install.lock"));
    const before = snapshot(h.home), targetBefore = snapshot(target);
    const result = h.run("--control-plane");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing/u);
    assert.deepEqual(snapshot(h.home), before);
    assert.deepEqual(snapshot(target), targetBefore);
  });
});

posixTest("headless sibling bundle extraction, marker and first-publication failures leave no claimed namespace or owned scratch", async (t) => {
  for (const fault of ["extract", "marker", "promote"]) await t.test(fault, (t) => {
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    h.setFault(fault);
    const result = h.run("--control-plane");
    assert.notEqual(result.status, 0);
    assert.deepEqual(namespace(h), [null, null, null]);
    assert.equal(readdirSync(join(h.home, ".local", "bin")).some((name) => name.startsWith(".wollipog-web")), false);
    assert.equal(statSync(join(h.home, ".local", "share", "wollipog")).mode & 0o7777, 0o700);
  });
});

posixTest("headless sibling bundle exclusive marker publication preserves a concurrent unrelated marker", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.setFault("marker-collision");
  const result = h.run("--control-plane");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not exclusively publish dashboard layout marker/u);
  assert.equal(readFileSync(layoutMarker(h), "utf8"), "concurrent unrelated marker\n");
  assert.equal(existsSync(siblingWeb(h)), false);
  assert.equal(existsSync(siblingWeb(h) + ".previous"), false);
  assert.equal(readdirSync(join(h.home, ".local", "bin")).filter((name) => name.startsWith(".wollipog-web") && name !== ".wollipog-web-layout-v1").length, 0);
});

posixTest("headless sibling bundle restores both owned generations after publication failure and preserves failed-rollback evidence", async (t) => {
  for (const fault of ["extract", "save-previous", "save-current", "promote", "rollback"]) await t.test(fault, (t) => {
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const initial = h.run("--control-plane");
    assert.equal(initial.status, 0, initial.stderr + initial.stdout);
    const previous = siblingWeb(h) + ".previous";
    mkdirSync(previous); writeFileSync(join(previous, "index.html"), "older owned generation");
    const before = namespace(h);
    const data = join(h.home, ".local", "share", "wollipog"), dataBefore = snapshot(data);
    h.setFault(fault);
    const result = h.run("--control-plane");
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(data), dataBefore);
    assert.deepEqual(snapshot(layoutMarker(h)), before[2]);
    const stages = readdirSync(join(h.home, ".local", "bin")).filter((name) => name.startsWith(".wollipog-web.stage."));
    assert.equal(existsSync(join(h.home, ".local", "bin", ".wollipog-web-install.lock")), false);
    if (fault === "rollback") {
      assert.match(result.stderr, /rollback failed; retained owned evidence/u);
      assert.equal(stages.length, 1);
      const stage = join(h.home, ".local", "bin", stages[0]);
      assert.deepEqual(snapshot(previous), before[0], "original current generation remains retained as previous");
      assert.deepEqual(snapshot(join(stage, "previous")), before[1], "older previous retains its original inode and bytes");
      assert.equal(readFileSync(join(stage, "web", "index.html"), "utf8"), "<html>dashboard</html>");
    } else {
      assert.deepEqual(namespace(h), before);
      assert.deepEqual(stages, []);
      if (fault !== "extract") assert.match(result.stderr, /previous dashboard generations were restored/u);
    }
  });
});

function interruptedPublicationFixture(t, { legacy = false, generations = "both" } = {}) {
  const h = harness({ legacy });
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const web = legacy ? join(h.home, ".local", "share", "wollipog", "web") : siblingWeb(h);
  const parent = dirname(web);
  mkdirSync(parent, { recursive: true });
  if (!legacy && generations !== "fresh") writeFileSync(layoutMarker(h), markerBytes);
  if (generations === "both" || generations === "current") {
    mkdirSync(web); writeFileSync(join(web, "index.html"), "original current generation");
  }
  if (generations === "both" || generations === "previous") {
    mkdirSync(web + ".previous"); writeFileSync(join(web + ".previous", "index.html"), "original previous generation");
  }
  const data = join(h.home, ".local", "share", "wollipog", "control-plane");
  const config = join(h.home, ".config", "wollipog");
  for (const dir of [data, config]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "inert-sentinel"), "stored private bytes", { mode: 0o600 });
  }
  const originals = [snapshot(web), snapshot(web + ".previous")];
  const privateBefore = [snapshot(data), snapshot(config)];
  const markerBefore = snapshot(layoutMarker(h));
  return { h, web, parent, originals, markerBefore, assertPrivate() {
    assert.deepEqual([snapshot(data), snapshot(config)], privateBefore);
    assert.equal(existsSync(join(h.home, ".local", "bin", ".wollipog-web-install.lock")), false);
  } };
}

function retainedPublicationStage(fixture, interruption, result) {
  const { h, web, parent } = fixture;
  assert.equal(result.error, undefined, "fixture installer must finish without timeout");
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const injection = `${interruption.boundary}:${interruption.timing}:${interruption.signal}`;
  assert.equal(readFileSync(join(h.root, "signal-sent"), "utf8"), injection + "\n");
  assert.ok(result.stderr.includes("fixture signal " + injection));
  const stages = readdirSync(parent).filter((name) => name.startsWith(".wollipog-web.stage."));
  assert.equal(stages.length, 1);
  const stage = join(parent, stages[0]);
  assert.ok(result.stderr.includes("retained owned evidence at " + stage));
  assert.ok(result.stderr.includes("Inspect it and dashboard paths " + web + " and " + web + ".previous before retrying"));
  assert.equal(readdirSync(parent).some((name) => name.startsWith(".wollipog-web.download.")), false);
  fixture.assertPrivate();
  return stage;
}

posixTest("headless publication retains each generation across HUP/INT/TERM before moves and after successful renames", async (t) => {
  for (const legacy of [false, true]) for (const signal of ["HUP", "INT", "TERM"]) {
    for (const boundary of ["save-previous", "save-current", "promote"]) for (const timing of ["before", "after"]) {
      await t.test(`${legacy ? "legacy" : "sibling"}:${boundary}:${timing}:${signal}`, (t) => {
        const f = interruptedPublicationFixture(t, { legacy });
        const interruption = { boundary, timing, signal };
        f.h.setInterruption(interruption);
        const stage = retainedPublicationStage(f, interruption, f.h.run("--control-plane"));
        const previousMoved = boundary !== "save-previous" || timing === "after";
        const currentMoved = boundary === "promote" || boundary === "save-current" && timing === "after";
        assert.deepEqual(snapshot(previousMoved ? join(stage, "previous") : f.web + ".previous"), f.originals[1]);
        assert.deepEqual(snapshot(currentMoved ? f.web + ".previous" : f.web), f.originals[0]);
        const promoted = boundary === "promote" && timing === "after";
        assert.equal(readFileSync(join(promoted ? f.web : join(stage, "web"), "index.html"), "utf8"), "<html>dashboard</html>");
        if (currentMoved && !promoted) assert.equal(existsSync(f.web), false);
        if (!previousMoved) assert.equal(existsSync(join(stage, "previous")), false);
        if (promoted) assert.equal(existsSync(join(stage, "web")), false);
        assert.deepEqual(snapshot(layoutMarker(f.h)), f.markerBefore);
      });
    }
  }
});

posixTest("headless publication retains evidence for fresh and partial owned layouts at promotion bookkeeping gaps", async (t) => {
  for (const generations of ["fresh", "current", "previous"]) for (const signal of ["HUP", "INT", "TERM"]) {
    for (const timing of ["before", "after"]) await t.test(`${generations}:${timing}:${signal}`, (t) => {
      const f = interruptedPublicationFixture(t, { generations });
      const interruption = { boundary: "promote", timing, signal };
      f.h.setInterruption(interruption);
      const stage = retainedPublicationStage(f, interruption, f.h.run("--control-plane"));
      assert.deepEqual(snapshot(f.web + ".previous"), f.originals[0]);
      assert.deepEqual(snapshot(join(stage, "previous")), f.originals[1]);
      const promoted = timing === "after";
      assert.equal(readFileSync(join(promoted ? f.web : join(stage, "web"), "index.html"), "utf8"), "<html>dashboard</html>");
      if (!promoted) assert.equal(existsSync(f.web), false);
      if (generations === "fresh") {
        assert.equal(existsSync(layoutMarker(f.h)), promoted, "fresh marker removed only when no dashboard was promoted");
        if (promoted) assert.equal(readFileSync(layoutMarker(f.h), "utf8"), markerBytes);
      } else assert.deepEqual(snapshot(layoutMarker(f.h)), f.markerBefore);
    });
  }
});

posixTest("headless publication keeps the guard armed during interrupted ordinary rollback", async (t) => {
  for (const signal of ["HUP", "INT", "TERM"]) for (const boundary of ["restore-current", "restore-previous"]) {
    for (const timing of ["before", "after"]) await t.test(`${boundary}:${timing}:${signal}`, (t) => {
      const f = interruptedPublicationFixture(t);
      const interruption = { boundary, timing, signal };
      f.h.setFault("promote");
      f.h.setInterruption(interruption);
      const stage = retainedPublicationStage(f, interruption, f.h.run("--control-plane"));
      const currentRestored = boundary === "restore-previous" || timing === "after";
      const previousRestored = boundary === "restore-previous" && timing === "after";
      assert.deepEqual(snapshot(currentRestored ? f.web : f.web + ".previous"), f.originals[0]);
      assert.deepEqual(snapshot(previousRestored ? f.web + ".previous" : join(stage, "previous")), f.originals[1]);
      assert.equal(readFileSync(join(stage, "web", "index.html"), "utf8"), "<html>dashboard</html>");
      assert.deepEqual(snapshot(layoutMarker(f.h)), f.markerBefore);
    });
  }
});

posixTest("headless committed publication cleans disposable scratch even when completed cleanup is interrupted", async (t) => {
  for (const signal of ["HUP", "INT", "TERM"]) for (const timing of ["before", "after"]) {
    await t.test(`${timing}:${signal}`, (t) => {
      const f = interruptedPublicationFixture(t);
      f.h.setInterruption({ boundary: "cleanup-stage", timing, signal });
      const result = f.h.run("--control-plane");
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(f.h.root, "signal-sent"), "utf8"), `cleanup-stage:${timing}:${signal}\n`);
      assert.doesNotMatch(result.stderr, /retained owned evidence/u);
      assert.equal(readFileSync(join(f.web, "index.html"), "utf8"), "<html>dashboard</html>");
      assert.deepEqual(snapshot(f.web + ".previous"), f.originals[0]);
      assert.deepEqual(snapshot(layoutMarker(f.h)), f.markerBefore);
      assert.deepEqual(readdirSync(f.parent).filter((name) => name.startsWith(".wollipog-web.stage.") || name.startsWith(".wollipog-web.download.")), []);
      f.assertPrivate();
    });
  }
});

posixTest("later attempts never adopt or clean retained stages or similarly named foreign paths", (t) => {
  const f = interruptedPublicationFixture(t);
  const interruption = { boundary: "save-current", timing: "after", signal: "TERM" };
  f.h.setInterruption(interruption);
  const stage = retainedPublicationStage(f, interruption, f.h.run("--control-plane"));
  const retained = snapshot(stage);
  const foreign = join(f.parent, ".wollipog-web.stage.foreign");
  const link = join(f.parent, ".wollipog-web.stage.foreign-link");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "index.html"), "unrelated generation");
  symlinkSync(foreign, link);
  const foreignBefore = [snapshot(foreign), snapshot(link)];
  f.h.setInterruption({});
  const retry = f.h.run("--control-plane");
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.deepEqual(snapshot(stage), retained);
  assert.deepEqual([snapshot(foreign), snapshot(link)], foreignBefore);
  // A retained stage cannot substitute for missing namespace provenance.
  rmSync(layoutMarker(f.h));
  const before = snapshot(f.h.home);
  const unmarked = f.h.run("--control-plane");
  assert.notEqual(unmarked.status, 0);
  assert.match(unmarked.stderr, /Refusing/u);
  assert.deepEqual(snapshot(f.h.home), before);
  f.assertPrivate();
});

posixTest("headless sibling bundle preserves legacy refresh and explicitly discloses mixed-layout env boundaries", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const legacy = join(h.home, ".local", "share", "wollipog", "web");
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  writeFileSync(join(legacy, "index.html"), "old legacy bundle");
  const root = dirname(legacy), rootBefore = identity(root);
  const first = h.run("--control-plane");
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(existsSync(siblingWeb(h)), false);
  assert.equal(existsSync(layoutMarker(h)), false);
  assert.deepEqual(identity(root), rootBefore);
  assert.equal(readFileSync(join(legacy, "index.html"), "utf8"), "<html>dashboard</html>");
  assert.equal(readFileSync(join(legacy + ".previous", "index.html"), "utf8"), "old legacy bundle");
  // Explicitly construct an independently installer-owned sibling namespace for the mixed case.
  mkdirSync(siblingWeb(h), { mode: 0o755 });
  writeFileSync(join(siblingWeb(h), "index.html"), "previous public bundle");
  writeFileSync(layoutMarker(h), markerBytes);
  const config = join(h.home, ".config", "wollipog", "control-plane.env");
  writeFileSync(config, 'WOLLIPOG_WEB_DIST="' + legacy + '"\n', { mode: 0o600 });
  const legacyBefore = snapshot(legacy), configBefore = snapshot(config);
  const mixed = h.run("--control-plane");
  assert.equal(mixed.status, 0, mixed.stderr + mixed.stdout);
  assert.match(mixed.stderr, /both dashboard layouts exist.*Existing service environment files/u);
  assert.deepEqual(snapshot(legacy), legacyBefore);
  assert.deepEqual(snapshot(config), configBefore);
  assert.deepEqual(identity(root), rootBefore);
  assert.equal(readFileSync(join(siblingWeb(h), "index.html"), "utf8"), "<html>dashboard</html>");
});

posixTest("fresh headless root is private under umask 022 and admits generic staging without executing assets", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  // Arbitrary existing ancestors must retain their modes while the new leaf becomes private.
  const share = join(h.home, ".local", "share");
  mkdirSync(share, { recursive: true, mode: 0o755 });
  chmodSync(h.home, 0o750);
  chmodSync(share, 0o750);
  const ancestors = [h.home, join(h.home, ".local"), share].map(identity);
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const data = join(share, "wollipog");
  const stat = statSync(data);
  assert.equal(stat.mode & 0o7777, 0o700, "fresh headless root must satisfy exact 0700 admission");
  assert.equal(stat.uid, statSync(h.home).uid);
  assert.equal(stat.gid, statSync(share).gid);
  assert.deepEqual([h.home, join(h.home, ".local"), share].map(identity), ancestors);
  assert.equal(statSync(join(h.home, ".config", "wollipog")).mode & 0o7777, 0o700);
  // The scoped umask must not affect the existing public dashboard archive semantics.
  assert.equal(statSync(join(h.home, ".local", "bin", "web")).mode & 0o777, 0o755);
  if (process.platform === "linux") {
    const before = identity(data);
    const staging = admit(data, h.root);
    assert.equal(staging.finish(), null);
    assert.deepEqual(identity(data), before);
    assert.ok(!existsSync(join(data, "upgrades")));
    // The explicit ancestor view cannot make a wrong data-root or ancestor owner admissible.
    const fs = admissionFilesystem(h.root);
    const foreignUid = BigInt(process.geteuid()) + 1n;
    for (const path of [data, "/"]) {
      const wrongOwner = { ...fs, lstat: (name) => {
        const stat = fs.lstat(name);
        return name === path ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: foreignUid }) : stat;
      } };
      assert.throws(() => admit(data, h.root, wrongOwner), /expected owner|unsafe ancestor ownership/u);
      assert.ok(!existsSync(join(data, "upgrades")));
    }
    const local = join(h.home, ".local");
    chmodSync(local, 0o775); // Deliberately unsupported, fixture-owned ancestor only.
    const unsupported = identity(local);
    assert.throws(() => admit(data, h.root), /unsafe ancestor ownership or writable permissions/u);
    assert.deepEqual(identity(local), unsupported, "admission never repairs the unsupported ancestor");
    assert.ok(!existsSync(join(data, "upgrades")));
  }
});

posixTest("headless installer preserves pre-existing root identities and stored content while admission stays strict", (t) => {
  for (const mode of [0o700, 0o755, 0o2700]) {
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const data = join(h.home, ".local", "share", "wollipog");
    const config = join(h.home, ".config", "wollipog");
    mkdirSync(join(data, "control-plane"), { recursive: true, mode: 0o755 });
    mkdirSync(join(data, "runner"), { recursive: true, mode: 0o755 });
    mkdirSync(config, { recursive: true, mode: 0o755 });
    const contents = [
      [join(data, "control-plane", "control-plane.db"), "stored database"],
      [join(data, "control-plane", "artifact"), "stored artifact"],
      [join(data, "runner", "state"), "stored runner state"],
      [join(config, "control-plane.env"), "existing config"],
      [join(config, "runner.config.json"), '{"runnerId":"existing","token":"inert-sentinel"}'],
      [join(config, "runner.token"), "inert credential sentinel"],
    ];
    for (const [path, content] of contents) {
      writeFileSync(path, content);
      chmodSync(path, 0o640);
    }
    chmodSync(data, mode);
    chmodSync(config, 0o750);
    const roots = [data, config, join(data, "control-plane"), join(data, "runner")];
    const rootIdentities = roots.map(identity);
    const fileIdentities = contents.map(([path]) => identity(path));
    const result = h.run("--control-plane");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(roots.map(identity), rootIdentities, `existing root identities for ${mode.toString(8)}`);
    assert.deepEqual(contents.map(([path]) => identity(path)), fileIdentities);
    for (const [path, content] of contents) assert.equal(readFileSync(path, "utf8"), content);
    if (process.platform === "linux") {
      if (mode === 0o700) assert.equal(admit(data, h.root).finish(), null);
      else assert.throws(() => admit(data, h.root), /data directory must have its expected owner and private 0700 permissions/u);
      assert.ok(!existsSync(join(data, "upgrades")), "no suspect-root recovery or staging left behind");
      assert.deepEqual(roots.map(identity), rootIdentities);
    }
  }
});

posixTest("install-runner.sh --control-plane installs the verified control plane and dashboard bundle and leaves the runner config to service install", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const bin = join(h.home, ".local", "bin");
  assert.equal(readFileSync(join(bin, "wollipog-runner"), "utf8"), "runner bytes\n");
  assert.equal(readFileSync(join(bin, "wollipog-control-plane"), "utf8"), "control plane bytes\n");
  assert.ok(existsSync(join(bin, "wollipog")), "the CLI alias is published");
  assert.equal(readFileSync(join(h.home, ".local", "bin", "web", "index.html"), "utf8"), "<html>dashboard</html>");
  assert.ok(!existsSync(join(h.home, ".config", "wollipog", "runner.config.json")), "no starter config: service install writes it");
  assert.match(result.stdout, /Control plane:\s+.*wollipog-control-plane/u);
  assert.match(result.stdout, /Next:\s+.*service install/u);
  assert.deepEqual(readdirSync(bin).filter((name) => name.includes(".download.")), [], "no staging files remain");
  assert.deepEqual(readdirSync(join(h.home, ".local", "share", "wollipog")).filter((name) => name.startsWith(".web.")), []);
});

posixTest("install-runner.sh --release installs an exact tag and rejects malformed or unknown tags", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const exact = h.run("--release", releaseTag, "--control-plane");
  assert.equal(exact.status, 0, exact.stderr + exact.stdout);
  assert.equal(readFileSync(join(h.home, ".local", "bin", "wollipog-control-plane"), "utf8"), "control plane bytes\n");
  assert.match(exact.stdout, new RegExp(`from ${releaseTag.replace(/\./g, "\\.")}`));

  const malformed = h.run("--release", "latest");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /--release must look like v1\.2\.3/u);

  // An unknown tag fails the tags endpoint and the fake gh refuses fallback.
  const unknown = h.run("--release", "v9.9.9");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /GitHub release lookup failed for v9\.9\.9/u);
});

posixTest("install-runner.sh --control-plane fails closed on a tampered control plane and on a release without headless assets", (t) => {
  const tampered = harness({ tamperControlPlane: true });
  t.after(() => rmSync(tampered.root, { recursive: true, force: true }));
  const bad = tampered.run("--control-plane");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /wollipog-control-plane-x86_64-unknown-linux-gnu failed SHA-256 verification/u);
  assert.ok(!existsSync(join(tampered.home, ".local", "bin", "wollipog-control-plane")));
  assert.ok(existsSync(join(tampered.home, ".local", "bin", "wollipog-runner")), "the already-verified runner stays installed");

  const old = harness({ omitControlPlane: true });
  t.after(() => rmSync(old.root, { recursive: true, force: true }));
  const missing = old.run("--control-plane");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /has no wollipog-control-plane-x86_64-unknown-linux-gnu; update to a release that publishes headless assets/u);
  assert.ok(!existsSync(join(old.home, ".local", "bin", "wollipog-runner")), "the runner is not installed either: no mixed generations");

  // Without SHA256SUMS the headless assets cannot be cross-checked, so nothing headless is installed.
  const unverifiable = harness({ omitManifest: true });
  t.after(() => rmSync(unverifiable.root, { recursive: true, force: true }));
  const noManifest = unverifiable.run("--control-plane");
  assert.notEqual(noManifest.status, 0);
  assert.match(noManifest.stderr, /has no SHA256SUMS; refusing a headless install/u);
  assert.ok(!existsSync(join(unverifiable.home, ".local", "bin", "wollipog-control-plane")));
  assert.ok(!existsSync(join(unverifiable.home, ".local", "bin", "wollipog-runner")), "refused before the runner was downloaded");

  // --control-plane is a Linux/systemd flow; on macOS it stops before downloading anything.
  const mac = harness({ os: "Darwin" });
  t.after(() => rmSync(mac.root, { recursive: true, force: true }));
  const darwin = mac.run("--control-plane");
  assert.notEqual(darwin.status, 0);
  assert.match(darwin.stderr, /--control-plane needs Linux with systemd/u);
  assert.ok(!existsSync(join(mac.home, ".local", "bin", "wollipog-runner")), "nothing is installed before the platform check");

  const plain = harness();
  t.after(() => rmSync(plain.root, { recursive: true, force: true }));
  const runnerOnly = plain.run();
  assert.equal(runnerOnly.status, 0, runnerOnly.stderr);
  assert.ok(!existsSync(join(plain.home, ".local", "bin", "wollipog-control-plane")), "without --control-plane nothing headless is installed");
  assert.ok(existsSync(join(plain.home, ".config", "wollipog", "runner.config.json")), "the starter config is still written for plain runner installs");
});
