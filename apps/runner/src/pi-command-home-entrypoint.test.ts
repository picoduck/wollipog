import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { PI_COMMAND_HOME_ENTRYPOINT_SHA256 } from "./pi-command-home-prototype.js";
import { readFileSync } from "node:fs";

const entrypoint = fileURLToPath(new URL("./pi-command-home-entrypoint.mjs", import.meta.url));
const linux = process.platform !== "linux" ? "private entrypoint prototype is native Linux only" : false;

test("entrypoint source matches the required immutable source pin", () => {
  assert.equal(createHash("sha256").update(readFileSync(entrypoint)).digest("hex"), PI_COMMAND_HOME_ENTRYPOINT_SHA256);
});

test("private entrypoint delivers environment only to the inert child, preserves exit and closes handoff stdin", { skip: linux }, () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-private-frame-")));
  try {
    const canary = "SYNTHETIC_PRIVATE_ENV_CANARY_3922";
    const digest = createHash("sha256").update(canary).digest("hex");
    const args = ["--no-addons", "--no-global-search-paths", entrypoint, realpathSync("/bin/sh"), root];
    const loaderEnv = { HOME: root, PATH: "/usr/bin:/bin", LANG: "C" };
    const payload = JSON.stringify({ version: 1, env: { HOME: root, PATH: "/usr/bin:/bin", CANARY: canary,
      NODE_OPTIONS: canary, "BASH_FUNC_inert%%": "synthetic-function-value" },
    command: "test ! -t 0 && test -z \"$(cat)\" && printf '%s' \"$CANARY\" | sha256sum; exit 7" });
    assert.equal(JSON.stringify({ args, loaderEnv }).includes(canary), false);
    const result = spawnSync(process.execPath, args, { input: payload, encoding: "utf8", env: loaderEnv,
      timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
    assert.equal(result.status, 7, result.stderr);
    assert.ok(result.stdout.startsWith(digest));
    assert.equal(result.stderr, "");
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
    const killed = spawnSync(process.execPath, args, { input: JSON.stringify({ version: 1, env: {}, command: "kill -TERM $$" }),
      encoding: "utf8", env: loaderEnv, timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
    assert.equal(killed.status, 143, killed.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private entrypoint refuses truncated, trailing, oversized and invalid frames without echoing payload", { skip: linux }, () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-invalid-frame-")));
  const canary = "SYNTHETIC_REJECTED_PAYLOAD_3922";
  try {
    const valid = { version: 1, command: "exit 0", env: { CANARY: canary } };
    const invalid = [
      JSON.stringify(valid).slice(0, -1), `${JSON.stringify(valid)} trailing-${canary}`,
      JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, extra: canary }),
      JSON.stringify({ ...valid, command: `echo\0${canary}` }),
      JSON.stringify({ ...valid, command: "x".repeat(65_537) }),
      JSON.stringify({ ...valid, env: { "BAD=KEY": canary } }),
      JSON.stringify({ ...valid, env: { BAD: `nul\0${canary}` } }),
      JSON.stringify({ ...valid, env: { BAD: 1 } }),
      JSON.stringify({ ...valid, env: { BAD: "x".repeat(32_769) } }),
      JSON.stringify({ ...valid, env: Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`KEY${n}`, canary])) }),
      "x".repeat(262_145),
    ];
    for (const input of invalid) {
      const result = spawnSync(process.execPath, ["--no-addons", "--no-global-search-paths", entrypoint, realpathSync("/bin/sh"), root],
        { input, encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" }, timeout: 5_000,
          stdio: ["pipe", "pipe", "pipe"] });
      assert.equal(result.status, 125);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Pi command-home prototype entrypoint refused execution.\n");
      assert.equal(result.stderr.includes(canary), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
