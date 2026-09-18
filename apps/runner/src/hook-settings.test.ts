import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  CLAUDE_GUARD_LAUNCH_RETRY_COOLDOWN_MS,
  LEGACY_POLICY_HOOK_ENV,
  markClaudeHookCredentialRejected,
  markClaudeHookCredentialReady,
  prepareClaudeHookArgs,
  provisionClaudeHooks,
  POLICY_HOOK_ENV,
  readHookCircuitState,
  refreshClaudeGuardProtections,
  resetClaudeGuardState,
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
      // A sidecar launched as a Claude hook inherits CLAUDE's cwd, so a bare loader specifier is
      // made absolute in the runner's own module graph (see cwdIndependentExecArgv).
      assert.equal(handler.args[0], "--import");
      assert.match(handler.args[1], /[\\/]tsx[\\/].*loader\.mjs$|^tsx$/u);
      assert.deepEqual(handler.args.slice(2, 4), ["/repo/apps/runner/src/cli.ts", "--policy-hook"]);
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

test("Orchestrator never provisions or advertises the disabled policy-hook transport", () => {
  temp((dir) => {
    const launch = spec({
      config: { permissionMode: "orchestrator" },
      capabilities: {
        ...capabilities,
        permissionModes: [...capabilities.permissionModes, "dontAsk", "orchestrator"],
        elicitation: { ...capabilities.elicitation, dontAsk: ["none"] },
      },
    });
    const registrations: string[] = [];
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (_sessionId, tokenHash) => registrations.push(tokenHash),
    }, () => {}, host(dir));
    assert.deepEqual(registrations, []);
    assert.equal(existsSync(claudeHookSettingsPath(dir, launch.sessionId)), false);
    assert.equal(launch.args.includes("--settings"), false);
    assert.deepEqual(launch.capabilities?.elicitation?.dontAsk, ["none"]);
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

test("an Orchestrator with independent provider permissions keeps ordinary hook provisioning", () => {
  temp((dir) => {
    const launch = spec({ config: { permissionMode: "acceptEdits" }, orchestrator: { strictProjectIsolation: false } });
    const registrations: string[] = [];
    provisionClaudeHooks(launch, {
      ...config,
      registerCredential: (_sessionId, tokenHash) => registrations.push(tokenHash),
    }, () => {}, host(dir));
    assert.equal(registrations.length, 1, "hooks are not removed merely because the session is an Orchestrator");
    assert.ok(existsSync(claudeHookSettingsPath(dir, launch.sessionId)));
    assert.ok(launch.args.includes("--settings"));
  });
});

test("an integration-isolated additive Orchestrator keeps Wollipog's managed policy hooks", () => {
  temp((dir) => {
    // The additive role with Integration Isolation: an ordinary provider permission mode whose
    // approvals travel over the `hook` elicitation transport, plus the isolation launch argument.
    const isolated = spec({
      sessionId: "sess_hook_isolated",
      args: ["--strict-mcp-config"],
      config: { permissionMode: "acceptEdits" },
      orchestrator: { strictProjectIsolation: false, integrationIsolation: true },
    });
    provisionClaudeHooks(isolated, config, () => {}, host(dir));
    const file = claudeHookSettingsPath(dir, isolated.sessionId);
    assert.deepEqual(isolated.args, ["--strict-mcp-config", "--settings", file],
      "the managed settings argument is injected alongside the isolation flag, not instead of it");
    const settings = JSON.parse(readFileSync(file, "utf8"));
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
      assert.ok(settings.hooks?.[event]?.[0]?.hooks?.[0]?.command,
        `the ${event} manager policy hook is still provisioned`);
    }
    assert.equal(settings.disableAllHooks, undefined,
      "nothing in the managed settings switches hooks off");
    assert.deepEqual(isolated.capabilities!.elicitation!.acceptEdits, ["hook"],
      "the approval elicitation transport survives Integration Isolation");
    assert.equal(isolated.args.includes("--setting-sources"), false,
      "the user's own settings sources, and so their permission rules and hooks, are left alone");

    // The coupled preset is unchanged: it still removes the manager hooks, because it replaces the
    // whole provider policy with the runner-owned planning surface.
    const preset = spec({ sessionId: "sess_hook_preset", config: { permissionMode: "orchestrator" } });
    provisionClaudeHooks(preset, config, () => {}, host(dir));
    assert.deepEqual(preset.args, [], "the preset keeps no managed settings argument");
  });
});

/* ---------------------------------------------------------------------------------------------
 * Issue #1313: the managed-worktree guard shares ONE settings file with the manager policy hooks,
 * because Claude applies only the LAST `--settings` argument.
 * ------------------------------------------------------------------------------------------ */

const PROTECTIONS = [{ worktreePath: "/repo-worktrees/s1", repoPath: "/repo" }];

function guardedSpec(overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return spec(overrides);
}

/** The real sidecar self-test spawns a process; these tests supply its verdict directly. */
const guardVerifies = () => ({ ok: true }) as { ok: true };

function provisionGuarded(
  dir: string,
  overrides: Partial<SessionLaunchSpec> = {},
  configOverrides: Partial<typeof config> & {
    managedWorktreeProtections?: typeof PROTECTIONS | [];
    verifyGuardLaunch?: () => { ok: true } | { ok: false; reason: string };
  } = {},
): SessionLaunchSpec {
  const launch = guardedSpec(overrides);
  resetClaudeGuardState();
  provisionClaudeHooks(
    launch,
    {
      ...config,
      managedWorktreeProtections: PROTECTIONS,
      verifyGuardLaunch: guardVerifies,
      ...configOverrides,
    },
    () => {},
    host(dir),
  );
  return launch;
}

function settingsOf(dir: string, sessionId = "sess_hook_1"): {
  file: string;
  live: { env?: Record<string, string>; hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; args: string[] }> }>> };
} {
  const file = claudeHookSettingsPath(dir, sessionId);
  return { file, live: JSON.parse(readFileSync(file, "utf8")) };
}

