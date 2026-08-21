import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import {
  applyClaudeHookCapability,
  claudeHookCircuitPath,
  claudeHookRunnerConfigDir,
  claudeHookReadyPath,
  claudeHookSettingsPath,
  claudeHookTemplatePath,
  claudeHookTokenPath,
  claudeHooksEnabled,
  LEGACY_POLICY_HOOK_ENV,
  markClaudeHookCredentialRejected,
  markClaudeHookCredentialReady,
  prepareClaudeHookArgs,
  provisionClaudeHooks,
  POLICY_HOOK_ENV,
  readHookCircuitState,
  removeClaudeHookFiles,
  sweepClaudeHookFiles,
  writeHookCircuitState,
  type ClaudeHookHost,
} from "./hook-settings.js";

function temp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-hooks-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const host = (configDir: string): ClaudeHookHost => ({
  isSea: false,
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  scriptPath: "/repo/apps/runner/src/index.ts",
  configDir,
});

const capabilities = {
  models: [],
  effortLevels: [],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
  supportsConversationFork: true,
  permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
  elicitation: {
    default: ["stdio-control" as const],
    auto: ["stdio-control" as const],
    acceptEdits: ["none" as const],
    plan: ["none" as const],
    bypassPermissions: ["none" as const],
  },
};

function agent(context: AgentDefinition["context"] = { kind: "native" }): AgentDefinition {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context,
    available: true,
    capabilities,
    claudeCode: {
      status: "ready",
      effortLevels: [],
      permissionModes: capabilities.permissionModes,
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      auth: { status: "authenticated", billingSource: "subscription" },
    },
  };
}

function spec(overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return {
    sessionId: "sess_hook_1",
    workspaceId: null,
    workspacePath: "/repo",
    agentId: "claude-code",
    command: "claude",
    args: [],
    env: {},
    useWorktree: false,
    driver: "claude-code",
    context: { kind: "native" },
    capabilities: applyClaudeHookCapability([agent()], true)[0]!.capabilities,
    config: { permissionMode: "acceptEdits" },
    ...overrides,
  };
}

const config = {
  controlPlaneUrl: "ws://127.0.0.1:4317/runner",
  controlPlaneProtocolVersion: 66,
  enabled: true,
};

test("Claude hook feature flag is exact and default-off", () => {
  assert.equal(claudeHooksEnabled({}), false);
  assert.equal(claudeHooksEnabled({ WOLLIPOG_CLAUDE_HOOKS: "true" }), false);
  assert.equal(claudeHooksEnabled({ WOLLIPOG_CLAUDE_HOOKS: "1" }), true);
});

test("Claude hook feature flag prefers Wollipog and warns only on legacy fallback", () => {
  const warnings: string[] = [];
  assert.equal(
    claudeHooksEnabled(
      { WOLLIPOG_CLAUDE_HOOKS: "0", MAM_CLAUDE_HOOKS: "1" },
      (warning) => warnings.push(warning),
    ),
    false,
  );
  assert.deepEqual(warnings, []);
  assert.equal(
    claudeHooksEnabled({ MAM_CLAUDE_HOOKS: "1" }, (warning) => warnings.push(warning)),
    true,
  );
  assert.deepEqual(warnings, ["MAM_CLAUDE_HOOKS is deprecated; use WOLLIPOG_CLAUDE_HOOKS"]);
});

test("catalog capability truth does not claim session-scoped hook elicitation before provisioning", () => {
  const native = applyClaudeHookCapability([agent()], true)[0]!;
  assert.deepEqual(native.capabilities, capabilities);
  assert.deepEqual(applyClaudeHookCapability([agent()], false)[0]!.capabilities, capabilities);
  assert.deepEqual(applyClaudeHookCapability([agent({ kind: "wsl", distro: "Ubuntu" })], true)[0]!.capabilities, capabilities);
  assert.deepEqual(
    applyClaudeHookCapability([{ ...agent(), id: "conductor" }], true)[0]!.capabilities,
    capabilities,
    "Conductor stays on its existing stdio human gate until Phase 4 can resolve hook asks",
  );
  const stale = agent();
  stale.capabilities = {
    ...capabilities,
    elicitation: { ...capabilities.elicitation, acceptEdits: ["hook"] },
  };
  assert.deepEqual(
    applyClaudeHookCapability([stale], false)[0]!.capabilities!.elicitation!.acceptEdits,
    ["none"],
    "default-off discovery removes stale managed hook claims",
  );
});

