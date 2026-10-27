import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind } from "@wollipog/protocol";
import { providerConversationHome } from "./provider-conversation-home.js";

test("native transcript homes honor the exact provider override, HOME, and inherited defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-conversation-home-"));
  try {
    for (const driver of ["claude-code", "codex", "codex-app-server"] as AgentDriverKind[]) {
      const variable = driver === "claude-code" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const leaf = driver === "claude-code" ? ".claude" : ".codex";
      const meta = { driver, context: { kind: "native" as const }, env: { HOME: root } };
      const deps = { nativeEnv: {}, nativeHome: () => root };
      assert.equal(await providerConversationHome(meta, deps), join(root, leaf));
      assert.equal(await providerConversationHome({ ...meta, env: {} }, deps), join(root, leaf));
      assert.equal(await providerConversationHome(meta, { ...deps, nativeEnv: { [variable]: join(root, "inherited") } }), join(root, "inherited"));
      assert.equal(await providerConversationHome({ ...meta, env: { [variable]: join(root, "configured") } }, deps), join(root, "configured"));
      await assert.rejects(providerConversationHome({ ...meta, env: { [variable]: "relative" } }, deps));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WSL default homes are resolved in the session distribution with its exact launch environment", async () => {
  for (const driver of ["claude-code", "codex-app-server"] as AgentDriverKind[]) {
    const context = { kind: "wsl" as const, distro: "Test Distribution" };
    const env = { HOME: "/throwaway/home" };
    let called = false;
    assert.equal(await providerConversationHome({ driver, context, env }, {
      nativeEnv: { HOME: "C:\\never-use-the-host" },
      run: async (actualContext, command, args, options) => {
        called = true;
        assert.deepEqual(actualContext, context);
        assert.equal(command, "sh");
        assert.match(args[1]!, driver === "claude-code" ? /CLAUDE_CONFIG_DIR/ : /CODEX_HOME/);
        assert.deepEqual(options.env, env);
        assert.equal(options.cwd, "/");
        return { stdout: "/throwaway/home/provider", stderr: "" };
      },
    }), "/throwaway/home/provider");
    assert.equal(called, true);
    await assert.rejects(providerConversationHome({ driver, context, env }, {
      run: async () => ({ stdout: "relative", stderr: "" }),
    }));
  }
});