function guardEntries(live: ReturnType<typeof settingsOf>["live"]): Array<{ matcher?: string; hooks: Array<{ command: string; args: string[] }> }> {
  return (live.hooks?.PreToolUse ?? []).filter((entry) =>
    entry.hooks.some((hook) => hook.args.includes("--managed-worktree-guard")));
}

test("the guard is provisioned when manager hooks are DISABLED", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const { file, live } = settingsOf(dir);
  assert.deepEqual(launch.args, ["--settings", file]);
  const guards = guardEntries(live);
  assert.equal(guards.length, 1, "exactly one guard entry");
  assert.deepEqual(guards[0]!.matcher!.split("|").sort(),
    ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write"]);
  assert.ok(guards[0]!.hooks[0]!.args.includes("--protections"));
  assert.equal(live.hooks?.PostToolUse, undefined, "no manager hooks came along");
  assert.equal(live.env?.MANAGER_TOKEN_FILE, undefined, "and no credential reference");
}));

test("the guard is provisioned when the mode's elicitation is unsupported for manager hooks", () => temp((dir) => {
  // `auto` advertises stdio-control, so the manager policy transport is not used for it.
  const launch = provisionGuarded(dir, { config: { permissionMode: "auto" } });
  const { file, live } = settingsOf(dir);
  assert.deepEqual(launch.args, ["--settings", file]);
  assert.equal(guardEntries(live).length, 1);
  assert.equal(live.hooks?.PreToolUse?.length, 1, "the manager PreToolUse hook is absent");
}));

test("the guard is provisioned for the Orchestrator preset, which manager hooks skip entirely", () => temp((dir) => {
  const launch = provisionGuarded(dir, { config: { permissionMode: "orchestrator" } });
  const { file, live } = settingsOf(dir);
  assert.deepEqual(launch.args, ["--settings", file]);
  assert.equal(guardEntries(live).length, 1);
}));