test("provisioning writes protected composable settings and reuses generic runner re-entry", () => {
  temp((dir) => {
    const launch = spec({ args: ["--allowedTools", "Read"] });
    const registrations: Array<{ sessionId: string; tokenHash: string }> = [];
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (sessionId, tokenHash) => registrations.push({ sessionId, tokenHash }),
    }, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, launch.sessionId);
    assert.deepEqual(launch.args, ["--allowedTools", "Read", "--settings", file]);
    assert.deepEqual(launch.capabilities!.elicitation, {
      default: ["stdio-control"],
      auto: ["stdio-control"],
      acceptEdits: ["hook"],
      plan: ["hook"],
      bypassPermissions: ["hook"],
    });
    const settings = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(settings.env.MANAGER_TOKEN_FILE, claudeHookTokenPath(file));
    assert.match(readFileSync(settings.env.MANAGER_TOKEN_FILE, "utf8"), /^wollipogh_[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(registrations, [{
      sessionId: launch.sessionId,
      tokenHash: registrations[0]!.tokenHash,
    }]);
    assert.match(registrations[0]!.tokenHash, /^[0-9a-f]{64}$/u);
    markClaudeHookCredentialReady(dir, launch.sessionId, registrations[0]!.tokenHash);
    assert.equal(readFileSync(claudeHookReadyPath(file), "utf8"), registrations[0]!.tokenHash);
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (sessionId, tokenHash) => registrations.push({ sessionId, tokenHash }),
    }, () => {}, host(dir));
    assert.equal(
      readFileSync(claudeHookReadyPath(file), "utf8"),
      registrations[0]!.tokenHash,
      "re-provisioning the same credential preserves its positive acknowledgement",
    );
    assert.equal(settings.env[POLICY_HOOK_ENV.cpUrl], "http://127.0.0.1:4317");
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.cpUrl], "http://127.0.0.1:4317");
    assert.equal(settings.env[POLICY_HOOK_ENV.sessionId], launch.sessionId);
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.sessionId], launch.sessionId);
    assert.equal(settings.env[POLICY_HOOK_ENV.settingsFile], file);
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.settingsFile], file);
    assert.equal(settings.env[POLICY_HOOK_ENV.circuitFile], claudeHookCircuitPath(file));
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.circuitFile], claudeHookCircuitPath(file));
    assert.equal(settings.env[POLICY_HOOK_ENV.readyFile], claudeHookReadyPath(file));
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.readyFile], claudeHookReadyPath(file));
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
      const handler = settings.hooks[event][0].hooks[0];
      assert.equal(handler.command, "/usr/bin/node");
      assert.deepEqual(handler.args.slice(0, 4), ["--import", "tsx", "/repo/apps/runner/src/cli.ts", "--policy-hook"]);
      assert.deepEqual(handler.args.slice(-2), ["--hook-event", event]);
      assert.equal(handler.timeout, event === "PreToolUse" ? 2_000_000 : 3);
    }
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /(?:mamh_|wollipogh_)/u,
      "settings contain a file reference, never a token",
    );
    assert.ok(!readFileSync(file, "utf8").includes("active-runner-token"), "runner-wide credential is not exposed");
    assert.ok(existsSync(claudeHookTemplatePath(file)));
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(claudeHookTemplatePath(file)).mode & 0o777, 0o600);
    }
  });
});

