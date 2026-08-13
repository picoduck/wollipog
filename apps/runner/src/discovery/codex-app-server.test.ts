import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_APP_SERVER_CONTRACT_FINGERPRINT,
  interpretCodexAppServerProbe,
  unavailableCodexAppServer,
  versionAtLeast,
  nativeCodexAppServerProbeArgs,
  wslCodexAppServerProbeArgs,
} from "./codex-app-server.js";

const compatibleHelp = `
Usage: codex app-server [OPTIONS] [COMMAND]
Commands:
  generate-json-schema
Options:
  --listen <URL> (default: stdio://)
`;

test("versionAtLeast compares semantic versions and rejects malformed values", () => {
  assert.equal(versionAtLeast("0.144.1"), true);
  assert.equal(versionAtLeast("0.145.0"), true);
  assert.equal(versionAtLeast("1.0.0"), true);
  assert.equal(versionAtLeast("0.144.0"), false);
  assert.equal(versionAtLeast("0.144.1-rc1"), false);
  assert.equal(versionAtLeast("dev-build"), false);
});

test("compatible verified Codex reports supported stdio with the pinned fingerprint", () => {
  assert.deepEqual(interpretCodexAppServerProbe("0.144.1", { code: 0, stdout: compatibleHelp, stderr: "" }), {
    status: "supported",
    installedVersion: "0.144.1",
    appServerAvailable: true,
    transport: "stdio",
    verification: "help-and-version",
    contractFingerprint: CODEX_APP_SERVER_CONTRACT_FINGERPRINT,
  });
});

test("older and unknown versions remain explicit exec fallbacks", () => {
  const old = interpretCodexAppServerProbe("0.142.3", { code: 0, stdout: compatibleHelp, stderr: "" });
  assert.equal(old.status, "unsupported");
  assert.equal(old.failure?.code, "version_unverified");
  assert.match(old.failure?.message ?? "", /0\.144\.1/);

  const unknown = interpretCodexAppServerProbe(undefined, { code: 0, stdout: compatibleHelp, stderr: "" });
  assert.equal(unknown.failure?.code, "version_unverified");
});

test("timeout, missing command, and malformed help are distinct safe failures", () => {
  const timeout = interpretCodexAppServerProbe("0.144.1", { code: 1, stdout: "", stderr: "", timedOut: true });
  assert.equal(timeout.failure?.code, "probe_timeout");
  assert.equal(timeout.failure?.retryable, true);

  const spawnFailure = interpretCodexAppServerProbe("0.144.1", { code: 1, stdout: "", stderr: "secret path", errorCode: "ENOENT" });
  assert.equal(spawnFailure.failure?.code, "probe_failed");
  assert.equal(spawnFailure.failure?.retryable, true);
  assert.doesNotMatch(spawnFailure.failure?.message ?? "", /secret path|ENOENT/);

  const missing = interpretCodexAppServerProbe("0.144.1", { code: 1, stdout: "", stderr: "unknown command" });
  assert.equal(missing.failure?.code, "app_server_unavailable");

  const malformed = interpretCodexAppServerProbe("0.144.1", { code: 0, stdout: "usage: something else", stderr: "" });
  assert.equal(malformed.failure?.code, "contract_mismatch");
  assert.match(malformed.failure?.message ?? "", /app-server command.*stdio transport.*schema generator/);
});

test("newer compatible help remains supported but explicitly records non-schema verification", () => {
  const result = interpretCodexAppServerProbe("0.200.0", { code: 0, stdout: compatibleHelp, stderr: "" });
  assert.equal(result.status, "supported");
  assert.equal(result.verification, "help-and-version");
  assert.equal(result.schemaFingerprint, undefined);
  assert.equal(result.contractFingerprint, CODEX_APP_SERVER_CONTRACT_FINGERPRINT);
});

test("Codex absence has its own unavailable diagnostic", () => {
  const unavailable = unavailableCodexAppServer();
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.failure?.code, "codex_unavailable");
});

test("native and WSL probes preserve the resolved node-wrapped launch without shell interpolation", () => {
  const launch = { command: "/home/u/.nvm/node", args: ["/home/u/lib/codex.js"] };
  assert.deepEqual(nativeCodexAppServerProbeArgs(launch), {
    command: "/home/u/.nvm/node",
    args: ["/home/u/lib/codex.js", "app-server", "--help"],
  });
  assert.deepEqual(wslCodexAppServerProbeArgs("Ubuntu Dev", launch), {
    command: "wsl.exe",
    args: ["-d", "Ubuntu Dev", "--exec", "/home/u/.nvm/node", "/home/u/lib/codex.js", "app-server", "--help"],
  });
});