test("the guard and the manager hooks share one settings file when both are on", () => temp((dir) => {
  const launch = provisionGuarded(dir);
  const { file, live } = settingsOf(dir);
  assert.deepEqual(launch.args, ["--settings", file], "one and only one --settings argument");
  assert.equal(guardEntries(live).length, 1);
  assert.equal(live.hooks?.PreToolUse?.length, 2, "guard plus manager PreToolUse");
  assert.ok(live.hooks!.PreToolUse![0]!.matcher?.includes("Bash"), "the guard runs first");
  assert.ok(live.hooks?.PostToolUse, "the manager hooks keep working exactly as before");
  assert.ok(live.hooks?.UserPromptSubmit);
  assert.equal(live.env?.MANAGER_TOKEN_FILE, claudeHookTokenPath(file));
  // The protections path is NOT exported through `env`: that block reaches every tool process,
  // and the provider must not be handed the exact path to the guard's own state. It travels in
  // the hook command inside this 0600 file instead.
  assert.equal(JSON.stringify(live.env).includes("protections.json"), false);
  assert.ok(
    guardEntries(live)[0]!.hooks[0]!.args.includes(file.replace(/\.settings\.json$/u, ".protections.json")),
  );
}));

test("no token material is written into the settings file, only credential-FILE references", () => temp((dir) => {
  provisionGuarded(dir);
  const { file } = settingsOf(dir);
  const token = readFileSync(claudeHookTokenPath(file), "utf8");
  for (const candidate of [file, claudeHookTemplatePath(file), file.replace(/\.settings\.json$/u, ".guard.json")]) {
    assert.equal(readFileSync(candidate, "utf8").includes(token), false, `${candidate} carries no secret`);
  }
}));

test("the protections file is 0600 and carries exactly the live protection set", () => temp((dir) => {
  provisionGuarded(dir);
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  if (process.platform !== "win32") {
    assert.equal(statSync(protections).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: PROTECTIONS });
}));

test("repeated provisioning is idempotent: one --settings pair, one guard entry", () => temp((dir) => {
  const launch = provisionGuarded(dir);
  for (let round = 0; round < 3; round++) {
    provisionClaudeHooks(launch, {
      ...config, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
    }, () => {}, host(dir));
  }
  assert.deepEqual(launch.args, ["--settings", claudeHookSettingsPath(dir, "sess_hook_1")]);
  assert.equal(guardEntries(settingsOf(dir).live).length, 1);
}));

test("healing a deleted settings file restores the guard too", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const { file } = settingsOf(dir);
  rmSync(file, { force: true });
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.healed, true);
  assert.equal(prepared.guardActive, true);
  assert.deepEqual(prepared.args, launch.args);
  assert.equal(guardEntries(settingsOf(dir).live).length, 1);
}));

test("an open manager circuit keeps the guard and drops only the policy transport", () => temp((dir) => {
  const launch = provisionGuarded(dir);
  const file = claudeHookSettingsPath(dir, "sess_hook_1");
  writeHookCircuitState(claudeHookCircuitPath(file), {
    consecutiveFailures: 3, open: true, openedAt: Date.now(),
  });
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.circuitOpen, true);
  assert.equal(prepared.guardActive, true);
  assert.deepEqual(prepared.args, launch.args, "the settings argument is retained for the guard");
  const live = settingsOf(dir).live;
  assert.equal(guardEntries(live).length, 1);
  assert.equal(live.hooks?.PostToolUse, undefined, "the manager hooks are out for this spawn");
  assert.equal(live.env?.MANAGER_TOKEN_FILE, undefined);

  // Re-provisioning while the circuit is open must not resurrect the manager hooks either.
  provisionClaudeHooks(launch, {
    ...config, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  const reprepared = prepareClaudeHookArgs(launch.args);
  assert.equal(reprepared.guardActive, true);
  assert.equal(settingsOf(dir).live.hooks?.PostToolUse, undefined);
}));

test("a recovered circuit restores the manager hooks into the live file", () => temp((dir) => {
  const launch = provisionGuarded(dir);
  const file = claudeHookSettingsPath(dir, "sess_hook_1");
  writeHookCircuitState(claudeHookCircuitPath(file), {
    consecutiveFailures: 3, open: true, openedAt: Date.now(),
  });
  prepareClaudeHookArgs(launch.args);
  assert.equal(settingsOf(dir).live.hooks?.PostToolUse, undefined);
  writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 0, open: false });
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.circuitOpen, false);
  assert.equal(prepared.guardActive, true);
  assert.ok(settingsOf(dir).live.hooks?.PostToolUse, "the template is the authority once eligible again");
}));

