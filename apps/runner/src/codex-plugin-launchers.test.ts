import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { inheritCodexPlugins } from "./codex-plugins.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".codex");
  const account = join(root, "account");
  mkdirSync(source);
  mkdirSync(account);
  mkdirSync(join(source, "plugins/cache/local/review"), { recursive: true });
  writeFileSync(join(source, "config.toml"), '[plugins."review@local"]\nenabled = true\n');
  const launch = { command: "codex", args: [] as string[], context: { kind: "native" as const },
    env: { HOME: root, CODEX_HOME: account } };
  return { root, source, account, launch };
}

const inherited = ["-c", "plugins.review@local.enabled=true"];
const explicit = ["-c", "plugins.review@local.enabled=false", "app-server"];

test("supported launcher prefixes precede inherited flags and explicit Codex overrides", (t) => {
  const f = fixture(t);
  const cases: [string, string[]][] = [
    ["codex", []], ["/opt/bin/codex", []], ["C:\\tools\\codex.exe", []],
    ["node", ["codex.js"]], [process.execPath, ["--no-warnings", "--enable-source-maps", "--", "codex.js"]],
    ["npx", ["-y", "@openai/codex"]], ["npx.cmd", ["--offline", "--", "@openai/codex@0.159.2"]],
    ["npx", ["-p", "@openai/codex@latest", "codex"]],
    ["npm", ["exec", "--yes", "--", "@openai/codex@next"]],
    ["npm", ["x", "--package=@openai/codex@0.159.2", "--", "codex"]],
    ["pnpm", ["dlx", "--silent", "@openai/codex"]],
    ["pnpm", ["dlx", "--package", "@openai/codex@latest", "codex"]],
    ["pnpx", ["@openai/codex"]], ["/opt/bin/pnpx", ["--silent", "@openai/codex@0.159.2"]],
    ["pnpx", ["--package=@openai/codex", "codex"]],
    ["bun", ["x", "--bun", "@openai/codex@latest"]],
    ["bunx", ["@openai/codex"]], ["bunx.exe", ["--no-install", "--silent", "@openai/codex@0.159.2"]],
    ["bunx", ["-p", "@openai/codex@next", "codex"]],
    ["yarn", ["dlx", "@openai/codex"]], ["yarn.cmd", ["dlx", "-q", "@openai/codex@latest"]],
    ["yarn", ["dlx", "--quiet", "--package", "@openai/codex@0.159.2", "codex"]],
    ["env", ["codex"]], ["/usr/bin/env", ["--", "/opt/bin/codex"]],
    ["env", ["-u", "UNUSED_FIXTURE", "--unset", "OTHER_FIXTURE", "codex"]],
    ["env", ["node", "--no-warnings", "codex.js"]],
    ["env", ["bunx", "--bun", "@openai/codex@latest"]],
  ];
  for (const [command, prefix] of cases) {
    const args = [...prefix, ...explicit];
    assert.deepEqual(inheritCodexPlugins({ ...f.launch, command, args }),
      [...prefix, ...inherited, ...explicit], `${command}: ${prefix.join(" ")}`);
    assert.deepEqual(args, [...prefix, ...explicit], "input argv must remain unchanged");
  }
});

