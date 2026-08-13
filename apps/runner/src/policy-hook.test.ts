import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  LEGACY_POLICY_HOOK_SESSION_HEADER,
  POLICY_HOOK_POLL_CAPABILITY,
  POLICY_HOOK_POLL_CAPABILITY_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
} from "@wollipog/protocol";
import {
  POLICY_HOOK_FAILURE_LIMIT,
  runPolicyHook,
  type PolicyHookDeps,
} from "./policy-hook.js";
import {
  LEGACY_POLICY_HOOK_ENV,
  POLICY_HOOK_ENV,
  readHookCircuitState,
  writeHookCircuitState,
} from "./hook-settings.js";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-policy-hook-"));
  const tokenFile = join(root, "active-runner-token");
  const circuitFile = join(root, "session.circuit.json");
  const readyFile = join(root, "session.ready");
  writeFileSync(tokenFile, "mamh_secret_value", "utf8");
  writeFileSync(readyFile, createHash("sha256").update("mamh_secret_value").digest("hex"), "utf8");
  const env = {
    MANAGER_TOKEN_FILE: tokenFile,
    [POLICY_HOOK_ENV.cpUrl]: "http://127.0.0.1:4317",
    [POLICY_HOOK_ENV.sessionId]: "sess_1",
    [POLICY_HOOK_ENV.settingsFile]: join(root, "session.settings.json"),
    [POLICY_HOOK_ENV.circuitFile]: circuitFile,
    [POLICY_HOOK_ENV.readyFile]: readyFile,
    [POLICY_HOOK_ENV.askCapable]: "1",
  };
  const payload = {
    session_id: "provider-uuid",
    transcript_path: "C:\\secret\\transcript.jsonl",
    cwd: "C:\\repo",
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_use_id: "tool-1",
    tool_input: {
      file_path: "C:\\repo\\README.md",
      command: "do not send this raw command",
      ignored_secret: "never-crosses",
    },
  };
  return {
    root,
    env,
    circuitFile,
    readyFile,
    payload,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function response(
  decision: "allow" | "deny" | "ask" | "defer" | "provider_ask",
  extra: Record<string, unknown> = {},
) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ decision, reason: `${decision} reason`, ...extra }),
  };
}

test("PreToolUse round-trips a content-minimized authenticated request and allows", async () => {
  const h = harness();
  try {
    let request: Parameters<PolicyHookDeps["fetch"]> | null = null;
    const env = {
      ...h.env,
      [LEGACY_POLICY_HOOK_ENV.cpUrl]: "http://127.0.0.1:1",
      [LEGACY_POLICY_HOOK_ENV.sessionId]: "wrong-session",
      [LEGACY_POLICY_HOOK_ENV.settingsFile]: join(h.root, "wrong.settings.json"),
      [LEGACY_POLICY_HOOK_ENV.circuitFile]: join(h.root, "wrong.circuit.json"),
      [LEGACY_POLICY_HOOK_ENV.readyFile]: join(h.root, "wrong.ready"),
      [LEGACY_POLICY_HOOK_ENV.askCapable]: "0",
    };
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async (...args) => {
          request = args;
          return response("allow");
        },
        now: (() => {
          let value = 100;
          return () => value += 7;
        })(),
      },
    );
    const output = JSON.parse(result.output);
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(request![0], "http://127.0.0.1:4317/api/sessions/sess_1/policy-hook");
    assert.equal(request![1].headers.authorization, "Bearer mamh_secret_value");
    assert.equal(request![1].headers[WOLLIPOG_POLICY_HOOK_SESSION_HEADER], "sess_1");
    assert.equal(request![1].headers[LEGACY_POLICY_HOOK_SESSION_HEADER], undefined);
    assert.equal(
      request![1].headers[POLICY_HOOK_POLL_CAPABILITY_HEADER],
      POLICY_HOOK_POLL_CAPABILITY,
    );
    assert.equal(request![1].headers[LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER], undefined);
    const body = JSON.parse(request![1].body);
    assert.deepEqual(body, {
      hookEventName: "PreToolUse",
      providerSessionId: "provider-uuid",
      permissionMode: "bypassPermissions",
      toolUseId: "tool-1",
      context: { toolName: "Read", path: "C:\\repo\\README.md" },
    });
    assert.ok(!request![1].body.includes("ignored_secret"));
    assert.ok(!request![1].body.includes("transcript"));
    assert.ok(!result.output.includes("mamh_secret_value"));
    assert.deepEqual(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
  } finally {
    h.cleanup();
  }
});

