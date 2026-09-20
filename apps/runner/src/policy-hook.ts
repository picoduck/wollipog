/**
 * Claude hook sidecar. Reads one bounded event from stdin, performs one authenticated local
 * control-plane round trip, and emits only Claude's structured hook response on stdout.
 *
 * Where the runner relays (#1472: `provider` mode on a native Linux host) the sidecar holds no
 * credential and no circuit. It hands the event to the runner's socket, and the runner runs the
 * very same evaluation against state it keeps in memory.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  POLICY_HOOK_POLL_CAPABILITY,
  POLICY_HOOK_POLL_CAPABILITY_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
  type ClaudeHookEventName,
  type PolicyHookEvaluationRequest,
  type PolicyHookEvaluationResponse,
} from "@wollipog/protocol";
import { approvalScopeContext } from "./approval-scope.js";
import { readCompatibleEnv } from "./env-compat.js";
import {
  LEGACY_POLICY_HOOK_ENV,
  POLICY_HOOK_ENV,
  claimExpiredHookCircuitProbe,
  fileHookCircuitStore,
  managerHookRelayState,
  type HookCircuitState,
  type HookCircuitStore,
} from "./hook-settings.js";
import {
  POLICY_HOOK_RELAY_FLAG,
  POLICY_HOOK_RELAY_KEY_ENV,
  policyHookRelaySocketArgument,
  requestPolicyHookRelay,
  type PolicyHookRelayRequest,
} from "./policy-hook-relay.js";

const MAX_HOOK_INPUT_BYTES = 128 * 1024;
const CP_TIMEOUT_MS = 1_500;
const CREDENTIAL_READY_TIMEOUT_MS = 500;
const POLICY_HOOK_MAX_CONSECUTIVE_POLL_FAILURES = 5;
export const POLICY_HOOK_FAILURE_LIMIT = 3;

type Json = Record<string, unknown>;

export interface PolicyHookFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface PolicyHookDeps {
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    },
  ) => Promise<PolicyHookFetchResponse>;
  readStdin: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The caller is gone (a relayed sidecar that Claude killed): stop waiting on its behalf. */
  signal: AbortSignal;
}

/**
 * Where one evaluation finds its circuit, its coordinates, and its credential: the sidecar's files,
 * or the runner's memory when the runner relays.
 */
export interface PolicyHookTransport {
  circuit: HookCircuitStore;
  /** Throws when the transport is not fully configured or holds no credential. */
  coordinates(): { cpUrl: string; sessionId: string; token: string; askCapable: boolean };
  /** The control plane has acknowledged the credential `coordinates()` returned. */
  credentialReady(): boolean;
}

export interface PolicyHookRunResult {
  exitCode: 0;
  output: string;
}

class PolicyHookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`control plane returned HTTP ${status}`);
  }
}

function isMissingApprovalMessage(value: string): boolean {
  return /no such approval|approval (?:is )?missing|does not match|session not found/i.test(value);
}

function isTerminalPollError(error: unknown): boolean {
  if (!(error instanceof PolicyHookHttpError)) return false;
  return [401, 403, 404, 409].includes(error.status) ||
    isMissingApprovalMessage(error.responseBody);
}

function boundedString(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
    ? value
    : undefined;
}

function hookRequest(payload: Json, expectedEvent: ClaudeHookEventName): PolicyHookEvaluationRequest {
  if (payload.hook_event_name !== expectedEvent) {
    throw new Error("hook input event does not match the configured event");
  }
  const providerSessionId = boundedString(payload.session_id, 256);
  if (!providerSessionId) throw new Error("hook input has no bounded session_id");
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
    ? payload.tool_input as Json
    : {};
  const selectors = approvalScopeContext(toolInput);
  const context = {
    ...(boundedString(payload.tool_name, 256) ? { toolName: boundedString(payload.tool_name, 256)! } : {}),
    ...selectors,
  };
  return {
    hookEventName: expectedEvent,
    providerSessionId,
    ...(boundedString(payload.permission_mode, 64) ? { permissionMode: boundedString(payload.permission_mode, 64)! } : {}),
    ...(boundedString(payload.tool_use_id, 512) ? { toolUseId: boundedString(payload.tool_use_id, 512)! } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
}

function preToolOutput(decision: "allow" | "deny" | "ask", reason: string): string {
  return JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason.slice(0, 512),
    },
  });
}

function nonBlockingOutput(): string {
  return JSON.stringify({ suppressOutput: true });
}

function failureOutput(event: ClaudeHookEventName): string {
  return event === "PreToolUse"
    ? preToolOutput("deny", "Manager policy transport is unavailable.")
    : nonBlockingOutput();
}