test("a session with no managed worktree is guarded from spawn with an empty list (#1303)", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false, managedWorktreeProtections: [] });
  const file = claudeHookSettingsPath(dir, "sess_hook_1");
  assert.deepEqual(launch.args, ["--settings", file], "the guard rides in the runner-owned settings");
  assert.equal(guardEntries(settingsOf(dir).live).length, 1);
  const protections = file.replace(/\.settings\.json$/u, ".protections.json");
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: [] });
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.guardActive, true, "an empty list is a trusted, active guard");
  assert.deepEqual(prepared.args, launch.args);
  // A worktree created mid-turn lands in the live list the running guard reads next.
  assert.deepEqual(refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir), { state: "refreshed" });
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: PROTECTIONS });
  assert.equal(prepareClaudeHookArgs(launch.args).guardActive, true);
}));

test("a launch with its own --settings and no worktree is not guarded, so nothing it sets is shadowed", () => temp((dir) => {
  const logs: string[] = [];
  const launch = spec({ args: ["--settings", "/home/user/claude-settings.json"] });
  resetClaudeGuardState();
  provisionClaudeHooks(launch, {
    ...config, enabled: false, managedWorktreeProtections: [], verifyGuardLaunch: guardVerifies,
  }, (message) => logs.push(message), host(dir));
  assert.deepEqual(launch.args, ["--settings", "/home/user/claude-settings.json"], "the user's settings stay last");
  assert.equal(existsSync(claudeHookSettingsPath(dir, "sess_hook_1")), false);
  assert.ok(logs.some((line) => /would shadow the agent's own --settings/u.test(line)));
  // The same holds for the `--settings=` spelling.
  const inline = spec({ sessionId: "sess_hook_2", args: ["--settings=/home/user/claude-settings.json"] });
  provisionClaudeHooks(inline, {
    ...config, enabled: false, managedWorktreeProtections: [], verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(inline.args, ["--settings=/home/user/claude-settings.json"]);
  // Once the session owns a worktree the guard wins, exactly as before #1303.
  provisionClaudeHooks(launch, {
    ...config, enabled: false, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(launch.args.slice(-2), ["--settings", claudeHookSettingsPath(dir, "sess_hook_1")]);
}));

test("an open manager circuit never lets the empty-list guard shadow the agent's own --settings", () => temp((dir) => {
  // With manager hooks enabled their document already shadows a user --settings while the circuit
  // is closed; that is not new. But while it is OPEN, a spawn of a guard-less session drops the
  // runner-owned document and the user's settings apply — a guard-only copy would take that away.
  const launch = spec({ args: ["--settings", "/home/user/claude-settings.json"] });
  resetClaudeGuardState();
  provisionClaudeHooks(launch, {
    ...config, managedWorktreeProtections: [], verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  const file = claudeHookSettingsPath(dir, "sess_hook_1");
  assert.deepEqual(launch.args.slice(-2), ["--settings", file], "the manager hooks are provisioned as before");
  assert.equal(guardEntries(settingsOf(dir).live).length, 0, "but no guard rides along");
  writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 3, open: true, openedAt: Date.now() });
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.guardActive, false);
  assert.deepEqual(prepared.args, ["--settings", "/home/user/claude-settings.json"],
    "the open circuit leaves the user's settings in effect, exactly as before #1303");
  // A first launch that finds the circuit already open does not append a guard-only file either.
  const second = spec({ sessionId: "sess_hook_2", args: ["--settings", "/home/user/claude-settings.json"] });
  writeHookCircuitState(claudeHookCircuitPath(claudeHookSettingsPath(dir, "sess_hook_2")), {
    consecutiveFailures: 3, open: true, openedAt: Date.now(),
  });
  provisionClaudeHooks(second, {
    ...config, managedWorktreeProtections: [], verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(second.args, ["--settings", "/home/user/claude-settings.json"]);
}));

test("an unguardable launch with no worktree keeps no runner-owned settings", () => temp((dir) => {
  const wsl = provisionGuarded(dir, { context: { kind: "wsl", distro: "Ubuntu" } }, {
    enabled: false, managedWorktreeProtections: [],
  });
  assert.deepEqual(wsl.args, []);
}));

test("refreshClaudeGuardProtections updates an existing guard and never creates one", () => temp((dir) => {
  assert.deepEqual(refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir), { state: "absent" },
    "a session with no provisioned guard is left alone");
  provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  const next = [...PROTECTIONS, { worktreePath: "/repo-worktrees/s2", repoPath: "/repo" }];
  assert.deepEqual(refreshClaudeGuardProtections("sess_hook_1", next, dir), { state: "refreshed" });
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: next });
  assert.deepEqual(refreshClaudeGuardProtections("../escape", next, dir), { state: "absent" },
    "an unsafe id is refused");
}));

test("a refresh whose write fails INVALIDATES the guard instead of trusting the stale list", () => temp((dir) => {
  provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  const next = [...PROTECTIONS, { worktreePath: "/repo-worktrees/s2", repoPath: "/repo" }];
  // A symlink is refused by protectedWrite, which is how a write failure looks here. Point it at
  // a copy of the CURRENT document so the tamper tripwire stays silent and the write itself is
  // what fails — otherwise this test would prove the tripwire rather than the write path.
  const target = join(dir, "elsewhere.json");
  writeFileSync(target, readFileSync(protections, "utf8"), "utf8");
  rmSync(protections, { force: true });
  symlinkSync(target, protections);
  const outcome = refreshClaudeGuardProtections("sess_hook_1", next, dir);
  assert.equal(outcome.state, "invalidated", "the stale list is removed, so the guard fails closed");
  assert.equal(existsSync(protections), false);
  // And the next launch is mediated: the session is marked compromised, so no guard is provisioned.
  const relaunch = spec();
  provisionClaudeHooks(relaunch, {
    ...config, enabled: false, managedWorktreeProtections: next, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(relaunch.args, [], "no guard settings file: the driver mediates the mode");
}));

test("a refresh that cannot even retire the stale list reports the guard as unprotected", () => temp((dir) => {
  if (process.getuid?.() === 0) return; // root ignores the directory mode bits
  provisionGuarded(dir, {}, { enabled: false });
  const next = [...PROTECTIONS, { worktreePath: "/repo-worktrees/s2", repoPath: "/repo" }];
  chmodSync(dir, 0o500);
  try {
    const outcome = refreshClaudeGuardProtections("sess_hook_1", next, dir);
    // Nothing could be written and nothing could be removed, so a running provider would keep
    // trusting the stale list: the caller has to stop it.
    assert.equal(outcome.state, "unprotected");
  } finally {
    chmodSync(dir, 0o700);
  }
}));

test("the last managed worktree going away keeps the running guard with an empty list", () => temp((dir) => {
  // Retiring the list would make the running process block every matched tool for the rest of the
  // turn, and a worktree created next in that turn would find no guard to protect it (#1303).
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  assert.deepEqual(refreshClaudeGuardProtections("sess_hook_1", [], dir), { state: "refreshed" });
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: [] });
  assert.equal(prepareClaudeHookArgs(launch.args).guardActive, true);
  assert.deepEqual(refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir), { state: "refreshed" });
  assert.deepEqual(JSON.parse(readFileSync(protections, "utf8")), { version: 1, protections: PROTECTIONS });
}));

test("a tampered protections file invalidates the guard and mediates the next launch", () => temp((dir) => {
  provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  writeFileSync(protections, JSON.stringify({ version: 1, protections: [] }), "utf8");
  const outcome = refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir);
  assert.equal(outcome.state, "invalidated");
  assert.match((outcome as { reason: string }).reason, /modified outside the runner/u);
  assert.equal(existsSync(protections), false);
  const relaunch = spec();
  provisionClaudeHooks(relaunch, {
    ...config, enabled: false, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(relaunch.args, []);
}));

test("a spawn-time tamper is caught before the runner overwrites the evidence", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  writeFileSync(protections, JSON.stringify({
    version: 1, protections: [{ worktreePath: "/somewhere/else", repoPath: "/repo" }],
  }), "utf8");
  provisionClaudeHooks(launch, {
    ...config, enabled: false, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(launch.args, [], "the tampered session is mediated, not silently re-guarded");
}));

test("a non-native context or a non-host target cannot carry the guard", () => temp((dir) => {
  const wsl = provisionGuarded(dir, { context: { kind: "wsl", distro: "Ubuntu" } });
  assert.deepEqual(wsl.args, []);
  const container = provisionGuarded(dir, {
    sessionId: "sess_hook_3",
    executionTarget: { adapter: "container", id: "c1" },
  } as Partial<SessionLaunchSpec>);
  assert.deepEqual(container.args, []);
}));

test("session cleanup removes the guard and protections files", () => temp((dir) => {
  provisionGuarded(dir, {}, { enabled: false });
  const file = claudeHookSettingsPath(dir, "sess_hook_1");
  removeClaudeHookFiles("sess_hook_1", dir);
  for (const suffix of [".settings.json", ".template.json", ".guard.json", ".protections.json"]) {
    assert.equal(existsSync(file.replace(/\.settings\.json$/u, suffix)), false, `${suffix} is gone`);
  }
}));

test("a driver-internal spawn after an invalidation drops the guard settings and mediates", () => temp((dir) => {
  // The driver spawns again on its own (one-shot turns, resume, persistent restarts) without
  // re-provisioning, so the invalidation has to be honored where the argv is prepared.
  const launch = provisionGuarded(dir, {}, { enabled: false });
  assert.equal(prepareClaudeHookArgs(launch.args).guardActive, true);
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  writeFileSync(protections, JSON.stringify({ version: 1, protections: [] }), "utf8");
  const outcome = refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir);
  assert.equal(outcome.state, "invalidated");
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.guardActive, false);
  assert.deepEqual(prepared.args, [], "a guard hook with no list would block every matched tool");
}));

test("a driver-internal spawn re-runs the tripwire: a foreign but VALID list is not trusted", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  writeFileSync(protections, JSON.stringify({
    version: 1, protections: [{ worktreePath: "/somewhere/else", repoPath: "/repo" }],
  }), "utf8");
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.guardActive, false);
  assert.deepEqual(prepared.args, []);
  // The session is now compromised: restoring the file does not restore trust in this process.
  assert.equal(prepareClaudeHookArgs(launch.args).guardActive, false);
  const relaunch = spec();
  provisionClaudeHooks(relaunch, {
    ...config, enabled: false, managedWorktreeProtections: PROTECTIONS, verifyGuardLaunch: guardVerifies,
  }, () => {}, host(dir));
  assert.deepEqual(relaunch.args, [], "and the next provisioned launch is mediated");
}));