test("policy hook accepts legacy environment coordinates during the migration window", async () => {
  const h = harness();
  try {
    const legacyEnv = {
      MANAGER_TOKEN_FILE: h.env.MANAGER_TOKEN_FILE,
      [LEGACY_POLICY_HOOK_ENV.cpUrl]: h.env[POLICY_HOOK_ENV.cpUrl],
      [LEGACY_POLICY_HOOK_ENV.sessionId]: h.env[POLICY_HOOK_ENV.sessionId],
      [LEGACY_POLICY_HOOK_ENV.settingsFile]: h.env[POLICY_HOOK_ENV.settingsFile],
      [LEGACY_POLICY_HOOK_ENV.circuitFile]: h.env[POLICY_HOOK_ENV.circuitFile],
      [LEGACY_POLICY_HOOK_ENV.readyFile]: h.env[POLICY_HOOK_ENV.readyFile],
      [LEGACY_POLICY_HOOK_ENV.askCapable]: h.env[POLICY_HOOK_ENV.askCapable],
    };
    let request: Parameters<PolicyHookDeps["fetch"]> | null = null;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      legacyEnv,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async (...args) => {
          request = args;
          return response("allow");
        },
        now: () => 100,
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(request![0], "http://127.0.0.1:4317/api/sessions/sess_1/policy-hook");
    assert.equal(request![1].headers[POLICY_HOOK_POLL_CAPABILITY_HEADER], POLICY_HOOK_POLL_CAPABILITY);
  } finally {
    h.cleanup();
  }
});

test("a missing provider tool id can clean-deny without damaging the transport circuit", async () => {
  const h = harness();
  try {
    let body: Record<string, unknown> | null = null;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify({ ...h.payload, tool_use_id: undefined }),
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return response("deny", {
            reason: "Manager approval requires a stable tool invocation id; blocked fail-closed.",
          });
        },
        now: () => 100,
      },
    );
    assert.equal(body!.toolUseId, undefined);
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
  } finally {
    h.cleanup();
  }
});

test("provider deferral emits no permission decision in default and auto modes", async () => {
  for (const permissionMode of ["default", "auto"]) {
    const h = harness();
    try {
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify({ ...h.payload, permission_mode: permissionMode }),
          fetch: async () => response("defer"),
          now: () => 100,
        },
      );
      assert.deepEqual(JSON.parse(result.output), { suppressOutput: true }, permissionMode);
    } finally {
      h.cleanup();
    }
  }
});

test("a durable ask keeps the same hook invocation polling until its human decision", async () => {
  for (const terminal of ["allow", "deny"] as const) {
    const h = harness();
    try {
      const bodies: Array<Record<string, unknown>> = [];
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return bodies.length === 1
              ? response("ask", { approvalRequestId: "hook_request", retryAfterMs: 50 })
              : response(terminal);
          },
          now: () => 100,
          sleep: async () => {},
        },
      );
      const output = JSON.parse(result.output);
      assert.equal(output.hookSpecificOutput.permissionDecision, terminal);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0]!.approvalRequestId, undefined);
      assert.equal(bodies[1]!.approvalRequestId, "hook_request");
    } finally {
      h.cleanup();
    }
  }
});

test("a mid-poll rollback that drops the durable id clean-denies without circuit damage", async () => {
  const h = harness();
  try {
    let calls = 0;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          calls++;
          return calls === 1
            ? response("ask", { approvalRequestId: "hook_request", retryAfterMs: 50 })
            : response("ask");
        },
        now: () => 100,
        sleep: async () => {},
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(calls, 2);
    assert.deepEqual(readHookCircuitState(h.circuitFile), {
      consecutiveFailures: 0,
      open: false,
      lastDurationMs: 0,
    });
  } finally {
    h.cleanup();
  }
});

test("an accepted durable ask retries transient poll failures without opening the circuit", async () => {
  const h = harness();
  try {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          calls++;
          if (calls === 1) return response("ask", { approvalRequestId: "hook_request", retryAfterMs: 50 });
          if (calls === 2) throw new Error("brief control-plane restart");
          return response("allow");
        },
        now: () => 100,
        sleep: async (ms) => { sleeps.push(ms); },
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [50, 200, 50]);
    assert.deepEqual(readHookCircuitState(h.circuitFile), {
      consecutiveFailures: 0,
      open: false,
      lastDurationMs: 0,
    });
  } finally {
    h.cleanup();
  }
});

