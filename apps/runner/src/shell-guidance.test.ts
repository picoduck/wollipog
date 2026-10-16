import assert from "node:assert/strict";
import { test } from "node:test";
import { providerCommandShell, shellGuidance, type CommandShellHost } from "./shell-guidance.js";
import type { SessionMeta } from "./session-store.js";

function host(options: { executables?: string[]; env?: NodeJS.ProcessEnv; loginShell?: string; platform?: NodeJS.Platform } = {}): CommandShellHost {
  const executables = new Set(options.executables ?? ["/usr/bin/zsh", "/usr/bin/bash"]);
  return {
    platform: options.platform ?? "linux",
    env: options.env ?? { PATH: "/usr/bin" },
    loginShell: () => options.loginShell,
    executable: (path) => executables.has(path),
  };
}

const claude = { driver: "claude-code" as const, env: {}, context: { kind: "native" as const } };
const codexDrivers = ["codex", "codex-app-server"] as const;

test("zsh guidance names the shell and the rules that break bash-style commands", () => {
  const note = shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh" } }))!;
  assert.match(note, /^\[Wollipog Shell Guidance\] Your shell commands run in zsh, not bash\./);
  assert.match(note, /--include='\*\.ts'/); assert.match(note, /no matches found/);
  assert.match(note, /status is a read-only zsh variable/);
  assert.match(note, /does not word-split/); assert.match(note, /set -- \$r/);
  assert.doesNotMatch(note, /[\r\n]/);
});

test("Claude Code follows its override, then SHELL, then prefers zsh over bash", () => {
  const shell = (env: NodeJS.ProcessEnv, executables?: string[], sessionEnv: Record<string, string> = {}) =>
    providerCommandShell({ ...claude, env: sessionEnv }, host({ env: { PATH: "/usr/bin", ...env }, executables }));
  assert.equal(shell({ SHELL: "/usr/bin/zsh" }), "/usr/bin/zsh");
  assert.equal(shell({ SHELL: "/usr/bin/bash" }), "/usr/bin/bash");
  assert.equal(shell({ SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "/usr/bin/bash" }), "/usr/bin/bash");
  assert.equal(shell({ SHELL: "/usr/bin/bash", CLAUDE_CODE_SHELL: "/usr/bin/zsh" }), "/usr/bin/zsh");
  // An unusable override or a login shell Claude Code does not support falls through to detection.
  assert.equal(shell({ SHELL: "/usr/bin/bash", CLAUDE_CODE_SHELL: "/usr/bin/fish" }), "/usr/bin/bash");
  assert.equal(shell({ SHELL: "/usr/bin/fish" }), "/usr/bin/zsh");
  assert.equal(shell({}), "/usr/bin/zsh");
  assert.equal(shell({ SHELL: "/opt/missing/bash" }), "/usr/bin/bash", "a missing bash SHELL still prefers bash");
  assert.equal(shell({ SHELL: "/usr/bin/fish" }, ["/usr/bin/bash"]), "/usr/bin/bash");
  assert.equal(shell({ SHELL: "/usr/bin/fish", PATH: "" }, ["/bin/zsh"]), "/bin/zsh", "standard directories are searched");
  assert.equal(shell({ SHELL: "/usr/bin/fish" }, []), undefined);
  // The session's explicit environment overrides the runner's for the provider process.
  assert.equal(shell({ SHELL: "/usr/bin/zsh" }, undefined, { SHELL: "/usr/bin/bash" }), "/usr/bin/bash");
  assert.equal(shell({ SHELL: "/usr/bin/bash" }, undefined, { CLAUDE_CODE_SHELL: "/usr/bin/zsh" }), "/usr/bin/zsh");
});

test("Claude Code sessions get zsh guidance only when the Bash tool runs zsh", () => {
  assert.ok(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh" } })));
  assert.ok(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/fish", PATH: "/usr/bin" } })));
  assert.equal(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/bash" } })), undefined);
  assert.equal(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "/usr/bin/bash" } })), undefined);
});

test("Codex follows the passwd login shell rather than SHELL", () => {
  for (const driver of codexDrivers) {
    const meta = { driver, env: { SHELL: "/usr/bin/bash" }, context: { kind: "native" as const } };
    assert.ok(shellGuidance(meta, host({ loginShell: "/usr/bin/zsh", env: { SHELL: "/usr/bin/bash" } })), driver);
    assert.equal(shellGuidance({ ...meta, env: { SHELL: "/usr/bin/zsh" } },
      host({ loginShell: "/bin/bash", env: { SHELL: "/usr/bin/zsh" } })), undefined, driver);
    assert.equal(shellGuidance(meta, host({ loginShell: "/bin/sh" })), undefined, driver);
    // Codex falls back from an unrecognized login shell to zsh on macOS and bash elsewhere.
    assert.equal(shellGuidance(meta, host({ loginShell: "/usr/bin/fish" })), undefined, driver);
    assert.equal(shellGuidance(meta, host({ loginShell: undefined })), undefined, driver);
    assert.ok(shellGuidance(meta, host({ loginShell: "/opt/homebrew/bin/fish", platform: "darwin" })), driver);
    assert.ok(shellGuidance(meta, host({ loginShell: "/bin/zsh", platform: "darwin" })), driver);
  }
});

test("no zsh guidance where the runner cannot know the command shell", () => {
  const zshHost = host({ loginShell: "/usr/bin/zsh", env: { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" } });
  for (const driver of ["claude-code", ...codexDrivers] as const) {
    const meta = { driver, env: {}, context: { kind: "native" as const } };
    assert.ok(shellGuidance(meta, zshHost), driver);
    assert.equal(shellGuidance({ ...meta, context: { kind: "wsl", distro: "Ubuntu" } }, zshHost), undefined, driver);
    assert.equal(shellGuidance(meta, { ...zshHost, platform: "win32" }), undefined, driver);
    for (const adapter of ["container", "cloud"]) {
      const executionTarget = { adapter } as unknown as SessionMeta["executionTarget"];
      assert.equal(shellGuidance({ ...meta, executionTarget }, zshHost), undefined, `${driver} ${adapter}`);
    }
    assert.ok(shellGuidance({ ...meta, executionTarget: { adapter: "host" } as unknown as SessionMeta["executionTarget"] }, zshHost));
  }
  for (const driver of ["acp", "pi"] as const) {
    assert.equal(shellGuidance({ driver, env: {}, context: { kind: "native" } }, zshHost), undefined, driver);
  }
});