test("policy-hook HTTP transport requires the propagated remote plaintext acknowledgement", () => {
  temp((dir) => {
    const remote = { ...config, controlPlaneUrl: "ws://manager.example.test/runner" };
    assert.throws(
      () => provisionClaudeHooks(spec(), remote, () => {}, host(dir)),
      /--allow-insecure-transport/u,
    );

    const allowed = spec({ sessionId: "sess_hook_insecure_ack" });
    provisionClaudeHooks(
      allowed,
      { ...remote, allowInsecureTransport: true },
      () => {},
      host(dir),
    );
    const settings = JSON.parse(readFileSync(claudeHookSettingsPath(dir, allowed.sessionId), "utf8"));
    assert.equal(settings.env[POLICY_HOOK_ENV.cpUrl], "http://manager.example.test");
    assert.equal(settings.env[LEGACY_POLICY_HOOK_ENV.cpUrl], "http://manager.example.test");
  });
});

test("policy-hook credential migration preserves exact legacy and Wollipog token files", () => {
  for (const token of [`mamh_${"a".repeat(43)}`, `wollipogh_${"b".repeat(43)}`]) {
    temp((dir) => {
      const launch = spec();
      const settingsFile = claudeHookSettingsPath(dir, launch.sessionId);
      const tokenFile = claudeHookTokenPath(settingsFile);
      const readyFile = claudeHookReadyPath(settingsFile);
      const readyHash = createHash("sha256").update(token).digest("hex");
      writeFileSync(tokenFile, token, { mode: 0o600 });
      writeFileSync(readyFile, readyHash, { mode: 0o600 });
      const registrations: string[] = [];

      provisionClaudeHooks(launch, {
        ...config,
        registerCredential: (_sessionId, tokenHash) => registrations.push(tokenHash),
      }, () => {}, host(dir));

      assert.equal(readFileSync(tokenFile, "utf8"), token, "valid credentials are preserved byte-for-byte");
      assert.equal(readFileSync(readyFile, "utf8"), readyHash, "matching readiness survives reuse");
      assert.deepEqual(registrations, [readyHash]);
    });
  }
});

test("malformed policy-hook credential files rotate to Wollipog and clear stale readiness", () => {
  const malformed = [
    `mamh_${"a".repeat(42)}`,
    `mamh_${"a".repeat(44)}`,
    `mamh_${"a".repeat(42)}+`,
    `wollipogh_${"b".repeat(42)}`,
    `wollipogh_${"b".repeat(44)}`,
    `wollipogh_${"b".repeat(42)}/`,
    `wollipog_${"c".repeat(43)}`,
    `mamh_${"d".repeat(43)}\n`,
  ];
  temp((dir) => {
    for (const [index, value] of malformed.entries()) {
      const launch = spec({ sessionId: `sess_malformed_${index}` });
      const settingsFile = claudeHookSettingsPath(dir, launch.sessionId);
      const tokenFile = claudeHookTokenPath(settingsFile);
      const readyFile = claudeHookReadyPath(settingsFile);
      writeFileSync(tokenFile, value, { mode: 0o600 });
      writeFileSync(readyFile, createHash("sha256").update(value).digest("hex"), { mode: 0o600 });
      let registeredHash = "";

      provisionClaudeHooks(launch, {
        ...config,
        registerCredential: (_sessionId, tokenHash) => { registeredHash = tokenHash; },
      }, () => {}, host(dir));

      const replacement = readFileSync(tokenFile, "utf8");
      assert.match(replacement, /^wollipogh_[A-Za-z0-9_-]{43}$/u);
      assert.notEqual(replacement, value);
      assert.equal(registeredHash, createHash("sha256").update(replacement).digest("hex"));
      assert.equal(existsSync(readyFile), false, "a rotated credential must be acknowledged again");
    }
  });
});

test(
  "policy-hook provisioning rejects a credential symlink without reading its target",
  { skip: process.platform === "win32" },
  () => {
    temp((dir) => {
      const launch = spec();
      const settingsFile = claudeHookSettingsPath(dir, launch.sessionId);
      const tokenFile = claudeHookTokenPath(settingsFile);
      const outside = join(dir, "outside-secret");
      const outsideSecret = `mamh_${"s".repeat(43)}`;
      writeFileSync(outside, outsideSecret, { mode: 0o600 });
      symlinkSync(outside, tokenFile);

      assert.throws(
        () => provisionClaudeHooks(launch, config, () => {}, host(dir)),
        /refusing to replace a symlinked Claude hook file/u,
      );

      assert.equal(lstatSync(tokenFile).isSymbolicLink(), true);
      assert.equal(readFileSync(outside, "utf8"), outsideSecret, "the symlink target is never modified");
    });
  },
);