test("a live no-timeout ask keeps polling beyond the former five-minute ceiling", async () => {
  const h = harness();
  try {
    let calls = 0;
    let current = 100;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          calls++;
          return calls < 8
            ? response("ask", { approvalRequestId: "hook_request", retryAfterMs: 250 })
            : response("allow");
        },
        now: () => current,
        sleep: async () => { current += 60_001; },
      },
    );
    assert.ok(current > 5 * 60 * 1_000, "the same invocation remained live beyond five minutes");
    assert.equal(calls, 8);
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
  } finally {
    h.cleanup();
  }
});

test("a no-timeout ask still terminates after bounded consecutive control-plane failures", async () => {
  const h = harness();
  try {
    let calls = 0;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          calls++;
          if (calls === 1) {
            return response("ask", { approvalRequestId: "hook_request", retryAfterMs: 50 });
          }
          throw new Error("control plane unavailable");
        },
        now: () => 100,
        sleep: async () => {},
      },
    );
    assert.equal(calls, 6, "one accepted ask plus five bounded poll failures");
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(readHookCircuitState(h.circuitFile), {
      consecutiveFailures: 1,
      open: false,
      lastDurationMs: 0,
    });
  } finally {
    h.cleanup();
  }
});

test("a terminal approval poll rejection fails closed promptly without damaging the circuit", async () => {
  for (const terminal of [
    { ok: false, status: 401, text: async () => JSON.stringify({ error: "session is stopped" }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ error: "no such approval" }) },
  ]) {
    const h = harness();
    try {
      let calls = 0;
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async () => {
            calls++;
            return calls === 1
              ? response("ask", { approvalRequestId: "hook_request", retryAfterMs: 50 })
              : terminal;
          },
          now: () => 100,
          sleep: async () => {},
        },
      );
      assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
      assert.equal(calls, 2);
      assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
    } finally {
      h.cleanup();
    }
  }
});

test("an expired durable ask fails closed without entering an unbounded transient retry loop", async () => {
  const h = harness();
  try {
    let calls = 0;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          calls++;
          if (calls === 1) {
            return response("ask", {
              approvalRequestId: "hook_request",
              retryAfterMs: 50,
              expiresAt: 99,
            });
          }
          throw new Error("control plane unavailable");
        },
        now: () => 100,
        sleep: async () => {},
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(calls, 1);
    assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
  } finally {
    h.cleanup();
  }
});

test("a v65 ask without a durable id clean-denies without polling or circuit damage", async () => {
  for (const marked of [true, false]) {
    const h = harness();
    try {
      if (!marked) delete h.env[POLICY_HOOK_ENV.askCapable];
      let calls = 0;
      let pollCapability: string | undefined;
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async (_url, init) => {
            calls++;
            pollCapability = init.headers[POLICY_HOOK_POLL_CAPABILITY_HEADER];
            return response("ask");
          },
          now: () => 100,
        },
      );
      assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
      assert.equal(calls, 1);
      assert.equal(
        pollCapability,
        marked ? POLICY_HOOK_POLL_CAPABILITY : undefined,
      );
      assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 0);
      assert.equal(readHookCircuitState(h.circuitFile).open, false);
    } finally {
      h.cleanup();
    }
  }
});

test("provider ask and defer preserve the native interactive path without polling", async () => {
  for (const decision of ["provider_ask", "defer"] as const) {
    const h = harness();
    try {
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async () => response(decision),
        },
      );
      const output = JSON.parse(result.output);
      if (decision === "provider_ask") {
        assert.equal(output.hookSpecificOutput.permissionDecision, "ask");
      } else {
        assert.deepEqual(output, { suppressOutput: true });
      }
    } finally {
      h.cleanup();
    }
  }
});