test("a driver-internal spawn whose protection list has vanished is mediated", () => temp((dir) => {
  const launch = provisionGuarded(dir, {}, { enabled: false });
  const protections = claudeHookSettingsPath(dir, "sess_hook_1").replace(/\.settings\.json$/u, ".protections.json");
  rmSync(protections, { force: true });
  assert.equal(prepareClaudeHookArgs(launch.args).guardActive, false);
}));

test("an invalidated guard does not make an open manager-hook circuit look recovered", () => temp((dir) => {
  const launch = provisionGuarded(dir);
  const { file } = settingsOf(dir);
  writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 3, open: true, openedAt: 100 });
  assert.equal(prepareClaudeHookArgs(launch.args, 101).circuitOpen, true);
  writeFileSync(file.replace(/\.settings\.json$/u, ".protections.json"), "{}", "utf8");
  assert.equal(refreshClaudeGuardProtections("sess_hook_1", PROTECTIONS, dir).state, "invalidated");
  const prepared = prepareClaudeHookArgs(launch.args, 102);
  assert.equal(prepared.guardActive, false);
  assert.deepEqual(prepared.args, []);
  assert.equal(prepared.circuitOpen, true, "the persisted circuit is still open");
  assert.equal(prepared.circuitOpenedAt, 100);
}));

test("a failed launch self-test is retried only after a cooldown, a success never", () => temp((dir) => {
  resetClaudeGuardState();
  let probes = 0;
  const failing = () => { probes += 1; return { ok: false as const, reason: "cannot start" }; };
  for (const sessionId of ["sess_hook_1", "sess_hook_2", "sess_hook_3"]) {
    const launch = spec({ sessionId });
    provisionClaudeHooks(launch, {
      ...config, enabled: false, managedWorktreeProtections: [], verifyGuardLaunch: failing,
    }, () => {}, host(dir));
    assert.deepEqual(launch.args, [], "an unproven guard is never relied on");
  }
  assert.equal(probes, 1, "every guardable launch would otherwise pay for a failing process start");
  assert.ok(CLAUDE_GUARD_LAUNCH_RETRY_COOLDOWN_MS > 0);
}));
