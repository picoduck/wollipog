import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { playwrightPort } from "../playwright.ports.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const block = { WOLLIPOG_PORT_BLOCK_START: "42380", WOLLIPOG_PORT_BLOCK_END: "42399", WOLLIPOG_PORT_BLOCK_SIZE: "20" };
const noBlock = { WOLLIPOG_PORT_BLOCK_START: "", WOLLIPOG_PORT_BLOCK_END: "", WOLLIPOG_PORT_BLOCK_SIZE: "" };

// Each config reads its port when it is imported, so load it in a fresh process with the given
// environment and report only the fields that carry the port and the reuse policy.
function loadConfig(file, env) {
  const script = `
    const { default: config } = await import(${JSON.stringify(`./${file}`)});
    console.log(JSON.stringify({ baseURL: config.use.baseURL, ...config.webServer }));
  `;
  const childEnv = { ...process.env, ...env };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete childEnv[name];
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root, env: childEnv, encoding: "utf8",
  }));
}

test("without a port block the suites keep 4174 and 4175", () => {
  assert.equal(playwrightPort("development", {}), 4174);
  assert.equal(playwrightPort("production", {}), 4175);
  // The runner exports the block variables empty for a worktree that has no block.
  assert.equal(playwrightPort("development", noBlock), 4174);
  assert.equal(playwrightPort("production", noBlock), 4175);
});

test("a port block gives the two suites distinct ports at its start", () => {
  assert.equal(playwrightPort("development", block), 42380);
  assert.equal(playwrightPort("production", block), 42381);
  assert.equal(playwrightPort("production", { ...block, WOLLIPOG_PORT_BLOCK_END: "42381" }), 42381);
});

test("a malformed or too-small port block fails instead of falling back to a shared port", () => {
  for (const start of ["abc", "4238O", "-1", "80", "65536", " 42380"]) {
    assert.throws(() => playwrightPort("development", { ...block, WOLLIPOG_PORT_BLOCK_START: start }),
      /WOLLIPOG_PORT_BLOCK_START must be a port from 1024 through 65535/u, start);
  }
  assert.throws(() => playwrightPort("development", { WOLLIPOG_PORT_BLOCK_START: "42380" }),
    /WOLLIPOG_PORT_BLOCK_END must be a port/u);
  assert.throws(() => playwrightPort("production", { ...block, WOLLIPOG_PORT_BLOCK_END: "42380" }),
    /port block 42380-42380 has no port for the production Playwright server; it needs at least 2 ports/u);
});

for (const [file, server, page] of [
  ["playwright.config.ts", "development", "remote-instances-e2e.html"],
  ["playwright.production.config.ts", "production", "timeline-reflow-e2e.html"],
]) {
  test(`${file} serves, waits for and browses one strict, never-reused port`, () => {
    for (const env of [{ WOLLIPOG_PORT_BLOCK_START: undefined, WOLLIPOG_PORT_BLOCK_END: undefined }, noBlock, block]) {
      const port = playwrightPort(server, env);
      const config = loadConfig(file, env);
      assert.equal(config.baseURL, `http://127.0.0.1:${port}`);
      assert.equal(config.url, `http://127.0.0.1:${port}/${page}`);
      assert.match(config.command, new RegExp(` --host 127\\.0\\.0\\.1 --port ${port} --strictPort$`, "u"));
      assert.equal(config.command.match(/--port \d+/gu).length, 1);
      assert.equal(config.reuseExistingServer, false);
    }
  });
}