test("PreToolUse fails closed, then an open circuit truly defers to provider behavior", async () => {
  const h = harness();
  try {
    let calls = 0;
    for (let attempt = 1; attempt <= POLICY_HOOK_FAILURE_LIMIT; attempt++) {
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async () => {
            calls++;
            throw new Error("connection refused");
          },
          now: () => 100 + attempt,
        },
      );
      assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    }
    assert.equal(readHookCircuitState(h.circuitFile).open, true);
    const fallback = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => { throw new Error("open circuit must not read stdin"); },
        fetch: async () => { calls++; return response("deny"); },
        now: () => 104,
      },
    );
    assert.deepEqual(JSON.parse(fallback.output), { suppressOutput: true });
    assert.equal(calls, POLICY_HOOK_FAILURE_LIMIT);
  } finally {
    h.cleanup();
  }
});

test("circuit persistence cannot replace an authoritative allow with a deny", async () => {
  const h = harness();
  try {
    writeFileSync(h.circuitFile.replace(".circuit.json", ".circuit.lock"), "active", "utf8");
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => response("allow"),
        now: () => 100,
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(readHookCircuitState(h.circuitFile).open, false);
  } finally {
    h.cleanup();
  }
});

test("parallel transport failures are serialized into one open circuit", async () => {
  const h = harness();
  try {
    const results = await Promise.all(
      Array.from({ length: POLICY_HOOK_FAILURE_LIMIT }, () => runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
        h.env,
        {
          readStdin: async () => JSON.stringify(h.payload),
          fetch: async () => { throw new Error("offline"); },
          now: () => 100,
        },
      )),
    );
    assert.ok(results.every(
      (result) => JSON.parse(result.output).hookSpecificOutput.permissionDecision === "deny",
    ));
    assert.deepEqual(readHookCircuitState(h.circuitFile), {
      consecutiveFailures: POLICY_HOOK_FAILURE_LIMIT,
      open: true,
      lastDurationMs: 0,
      openedAt: 100,
    });
  } finally {
    h.cleanup();
  }
});

test("a stranded circuit lock conservatively opens the breaker after the current closed failure", async () => {
  const h = harness();
  try {
    writeFileSync(h.circuitFile.replace(".circuit.json", ".circuit.lock"), "stranded", "utf8");
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => { throw new Error("offline"); },
        now: () => 100,
      },
    );
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(readHookCircuitState(h.circuitFile).open, true);
  } finally {
    h.cleanup();
  }
});

test("a stale circuit lock is reclaimed so cooldown recovery can succeed", async () => {
  const h = harness();
  try {
    const lock = h.circuitFile.replace(".circuit.json", ".circuit.lock");
    writeFileSync(lock, "stranded", "utf8");
    utimesSync(lock, new Date(0), new Date(0));
    writeHookCircuitState(h.circuitFile, {
      consecutiveFailures: POLICY_HOOK_FAILURE_LIMIT,
      open: true,
      openedAt: 100,
    });
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => response("defer"),
        now: () => 30_101,
      },
    );
    assert.deepEqual(JSON.parse(result.output), { suppressOutput: true });
    assert.equal(readHookCircuitState(h.circuitFile).open, false);
  } finally {
    h.cleanup();
  }
});

test("post-tool and prompt phases fail open while still feeding the circuit", async () => {
  for (const event of ["PostToolUse", "UserPromptSubmit"] as const) {
    const h = harness();
    try {
      const payload = { ...h.payload, hook_event_name: event };
      const result = await runPolicyHook(
        ["runner", "--policy-hook", "--hook-event", event],
        h.env,
        {
          readStdin: async () => JSON.stringify(payload),
          fetch: async () => { throw new Error("offline"); },
          now: () => 100,
        },
      );
      assert.deepEqual(JSON.parse(result.output), { suppressOutput: true });
      assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 1);
    } finally {
      h.cleanup();
    }
  }
});

test("malformed input is fail-closed for PreToolUse and never leaks parse details or credentials", async () => {
  const h = harness();
  try {
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      { readStdin: async () => "{bad-json" },
    );
    const output = JSON.parse(result.output);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(!result.output.includes("mamh_secret_value"));
    assert.equal(result.exitCode, 0, "structured JSON, not an ignored nonzero exit, controls Claude");
  } finally {
    h.cleanup();
  }
});

test("missing credential acknowledgement fails closed on a negotiated transport", async () => {
  const h = harness();
  try {
    rmSync(h.readyFile, { force: true });
    let fetched = false;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          fetched = true;
          return response("allow");
        },
      },
    );
    assert.equal(fetched, false);
    assert.equal(JSON.parse(result.output).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(readHookCircuitState(h.circuitFile).consecutiveFailures, 1);
  } finally {
    h.cleanup();
  }
});