test("provisioning is idempotent, heals exact persisted paths, and preserves user settings", () => {
  temp((dir) => {
    const managedDir = join(dir, "hooks");
    const custom = join(dir, "user.settings.json");
    const launch = spec({ args: ["--settings", custom] });
    provisionClaudeHooks(launch, config, () => {}, host(managedDir));
    const managed = claudeHookSettingsPath(managedDir, launch.sessionId);
    const once = [...launch.args];
    rmSync(managed);
    provisionClaudeHooks(launch, config, () => {}, host(managedDir));
    assert.deepEqual(launch.args, once);
    assert.ok(existsSync(managed), "the exact persisted path is healed");
    assert.equal(launch.args[1], custom, "unrelated user settings are untouched");

    rmSync(managed);
    const prepared = prepareClaudeHookArgs(launch.args);
    assert.equal(prepared.healed, true);
    assert.ok(existsSync(managed), "driver-level one-shot/resume/fork preparation heals deletion");
  });
});

test("a legacy-only persisted hook template remains self-describing and healable after upgrade", () => {
  temp((dir) => {
    const launch = spec();
    provisionClaudeHooks(launch, config, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, launch.sessionId);
    const templateFile = claudeHookTemplatePath(file);
    const legacyTemplate = JSON.parse(readFileSync(templateFile, "utf8")) as {
      env: Record<string, unknown>;
    };
    for (const currentName of Object.values(POLICY_HOOK_ENV)) delete legacyTemplate.env[currentName];
    writeFileSync(templateFile, JSON.stringify(legacyTemplate, null, 2), "utf8");
    rmSync(file);

    const prepared = prepareClaudeHookArgs(["--settings", file]);
    assert.equal(prepared.healed, true);
    assert.equal(prepared.hookAskCapable, true, "the legacy capability coordinate is still recognized");
    const healed = JSON.parse(readFileSync(file, "utf8")) as { env: Record<string, unknown> };
    assert.equal(healed.env[LEGACY_POLICY_HOOK_ENV.settingsFile], file);
    for (const currentName of Object.values(POLICY_HOOK_ENV)) {
      assert.equal(healed.env[currentName], undefined, "healing preserves the exact legacy template");
    }
  });
});

test("fork provisioning strips an inherited source hook before adding the target hook", () => {
  temp((dir) => {
    const source = spec({ sessionId: "sess_source" });
    provisionClaudeHooks(source, config, () => {}, host(dir));
    const target = spec({ sessionId: "sess_target", args: [...source.args] });
    provisionClaudeHooks(target, config, () => {}, host(dir));
    assert.deepEqual(target.args, ["--settings", claudeHookSettingsPath(dir, target.sessionId)]);

    provisionClaudeHooks(target, { ...config, enabled: false }, () => {}, host(dir));
    assert.deepEqual(target.args, [], "feature-off removes every inherited managed pair");
  });
});

test("circuit-open preparation returns truly hook-less args and disabled provisioning strips stale injection", () => {
  temp((dir) => {
    const launch = spec();
    provisionClaudeHooks(launch, config, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, launch.sessionId);
    writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 3, open: true, openedAt: 100 });
    provisionClaudeHooks(launch, config, () => {}, host(dir));
    assert.deepEqual(launch.capabilities!.elicitation!.acceptEdits, ["none"]);
    provisionClaudeHooks(
      launch,
      { ...config, controlPlaneProtocolVersion: 65 },
      () => {},
      host(dir),
    );
    writeHookCircuitState(
      claudeHookCircuitPath(file),
      { consecutiveFailures: 3, open: true, openedAt: 100 },
    );
    assert.equal(
      prepareClaudeHookArgs(launch.args, 30_101).hookAskCapable,
      false,
      "a v66 marker cannot survive a circuit-open downgrade and restore Phase 4 on v65",
    );
    const prepared = prepareClaudeHookArgs(launch.args, 101);
    assert.equal(prepared.circuitOpen, true);
    assert.deepEqual(prepared.args, []);
    provisionClaudeHooks(launch, config, () => {}, host(dir));
    assert.deepEqual(
      launch.args,
      ["--settings", file],
      "the persisted owner path survives cooldown so a later launch can re-probe",
    );

    provisionClaudeHooks(launch, { ...config, enabled: false }, () => {}, host(dir));
    assert.deepEqual(launch.args, [], "feature-off restart removes only the managed pair");
  });
});