function parseExpectedEvent(argv: string[]): ClaudeHookEventName | null {
  const index = argv.indexOf("--hook-event");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === "PreToolUse" || value === "PostToolUse" || value === "UserPromptSubmit" ? value : null;
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not configured`);
  return value;
}

type PolicyHookEnvironmentKey = keyof typeof POLICY_HOOK_ENV;

function readPolicyHookEnv(env: NodeJS.ProcessEnv, key: PolicyHookEnvironmentKey): string | undefined {
  return readCompatibleEnv(env, POLICY_HOOK_ENV[key], LEGACY_POLICY_HOOK_ENV[key]);
}

function readRequiredPolicyHookEnv(env: NodeJS.ProcessEnv, key: PolicyHookEnvironmentKey): string {
  const value = readPolicyHookEnv(env, key);
  if (!value) throw new Error(`${POLICY_HOOK_ENV[key]} is not configured`);
  return value;
}

async function waitForCredentialReady(
  transport: PolicyHookTransport,
): Promise<"ready" | "rejected" | "timeout"> {
  const deadline = Date.now() + CREDENTIAL_READY_TIMEOUT_MS;
  for (;;) {
    // The runner records the acknowledgement after the CP commits the session-bound hash.
    if (transport.credentialReady()) return "ready";
    if (transport.circuit.read().open) return "rejected";
    if (Date.now() >= deadline) return "timeout";
    await delay(10);
  }
}

/** The file form: every coordinate comes from the settings `env` block, every state from a file. */
function filePolicyHookTransport(env: NodeJS.ProcessEnv): PolicyHookTransport {
  const circuitFile = readRequiredPolicyHookEnv(env, "circuitFile");
  let readyFile = "";
  let expected = "";
  return {
    circuit: fileHookCircuitStore(circuitFile),
    coordinates: () => {
      const cpUrl = readRequiredPolicyHookEnv(env, "cpUrl");
      const sessionId = readRequiredPolicyHookEnv(env, "sessionId");
      const tokenFile = readRequiredEnv(env, "MANAGER_TOKEN_FILE");
      const token = readFileSync(tokenFile, "utf8").trim();
      if (!token) throw new Error("policy-hook credential file is empty");
      readyFile = readRequiredPolicyHookEnv(env, "readyFile");
      expected = createHash("sha256").update(token).digest("hex");
      return { cpUrl, sessionId, token, askCapable: readPolicyHookEnv(env, "askCapable") === "1" };
    },
    credentialReady: () => {
      try {
        return readFileSync(readyFile, "utf8").trim() === expected;
      } catch {
        return false;
      }
    },
  };
}

function updateCircuit(
  circuit: HookCircuitStore,
  success: boolean,
  durationMs: number,
  now: number,
): HookCircuitState {
  return circuit.update((prior) => {
    const consecutiveFailures = success ? 0 : prior.consecutiveFailures + 1;
    const open = prior.open || (!success &&
      (prior.probeStartedAt != null || consecutiveFailures >= POLICY_HOOK_FAILURE_LIMIT));
    return {
      consecutiveFailures,
      open,
      lastDurationMs: Math.max(0, Math.round(durationMs)),
      ...(open ? { openedAt: prior.probeStartedAt != null ? now : prior.openedAt ?? now } : {}),
    };
  });
}

async function defaultReadStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, "utf8") > MAX_HOOK_INPUT_BYTES) {
      throw new Error("hook input exceeds 128 KiB");
    }
  }
  return input;
}

export async function runPolicyHook(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: Partial<PolicyHookDeps> = {},
): Promise<PolicyHookRunResult> {
  const event = parseExpectedEvent(argv);
  if (!event) return { exitCode: 0, output: preToolOutput("deny", "Manager policy hook event is invalid.") };
  if (argv.includes(POLICY_HOOK_RELAY_FLAG)) return relayPolicyHook(argv, env, event, deps);
  return evaluatePolicyHook(event, () => filePolicyHookTransport(env), deps);
}

/**
 * The relayed sidecar (#1472). The flag is a commitment, exactly as the guard's socket flag is: no
 * credential, acknowledgement, or circuit file is read, whatever the environment names and whatever
 * has been planted at those paths. Without an answer from the runner the event gets its fail-closed
 * response, and nothing is recorded anywhere: the circuit is the runner's to move.
 */
async function relayPolicyHook(
  argv: string[],
  env: NodeJS.ProcessEnv,
  event: ClaudeHookEventName,
  deps: Partial<PolicyHookDeps>,
): Promise<PolicyHookRunResult> {
  try {
    const socket = policyHookRelaySocketArgument(argv);
    const key = env[POLICY_HOOK_RELAY_KEY_ENV];
    if (!socket || !key) throw new Error("the policy relay is not configured for this launch");
    const input = await (deps.readStdin ?? defaultReadStdin)();
    return { exitCode: 0, output: await requestPolicyHookRelay(socket, { key, event, input }) };
  } catch {
    return { exitCode: 0, output: failureOutput(event) };
  }
}

/**
 * The runner's side of the relay: one hook event from a sidecar that presented this session's key,
 * evaluated against the state the runner holds for that session. A caller without the key gets the
 * fail-closed response and reaches neither the control plane nor the circuit.
 */
export async function servePolicyHookRelay(
  sessionId: string,
  request: PolicyHookRelayRequest,
  signal: AbortSignal,
  deps: Partial<PolicyHookDeps> = {},
): Promise<string> {
  const state = managerHookRelayState(sessionId, request.key);
  if (!state) return failureOutput(request.event);
  const result = await evaluatePolicyHook(request.event, () => ({
    circuit: state.circuit,
    coordinates: () => ({
      cpUrl: state.cpHttpUrl,
      sessionId: state.sessionId,
      token: state.token,
      askCapable: state.askCapable,
    }),
    credentialReady: state.credentialReady,
  }), { ...deps, readStdin: async () => request.input, signal });
  return result.output;
}

async function evaluatePolicyHook(
  event: ClaudeHookEventName,
  openTransport: () => PolicyHookTransport,
  deps: Partial<PolicyHookDeps>,
): Promise<PolicyHookRunResult> {
  let transport: PolicyHookTransport | null = null;
  let circuit: HookCircuitState = { consecutiveFailures: 0, open: false };
  let recoveredFrom: number | undefined;
  try {
    transport = openTransport();
    const circuitStore = transport.circuit;
    const recovered = claimExpiredHookCircuitProbe(circuitStore, (deps.now ?? Date.now)());
    circuit = recovered.state;
    recoveredFrom = recovered.recoveredFrom;
    if (circuit.open || recovered.probeInProgress) {
      return { exitCode: 0, output: nonBlockingOutput() };
    }

    const coordinates = transport.coordinates();
    const cpUrl = coordinates.cpUrl.replace(/\/+$/, "");
    const managerSessionId = coordinates.sessionId;
    const { token, askCapable } = coordinates;
    const credentialState = await waitForCredentialReady(transport);
    if (credentialState === "rejected") {
      return { exitCode: 0, output: nonBlockingOutput() };
    }
    if (credentialState === "timeout") {
      throw new Error("policy-hook credential registration was not acknowledged");
    }
    const input = await (deps.readStdin ?? defaultReadStdin)();
    const payload = JSON.parse(input) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("hook input must be an object");
    const request = {
      ...hookRequest(payload as Json, event),
      ...(recoveredFrom != null ? { transportRecoveredFrom: recoveredFrom } : {}),
    };
    const fetchImpl = deps.fetch ?? (fetch as unknown as PolicyHookDeps["fetch"]);
    const now = deps.now ?? Date.now;
    const started = now();
    const endpoint = `${cpUrl}/api/sessions/${encodeURIComponent(managerSessionId)}/policy-hook`;
    const evaluate = async (body: PolicyHookEvaluationRequest): Promise<PolicyHookEvaluationResponse> => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [WOLLIPOG_POLICY_HOOK_SESSION_HEADER]: managerSessionId,
          ...(askCapable
            ? { [POLICY_HOOK_POLL_CAPABILITY_HEADER]: POLICY_HOOK_POLL_CAPABILITY }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CP_TIMEOUT_MS),
      });
      const raw = await response.text();
      if (!response.ok) throw new PolicyHookHttpError(response.status, raw.slice(0, 1_024));
      const value = JSON.parse(raw) as Partial<PolicyHookEvaluationResponse> & { error?: unknown };
      if (typeof value.error === "string" && isMissingApprovalMessage(value.error)) {
        throw new PolicyHookHttpError(409, value.error);
      }
      if (!["allow", "deny", "ask", "defer", "provider_ask"].includes(String(value.decision))) {
        throw new Error("control plane returned an invalid policy decision");
      }
      return value as PolicyHookEvaluationResponse;
    };
    let decision = await evaluate(request);
    // A successful first response proves the control-plane transport has recovered. Release the
    // half-open probe before a durable human ask starts polling so concurrent hook invocations can
    // reach the control plane and join its per-session turn barrier instead of bypassing policy.
    try {
      updateCircuit(circuitStore, true, now() - started, now());
    } catch {
      /* The terminal response path retries optional telemetry persistence below. */
    }
    const sleep = deps.sleep ?? delay;
    let pollFailures = 0;
    const { transportRecoveredFrom: _recoveryAudit, ...pollRequest } = request;
    while (decision.decision === "ask") {
      // A v65 control plane can return `ask` but cannot durably correlate a polling invocation.
      // The provisioned v66 marker is the negotiation proof: fail closed without treating this
      // expected rolling-upgrade skew as a transport failure or opening the circuit.
      if (!askCapable || !decision.approvalRequestId) {
        return {
          exitCode: 0,
          output: preToolOutput("deny", "Manager approval polling is unavailable; blocked fail-closed."),
        };
      }
      if (event !== "PreToolUse") {
        throw new Error("control plane returned an incomplete policy ask");
      }
      if (deps.signal?.aborted) {
        // Nobody is left to print the answer. The parked approval stays with the control plane,
        // which expires or supersedes it as it does when a file-form sidecar is killed mid-poll.
        return { exitCode: 0, output: preToolOutput("deny", "Manager approval was abandoned by its hook.") };
      }
      const askDeadline = Number.isFinite(decision.expiresAt)
        ? Math.trunc(decision.expiresAt!)
        : undefined;
      if (askDeadline != null && now() >= askDeadline) {
        return {
          exitCode: 0,
          output: preToolOutput("deny", "Manager approval expired; blocked fail-closed."),
        };
      }
      const retryAfterMs = Number.isFinite(decision.retryAfterMs)
        ? Math.max(50, Math.min(2_000, Math.trunc(decision.retryAfterMs!)))
        : 250;
      await sleep(askDeadline == null
        ? retryAfterMs
        : Math.min(retryAfterMs, Math.max(0, askDeadline - now())));
      if (deps.signal?.aborted) {
        return { exitCode: 0, output: preToolOutput("deny", "Manager approval was abandoned by its hook.") };
      }
      if (askDeadline != null && now() >= askDeadline) {
        return {
          exitCode: 0,
          output: preToolOutput("deny", "Manager approval expired; blocked fail-closed."),
        };
      }
      try {
        decision = await evaluate({ ...pollRequest, approvalRequestId: decision.approvalRequestId });
        pollFailures = 0;
      } catch (error) {
        if (isTerminalPollError(error)) {
          return {
            exitCode: 0,
            output: preToolOutput("deny", "Manager approval is no longer available; blocked fail-closed."),
          };
        }
        pollFailures++;
        if (pollFailures >= POLICY_HOOK_MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error("control-plane approval polling exceeded its retry limit");
        }
        const backoffMs = Math.min(2_000, 100 * (2 ** Math.min(pollFailures, 4)));
        await sleep(askDeadline == null
          ? backoffMs
          : Math.min(backoffMs, Math.max(0, askDeadline - now())));
      }
    }
    // The authoritative policy response must not be replaced by a deny merely because optional
    // circuit telemetry cannot be persisted (for example, a stranded lock or Windows file scan).
    try {
      updateCircuit(circuitStore, true, now() - started, now());
    } catch {
      /* A later transport failure will still fail closed and repair/open the circuit. */
    }
    if (event !== "PreToolUse") return { exitCode: 0, output: nonBlockingOutput() };
    if (decision.decision === "defer") return { exitCode: 0, output: nonBlockingOutput() };
    if (decision.decision === "provider_ask") {
      return {
        exitCode: 0,
        output: preToolOutput("ask", decision.reason ?? "Manager policy requires approval."),
      };
    }
    if (decision.decision === "allow") {
      return { exitCode: 0, output: preToolOutput("allow", decision.reason ?? "Allowed by manager policy.") };
    }
    return {
      exitCode: 0,
      output: preToolOutput("deny", decision.reason ?? "Blocked by manager policy."),
    };
  } catch {
    if (transport) {
      try {
        updateCircuit(transport.circuit, false, 0, (deps.now ?? Date.now)());
      } catch {
        // A stale lock or persistence race must not strand an endlessly failing hook transport.
        // Conservatively open the breaker; the current PreToolUse event still fails closed below.
        try {
          transport.circuit.write({
            consecutiveFailures: POLICY_HOOK_FAILURE_LIMIT,
            open: true,
            openedAt: (deps.now ?? Date.now)(),
          });
        } catch {
          /* The event-level fail-open/closed response still applies if persistence is unavailable. */
        }
      }
    }
    return { exitCode: 0, output: failureOutput(event) };
  }
}

export async function runPolicyHookCli(argv = process.argv, env = process.env): Promise<void> {
  const result = await runPolicyHook(argv, env);
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