test("ambiguous wrappers fail before cache mutation with a fixed sanitized diagnostic", (t) => {
  const f = fixture(t);
  const cases: [string, string[]][] = [
    ["/private-path/SECRET-wrapper", ["TOKEN=SECRET", "@openai/codex"]],
    ["sh", ["-c", "@openai/codex $(SECRET)"]],
    ["npx", ["--call", "@openai/codex"]], ["npm", ["exec", "@openai/codex"]],
    ["npm", ["install", "@openai/codex"]], ["pnpm", ["exec", "@openai/codex"]],
    ["bun", ["run", "@openai/codex"]], ["yarn", ["run", "@openai/codex"]],
    ["pnpx", ["--shell-mode", "@openai/codex"]], ["bunx", ["--unknown", "@openai/codex"]],
    ["npx", ["other-command", "@openai/codex"]],
    ["yarn", ["dlx", "-p", "@openai/codex", "other-command"]],
    ["bunx", ["--package=other-package", "codex", "@openai/codex"]],
    ["pnpx", ["--package"]], ["bunx", ["@openai/codex@"]],
    ["node", ["-e", "SECRET"]], ["node", ["--no-warnings"]],
    ["env", ["-i", "codex"]], ["env", ["CODEX_HOME=SECRET", "codex"]],
    ["env", ["HOME=SECRET", "codex"]], ["env", ["-u", "CODEX_HOME", "codex"]],
    ["env", ["--unset", "HOME", "codex"]], ["env", ["-u", "USERPROFILE", "codex"]],
    ["env", ["-u"]], ["env", ["env", "codex"]], ["env", ["unknown-wrapper", "codex"]],
  ];
  for (const [command, args] of cases) {
    assert.throws(() => inheritCodexPlugins({ ...f.launch, command, args }), {
      message: "Codex plugin inheritance does not support this launcher form. " +
        "Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
    });
    assert.equal(existsSync(join(f.account, "plugins")), false);
  }
});

test("unsupported forms pass through when no flags need inheritance or execution is remote", (t) => {
  const f = fixture(t);
  const args = ["SECRET", "@openai/codex"];
  const unknown = { ...f.launch, command: "custom-wrapper", args };
  for (const launch of [
    { ...unknown, context: { kind: "wsl" as const, distro: "fixture" } },
    { ...unknown, isolation: { backend: "container" } as never },
    { ...unknown, isolation: { backend: "cloud" } as never },
    { ...unknown, executionTarget: { adapter: "remote" } },
    { ...unknown, env: { HOME: f.root, CODEX_HOME: f.source } },
  ]) assert.equal(inheritCodexPlugins(launch), args);
  assert.equal(existsSync(join(f.account, "plugins")), false);
  writeFileSync(join(f.source, "config.toml"), "");
  assert.deepEqual(inheritCodexPlugins(unknown), args);
});

test("actual Node, env, npx, and npm exec forward flags to an inert local Codex fixture", {
  skip: process.platform === "win32",
}, (t) => {
  const f = fixture(t);
  const packageRoot = join(f.root, "node_modules/@openai/codex");
  const bin = join(f.root, "node_modules/.bin");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(f.root, "package.json"), JSON.stringify({
    private: true, dependencies: { "@openai/codex": "0.0.0-fixture" },
  }));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "0.0.0-fixture", bin: { codex: "codex.cjs" },
  }));
  const entry = join(packageRoot, "codex.cjs");
  writeFileSync(entry, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(entry, 0o700);
  symlinkSync(entry, join(bin, "codex"));
  // No inherited process environment, auth files, registry downloads, or provider/model calls.
  const env = { ...f.launch.env, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    npm_config_offline: "true", npm_config_ignore_scripts: "true",
    npm_config_cache: join(f.root, "npm-cache"), npm_config_userconfig: join(f.root, ".npmrc"),
    npm_config_globalconfig: join(f.root, "global-npmrc") };
  const cases: [string, string[]][] = [
    [process.execPath, ["--no-warnings", entry]], ["/usr/bin/env", ["-u", "UNUSED_FIXTURE", "codex"]],
    ["npx", ["--offline", "--no-install", "@openai/codex@0.0.0-fixture"]],
    ["npm", ["exec", "--offline", "--", "@openai/codex@0.0.0-fixture"]],
    ["npm", ["exec", "--offline", "--package=@openai/codex@0.0.0-fixture", "--", "codex"]],
  ];
  // Optional local Bun integration uses the same inert package, with installation disabled.
  if (process.env.WOLLIPOG_TEST_BUNX_BINARY) {
    cases.push([process.env.WOLLIPOG_TEST_BUNX_BINARY, ["--no-install", "@openai/codex"]]);
  }
  for (const [command, prefix] of cases) {
    const args = inheritCodexPlugins({ ...f.launch, command, args: [...prefix, ...explicit] });
    const output = execFileSync(command, args, { cwd: f.root, env, encoding: "utf8", timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(output), [...inherited, ...explicit], command);
  }
  assert.equal(existsSync(join(f.account, "auth.json")), false);
  assert.equal(existsSync(join(f.source, "auth.json")), false);
});