test("expired circuits half-open once and arbitrary user settings are never classified as managed", () => {
  temp((dir) => {
    const launch = spec();
    provisionClaudeHooks(launch, config, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, launch.sessionId);
    writeHookCircuitState(claudeHookCircuitPath(file), {
      consecutiveFailures: 3,
      open: true,
      openedAt: 100,
    });
    const prepared = prepareClaudeHookArgs(launch.args, 30_101);
    assert.equal(prepared.circuitReprobePending, true);
    assert.equal(prepared.circuitOpenedAt, 100);
    assert.ok(prepared.args.includes(file));

    const user = join(dir, "user.settings.json");
    writeFileSync(user, JSON.stringify({ hooks: {} }), "utf8");
    writeFileSync(claudeHookTemplatePath(user), JSON.stringify({ hooks: {} }), "utf8");
    writeHookCircuitState(claudeHookCircuitPath(user), {
      consecutiveFailures: 3,
      open: true,
      openedAt: 100,
    });
    assert.deepEqual(prepareClaudeHookArgs(["--settings", user], 101).args, ["--settings", user]);
  });
});

test("default/auto and old control planes preserve provider-native approval transport", () => {
  temp((dir) => {
    for (const permissionMode of ["default", "auto"]) {
      const launch = spec({
        capabilities,
        config: { permissionMode },
      });
      provisionClaudeHooks(launch, config, () => {}, host(dir));
      assert.deepEqual(launch.args, [], permissionMode);
    }
    for (const sessionConfig of [{}, { permissionMode: "" }]) {
      const launch = spec({ config: sessionConfig });
      provisionClaudeHooks(launch, config, () => {}, host(dir));
      assert.deepEqual(
        launch.args,
        ["--settings", claudeHookSettingsPath(dir, launch.sessionId)],
        "unset and cleared modes use the driver's acceptEdits fallback",
      );
      removeClaudeHookFiles(launch.sessionId, dir);
    }
    const v65Transport = spec();
    provisionClaudeHooks(
      v65Transport,
      { ...config, controlPlaneProtocolVersion: 65 },
      () => {},
      host(dir),
    );
    assert.deepEqual(
      v65Transport.args,
      ["--settings", claudeHookSettingsPath(dir, v65Transport.sessionId)],
      "Phase 3b policy transport remains available to a v65 control plane",
    );
    assert.deepEqual(
      v65Transport.capabilities!.elicitation!.acceptEdits,
      ["none"],
      "v65 cannot claim the Phase 4 human-ask transport",
    );
    const oldControlPlane = spec({ sessionId: "old_cp" });
    provisionClaudeHooks(
      oldControlPlane,
      { ...config, controlPlaneProtocolVersion: null },
      () => {},
      host(dir),
    );
    assert.deepEqual(oldControlPlane.args, []);
  });
});

test("explicit credential rejection re-registers and a positive acknowledgement closes it", () => {
  temp((dir) => {
    const launch = spec();
    const registrations: string[] = [];
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (_sessionId, tokenHash) => registrations.push(tokenHash),
    }, () => {}, host(dir));
    markClaudeHookCredentialRejected(dir, launch.sessionId, 100);
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (_sessionId, tokenHash) => registrations.push(tokenHash),
    }, () => {}, host(dir));
    assert.equal(registrations.length, 2, "the rejected binding is retried on the next preparation");
    markClaudeHookCredentialReady(dir, launch.sessionId, registrations[1]!);
    assert.deepEqual(
      readHookCircuitState(claudeHookCircuitPath(claudeHookSettingsPath(dir, launch.sessionId))),
      { consecutiveFailures: 0, open: false },
    );
  });
});