test("an explicit credential rejection opens the circuit and defers the waiting hook", async () => {
  const h = harness();
  try {
    rmSync(h.readyFile, { force: true });
    const rejected = setTimeout(() => {
      writeHookCircuitState(h.circuitFile, {
        consecutiveFailures: POLICY_HOOK_FAILURE_LIMIT,
        open: true,
        openedAt: 100,
        credentialRejected: true,
      });
    }, 20);
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => response("allow"),
        now: () => 100,
      },
    );
    clearTimeout(rejected);
    assert.deepEqual(JSON.parse(result.output), { suppressOutput: true });
    assert.equal(readHookCircuitState(h.circuitFile).open, true);
    const afterCooldown = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => { throw new Error("rejected circuit must not read stdin"); },
        fetch: async () => { throw new Error("rejected circuit must not probe HTTP"); },
        now: () => 30_101,
      },
    );
    assert.deepEqual(JSON.parse(afterCooldown.output), { suppressOutput: true });
    assert.equal(readHookCircuitState(h.circuitFile).credentialRejected, true);
  } finally {
    h.cleanup();
  }
});

test("an expired circuit re-probes and reports its recovery timestamp to the control plane", async () => {
  const h = harness();
  try {
    writeFileSync(
      h.circuitFile,
      JSON.stringify({ consecutiveFailures: 3, open: true, openedAt: 100 }),
      "utf8",
    );
    let body: Record<string, unknown> | null = null;
    const result = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return response("defer");
        },
        now: () => 30_101,
      },
    );
    assert.deepEqual(JSON.parse(result.output), { suppressOutput: true });
    assert.equal(body!.transportRecoveredFrom, 100);
    assert.equal(readHookCircuitState(h.circuitFile).open, false);
  } finally {
    h.cleanup();
  }
});

test("only one concurrent sidecar owns an expired circuit re-probe", async () => {
  const h = harness();
  try {
    writeFileSync(
      h.circuitFile,
      JSON.stringify({ consecutiveFailures: 3, open: true, openedAt: 100 }),
      "utf8",
    );
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deps = {
      readStdin: async () => JSON.stringify(h.payload),
      fetch: async () => {
        calls++;
        await held;
        return response("defer");
      },
      now: () => 30_101,
    };
    const first = runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const second = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      deps,
    );
    assert.deepEqual(JSON.parse(second.output), { suppressOutput: true });
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(readHookCircuitState(h.circuitFile).open, false);
  } finally {
    h.cleanup();
  }
});

test("a recovered durable ask releases its probe before polling so concurrent hooks reach policy", async () => {
  const h = harness();
  try {
    writeHookCircuitState(h.circuitFile, {
      consecutiveFailures: POLICY_HOOK_FAILURE_LIMIT,
      open: true,
      openedAt: 100,
    });
    let firstCalls = 0;
    let polling!: () => void;
    let releasePoll!: () => void;
    const pollingStarted = new Promise<void>((resolve) => { polling = resolve; });
    const pollHeld = new Promise<void>((resolve) => { releasePoll = resolve; });
    const first = runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify(h.payload),
        fetch: async () => {
          firstCalls++;
          return firstCalls === 1
            ? response("ask", { approvalRequestId: "recovered_ask", retryAfterMs: 50 })
            : response("allow");
        },
        now: () => 30_101,
        sleep: async () => {
          polling();
          await pollHeld;
        },
      },
    );
    await pollingStarted;
    assert.deepEqual(readHookCircuitState(h.circuitFile), {
      consecutiveFailures: 0,
      open: false,
      lastDurationMs: 0,
    });

    let concurrentCalls = 0;
    const concurrent = await runPolicyHook(
      ["runner", "--policy-hook", "--hook-event", "PreToolUse"],
      h.env,
      {
        readStdin: async () => JSON.stringify({ ...h.payload, tool_use_id: "tool-2" }),
        fetch: async () => {
          concurrentCalls++;
          return response("defer");
        },
        now: () => 30_101,
      },
    );
    assert.deepEqual(JSON.parse(concurrent.output), { suppressOutput: true });
    assert.equal(concurrentCalls, 1, "concurrent hook must reach the control plane");

    releasePoll();
    assert.equal(JSON.parse((await first).output).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(firstCalls, 2);
  } finally {
    h.cleanup();
  }
});
