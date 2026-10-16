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
  // A bare name passes Claude Code's `<name> --version` probe through PATH.
  assert.equal(shell({ SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "bash" }), "bash");
  assert.equal(shell({ SHELL: "/usr/bin/bash", CLAUDE_CODE_SHELL: "zsh" }), "zsh");
  assert.equal(shell({ SHELL: "zsh" }), "zsh");
  assert.equal(shell({ SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "bash", PATH: "/opt/bin" }), "/usr/bin/zsh",
    "a bare name missing from PATH falls through");
  assert.equal(shell({ SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "./bash" }), "/usr/bin/zsh", "a relative path is not looked up on PATH");
});

test("Claude Code sessions get zsh guidance only when the Bash tool runs zsh", () => {
  assert.ok(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh" } })));
  assert.ok(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/fish", PATH: "/usr/bin" } })));
  assert.equal(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/bash" } })), undefined);
  assert.equal(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "/usr/bin/bash" } })), undefined);
  assert.equal(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/zsh", CLAUDE_CODE_SHELL: "bash", PATH: "/usr/bin" } })), undefined);
  assert.ok(shellGuidance(claude, host({ env: { SHELL: "/usr/bin/bash", CLAUDE_CODE_SHELL: "zsh", PATH: "/usr/bin" } })));
});

test("Codex follows the passwd login shell rather than SHELL", () => {
  for (const driver of codexDrivers) {
    const meta = { driver, env: { SHELL: "/usr/bin/bash" }, context: { kind: "native" as const } };
    const shell = (options: Parameters<typeof host>[0]) => providerCommandShell(meta, host(options));
    assert.equal(shell({ loginShell: "/usr/bin/zsh", env: { SHELL: "/usr/bin/bash", PATH: "/usr/bin" } }), "/usr/bin/zsh", driver);
    assert.ok(shellGuidance(meta, host({ loginShell: "/usr/bin/zsh", env: { SHELL: "/usr/bin/bash" } })), driver);
    assert.equal(shellGuidance({ ...meta, env: { SHELL: "/usr/bin/zsh" } },
      host({ loginShell: "/usr/bin/bash", env: { SHELL: "/usr/bin/zsh" } })), undefined, driver);
    // A recognized but missing login shell type is found on PATH, else the fallback chain runs.
    assert.equal(shell({ loginShell: "/bin/zsh", env: { PATH: "/usr/bin" } }), "/usr/bin/zsh", driver);
    assert.equal(shell({ loginShell: "/bin/sh", env: { PATH: "/usr/bin" }, executables: ["/bin/sh", "/usr/bin/zsh"] }), "/bin/sh", driver);
    assert.equal(shell({ loginShell: "/bin/sh", env: { PATH: "/usr/bin" } }), "/usr/bin/bash", driver);
    // Unrecognized or absent login shells: bash then zsh on Linux, zsh then bash on macOS, then /bin/sh.
    for (const loginShell of ["/usr/bin/fish", "/bin/ash", undefined]) {
      assert.equal(shell({ loginShell }), "/usr/bin/bash", `${driver} ${loginShell}`);
      assert.equal(shell({ loginShell, executables: ["/usr/bin/zsh"] }), "/usr/bin/zsh", `${driver} ${loginShell} without bash`);
      assert.equal(shell({ loginShell, executables: ["/bin/zsh"], env: { PATH: "" } }), "/bin/zsh", `${driver} fixed zsh path`);
      assert.equal(shell({ loginShell, platform: "darwin" }), "/usr/bin/zsh", `${driver} ${loginShell} macOS`);
      assert.equal(shell({ loginShell, platform: "darwin", executables: ["/usr/bin/bash"] }), "/usr/bin/bash", `${driver} macOS without zsh`);
      assert.equal(shell({ loginShell, executables: [] }), "/bin/sh", `${driver} ${loginShell} no shells`);
    }
    assert.ok(shellGuidance(meta, host({ loginShell: "/bin/ash", executables: ["/usr/bin/zsh"] })), `${driver} Linux without bash`);
    assert.ok(shellGuidance(meta, host({ loginShell: "/opt/homebrew/bin/fish", platform: "darwin" })), driver);
    // PowerShell is a supported login shell; it gets no zsh guidance when installed.
    for (const loginShell of ["/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/powershell", "/usr/local/bin/pwsh.exe"]) {
      for (const platform of ["darwin", "linux"] as const) {
        const pwsh = host({ loginShell, platform, env: { PATH: "/usr/local/bin:/bin" }, executables: [loginShell, "/bin/zsh", "/bin/bash"] });
        assert.equal(providerCommandShell(meta, pwsh), loginShell, `${driver} ${platform} ${loginShell}`);
        assert.equal(shellGuidance(meta, pwsh), undefined, `${driver} ${platform} ${loginShell}`);
      }
    }
    assert.equal(shell({ loginShell: "/opt/pwsh", env: { PATH: "/usr/bin" }, executables: ["/usr/bin/pwsh", "/usr/bin/zsh"], platform: "darwin" }),
      "/usr/bin/pwsh", `${driver} PowerShell found on PATH`);
    assert.equal(shell({ loginShell: "/opt/pwsh", platform: "darwin" }), "/usr/bin/zsh", `${driver} missing PowerShell falls back`);
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