test("fork provisioning strips a managed hook inherited from another runner identity", () => {
  temp((dir) => {
    const sourceDir = join(dir, "runner-one");
    const targetDir = join(dir, "runner-two");
    const source = spec({ sessionId: "source" });
    provisionClaudeHooks(source, config, () => {}, host(sourceDir));
    const target = spec({ sessionId: "target", args: [...source.args] });
    provisionClaudeHooks(target, config, () => {}, host(targetDir));
    assert.deepEqual(target.args, ["--settings", claudeHookSettingsPath(targetDir, "target")]);
  });
});

test("unsupported contexts/capabilities skip injection and invalid ids cannot escape the hook directory", () => {
  temp((dir) => {
    const unsupported = spec({ capabilities, context: { kind: "wsl", distro: "Ubuntu" } });
    const logs: string[] = [];
    provisionClaudeHooks(unsupported, config, (line) => logs.push(line), host(dir));
    assert.deepEqual(unsupported.args, []);
    assert.ok(logs.some((line) => line.includes("not supported")));
    assert.throws(() => provisionClaudeHooks(spec({ sessionId: "../escape" }), config, () => {}, host(dir)), /path characters/);
    assert.throws(() => provisionClaudeHooks(spec({ sessionId: "CON" }), config, () => {}, host(dir)), /path characters/);

    const container = spec({
      executionTarget: {
        id: "container-1",
        runnerId: "runner-1",
        kind: "container",
        adapter: "container",
        workspaceStrategy: "bind",
        boundaries: {
          filesystem: "workspace",
          network: "isolated",
          credentials: "none",
          process: "container",
        },
      },
    });
    provisionClaudeHooks(container, config, (line) => logs.push(line), host(dir));
    assert.deepEqual(container.args, []);
    assert.ok(logs.some((line) => line.includes("container/cloud")));
  });
});

test("startup sweep and session removal delete only managed hook lifecycle files", () => {
  temp((dir) => {
    const launch = spec();
    let tokenHash = "";
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (_sessionId, value) => { tokenHash = value; },
    }, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, launch.sessionId);
    markClaudeHookCredentialReady(dir, launch.sessionId, tokenHash);
    writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 1, open: false });
    writeFileSync(join(dir, "keep.txt"), "keep");
    assert.equal(sweepClaudeHookFiles(dir), 5);
    assert.ok(existsSync(join(dir, "keep.txt")));

    provisionClaudeHooks(launch, config, () => {}, host(dir));
    removeClaudeHookFiles(launch.sessionId, dir);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(claudeHookTemplatePath(file)), false);
    assert.equal(existsSync(claudeHookTokenPath(file)), false);
    assert.equal(existsSync(claudeHookReadyPath(file)), false);
  });
});

test("runner-scoped hook directories prevent one runner startup from sweeping another", () => {
  temp((dir) => {
    const firstDir = claudeHookRunnerConfigDir(dir, "runner-one");
    const secondDir = claudeHookRunnerConfigDir(dir, "runner-two");
    assert.notEqual(firstDir, secondDir);
    const first = spec({ sessionId: "first-session" });
    const second = spec({ sessionId: "second-session" });
    let firstHash = "";
    let secondHash = "";
    provisionClaudeHooks(first, {
      ...config,
      registerCredential: (_sessionId, value) => { firstHash = value; },
    }, () => {}, host(firstDir));
    provisionClaudeHooks(second, {
      ...config,
      registerCredential: (_sessionId, value) => { secondHash = value; },
    }, () => {}, host(secondDir));
    markClaudeHookCredentialReady(firstDir, first.sessionId, firstHash);
    markClaudeHookCredentialReady(secondDir, second.sessionId, secondHash);
    const secondSettings = claudeHookSettingsPath(secondDir, second.sessionId);
    assert.equal(sweepClaudeHookFiles(firstDir), 4);
    assert.equal(existsSync(secondSettings), true);
    assert.equal(existsSync(claudeHookTokenPath(secondSettings)), true);
    assert.equal(existsSync(claudeHookReadyPath(secondSettings)), true);
  });
});
