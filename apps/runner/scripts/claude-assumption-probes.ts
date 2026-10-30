/**
 * Credential-free probes of the Claude Code behaviour the runner depends on (#3797).
 *
 *   CLAUDE_BIN=/path/to/claude node --import tsx apps/runner/scripts/claude-assumption-probes.ts --probe <id>
 *
 * Normally run through `pnpm probe:claude-assumptions`, which owns the report. Each probe prints
 * one `claude_assumption` JSON line per measured assumption and exits 0 (all unchanged), 1 (a
 * recorded behaviour changed) or 2 (something could not be measured).
 *
 * Every CLI run uses a throwaway HOME and CLAUDE_CONFIG_DIR, a dummy key and a scripted loopback
 * Messages API (see claude-probe-support.ts). No real model, account or provider home is used.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { capabilitiesFor } from "../src/catalog.js";
import { claudeProjectPathKey } from "../src/claude-background-work.js";
import { CLAUDE_MEDIA_REVIEWER_CLI_VERSION, CLAUDE_MEDIA_REVIEWER_ENV, CLAUDE_MEDIA_REVIEWER_REQUIRED_FLAGS, CLAUDE_MEDIA_REVIEWER_TOOLS, ClaudeMediaReviewerStream,
  claudeMediaReviewerArgs } from "../src/claude-media-reviewer.js";
import { CONTROLLED_REVIEW_CLI_VERSION, CONTROLLED_REVIEW_REQUIRED_FLAGS } from "../src/campaign-review-jobs.js";
import { CLAUDE_CONTROL_CONTRACT_MIN_VERSION, CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION, CLAUDE_STEERING_MIN_VERSION,
  claudeCapabilitiesFromProbe, claudeVersionAtLeast, probeClaudeCode } from "../src/discovery/claude-code.js";
import type { ExecResult } from "../src/discovery/resolve.js";
import { buildClaudeUserMessage, claudePermissionArgs } from "../src/drivers/claude-code.js";
import { MANAGED_WORKTREE_GUARD_MATCHER } from "../src/managed-worktree-guard.js";
import { MEDIA_MCP_SERVER_NAME } from "../src/media-review-relay.js";
import {
  AssumptionChanged, type Block, type ClaudeRun, CouldNotRun, detectorSeesCanary, finalResult, foreignTraceAttempts,
  type IsolatedHome, isolatedClaudeEnv, isolatedHome, closedLoopbackPort, probeResult, type ProbeStatus, type Responder,
  requestText, runClaude, startMessagesStub, startRefusingProxy, type StubReply, type StubRequest, firstUserText,
  toolNames, toolResults, toolResultText, messagesOf,
} from "./claude-probe-support.js";

const ADR = "docs/adr/0012-managed-worktree-guard-hook.md";
const DRIVERS = "docs/DRIVERS.md";
const FIXTURE = "apps/runner/src/drivers/fixtures/claude-can-use-tool-subagent.json";
const DISCOVERY = "apps/runner/src/discovery/claude-code.ts";
const FEASIBILITY = "docs/claude-assumption-probes.md#feasibility";
const MCP_SERVER = fileURLToPath(new URL("./claude-probe-mcp-server.mjs", import.meta.url));
/** A model id for which every measured release offers `auto`; older ids silently fall back to `default`. */
const MODEL = process.env.CLAUDE_PROBE_MODEL || "claude-sonnet-4-6";
const TURN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// Per-probe context and the network-silence ledger

export interface SilenceLedger {
  detector: { ok: boolean; observed: string };
  /** CLI runs whose traffic was recorded. */
  runs: number;
  /** Runs strace should have traced but left no log for: silence is then unmeasured. */
  untraced: number;
  foreign: string[];
  proxied: string[];
  routes: Set<string>;
}
interface Context extends SilenceLedger {
  bin: string;
  version: string;
  scratch: string;
}

const statuses: ProbeStatus[] = [];
function emit(assumption: string, status: ProbeStatus, observed: string, documentation: string): void {
  statuses.push(status);
  probeResult(assumption, status, observed, documentation);
}

/** Run one case; a thrown AssumptionChanged reports "changed", anything else "could not run". */
async function measure(assumption: string, documentation: string, body: () => Promise<string>): Promise<void> {
  try {
    emit(assumption, "unchanged", await body(), documentation);
  } catch (error) {
    const message = (error as Error).message.slice(0, 600);
    emit(assumption, error instanceof AssumptionChanged ? "changed" : "could not run", message, documentation);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssumptionChanged(message);
}

/**
 * Network silence across a probe's CLI runs. Observed traffic is evidence whatever else failed, so
 * it reports "changed" first. Otherwise silence holds only when a working detector traced every
 * run; a blind, missing or partial detector is "could not run", never a pass.
 */
export function silenceVerdict(ledger: SilenceLedger): { status: ProbeStatus; observed: string } {
  const strayRoutes = [...ledger.routes].filter((route) => route !== "POST /v1/messages");
  if (ledger.foreign.length || ledger.proxied.length || strayRoutes.length) {
    return { status: "changed", observed: [
      ledger.foreign.length ? `traced destinations: ${[...new Set(ledger.foreign)].join("; ")}` : "",
      ledger.proxied.length ? `proxy requests: ${[...new Set(ledger.proxied)].join("; ")}` : "",
      strayRoutes.length ? `unrecorded stub routes: ${strayRoutes.join("; ")}` : "",
    ].filter(Boolean).join(" | ") };
  }
  if (!ledger.detector.ok) return { status: "could not run", observed: `network detector unavailable: ${ledger.detector.observed}` };
  if (ledger.untraced) return { status: "could not run", observed: `${ledger.untraced} runs left no trace log` };
  if (ledger.runs === 0) return { status: "could not run", observed: "no CLI run completed" };
  return { status: "unchanged", observed: `${ledger.runs} traced runs; every connect() went to the stub; routes: ${[...ledger.routes].join(", ") || "none"}` };
}

function emitSilence(context: Context, probe: string): void {
  const { status, observed } = silenceVerdict(context);
  emit(`${probe}: CLI runs contact only the loopback Messages API (non-essential traffic disabled)`, status, observed, FEASIBILITY);
}

// ---------------------------------------------------------------------------------------------
// Scripted conversations

type Step = (request: StubRequest) => StubReply;
interface Conversation { marker: string; steps: Step[]; final?: string; finished?: boolean }

const text = (value: string): StubReply => ({ content: [{ type: "text", text: value }] });
const tool = (id: string, name: string, input: Record<string, unknown>): StubReply => ({ content: [{ type: "tool_use", id, name, input }] });
function assistantTurns(request: StubRequest): number {
  return messagesOf(request.body).filter((message) => message.role === "assistant").length;
}

/**
 * Route each request to the scripted conversation whose marker opens it (a subagent's task is its
 * own conversation) and answer by how many assistant turns it already holds. Requests without
 * tools are the CLI's side requests (titles, summaries) and get a plain reply. The auto-mode
 * classifier is answered "allow" so allow-controls can run; no probe depends on its judgement.
 */
function scripted(conversations: Conversation[]): Responder {
  return (request) => {
    const stops = request.body?.stop_sequences;
    if (Array.isArray(stops) && stops.includes("</block>")) return text("<block>no</block>");
    if (toolNames(request.body).length) {
      const first = firstUserText(request.body);
      for (const conversation of conversations) {
        if (!first.includes(conversation.marker)) continue;
        const step = conversation.steps[assistantTurns(request)];
        if (step) return step(request);
        conversation.finished = true;
        return text(conversation.final ?? `${conversation.marker} done`);
      }
    }
    return text("ok");
  };
}

/** The Agent (or, in older releases, Task) call that starts a synchronous general-purpose subagent. */
function subagentCall(request: StubRequest, id: string, prompt: string): StubReply {
  const tools = (request.body?.tools ?? []) as Array<{ name?: string; input_schema?: { properties?: Record<string, unknown> } }>;
  const agent = tools.find((t) => t.name === "Agent") ?? tools.find((t) => t.name === "Task");
  if (!agent?.name) throw new CouldNotRun("the CLI offered no Agent or Task tool");
  const background = agent.input_schema?.properties && "run_in_background" in agent.input_schema.properties;
  return tool(id, agent.name, { description: "probe subtask", prompt, subagent_type: "general-purpose", ...(background ? { run_in_background: false } : {}) });
}

function resultFor(requests: StubRequest[], toolUseId: string): Block | undefined {
  for (const request of requests) {
    const found = toolResults(request.body).find((block) => block.tool_use_id === toolUseId);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// One isolated CLI session

interface SessionSpec {
  /** The scripted conversations this run must hold; each must reach its final answer (see completed). */
  conversations: Conversation[];
  /** Steering ends its conversation on its own terms and checks completion itself. */
  allowUnfinished?: boolean;
  args: (paths: IsolatedHome) => string[];
  stdin?: (paths: IsolatedHome) => string[];
  onEvent?: Parameters<typeof runClaude>[0]["onEvent"];
  prepare?: (paths: IsolatedHome) => void;
  /** Run in an earlier session's homes (resume) instead of fresh ones. */
  paths?: IsolatedHome;
  env?: Record<string, string>;
  /** Extra loopback ports the run may legitimately reach (the in-CLI canary). */
  allowPorts?: number[];
}
interface Session { run: ClaudeRun; requests: StubRequest[]; paths: IsolatedHome; init?: Record<string, unknown>; foreign: string[]; spec: SessionSpec }

/** The clean final result of a session whose scripted conversations all reached their final answer. */
function completed(result: Session): Record<string, unknown> {
  const final = finalResult(result.run);
  if (!result.spec.allowUnfinished && result.spec.conversations.some((conversation) => !conversation.finished)) {
    throw new CouldNotRun("a scripted conversation never reached its final answer");
  }
  return final;
}

async function session(context: Context, spec: SessionSpec): Promise<Session> {
  const paths = spec.paths ?? isolatedHome(mkdtempSync(join(context.scratch, "case-")));
  spec.prepare?.(paths);
  const stub = await startMessagesStub(scripted(spec.conversations));
  const proxy = await startRefusingProxy();
  try {
    const env = { ...isolatedClaudeEnv(paths, stub.url, proxy.url), ...spec.env };
    const run = await runClaude({
      bin: context.bin, args: spec.args(paths), cwd: paths.work, env, timeoutMs: TURN_TIMEOUT_MS,
      traceFile: context.detector.ok ? join(paths.root, `trace-${randomUUID()}.log`) : undefined, stdin: spec.stdin?.(paths), onEvent: spec.onEvent,
    });
    // Record what the run contacted before judging it: a failed case still counts against silence.
    for (const request of stub.requests) context.routes.add(`${request.method} ${request.path.split("?")[0]}`);
    context.proxied.push(...proxy.destinations);
    const foreign = context.detector.ok && run.trace !== null
      ? foreignTraceAttempts(run.trace, [stub.port, ...(spec.allowPorts ?? [])]).map((a) => `${a.family} ${a.address}:${a.port ?? "?"}`)
      : [];
    context.foreign.push(...foreign);
    if (context.detector.ok && run.trace === null) { context.untraced += 1; throw new CouldNotRun("strace produced no log for this run"); }
    context.runs += 1;
    if (stub.faults.length) throw new CouldNotRun(`scripted stub could not answer: ${stub.faults[0]}`);
    if (run.spawnError) throw new CouldNotRun(`claude could not start: ${run.spawnError}`);
    if (run.timedOut) throw new CouldNotRun("claude timed out or exceeded the output bound");
    const init = run.events.find((e) => e.type === "system" && e.subtype === "init");
    return { run, requests: stub.requests, paths, init, foreign, spec };
  } finally {
    await stub.close();
    await proxy.close();
  }
}

function printArgs(prompt: string, extra: string[]): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", MODEL, ...extra];
}
function requireMode(result: Session, mode: string): void {
  if (result.init?.permissionMode !== mode) {
    throw new CouldNotRun(`the CLI started in ${String(result.init?.permissionMode ?? "no reported mode")}, not ${mode}`);
  }
}
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name))).sort();
}

// ---------------------------------------------------------------------------------------------
// isolation: the in-CLI detector control, quiet-turn endpoints, and leftovers

async function probeIsolation(context: Context): Promise<void> {
  await measure("detector sees traffic from the CLI's own tool processes (positive control)", FEASIBILITY, async () => {
    const port = await closedLoopbackPort();
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const result = await session(context, {
      conversations: [{ marker, steps: [() => tool("toolu_canary", "Bash", { command: `exec 3<>/dev/tcp/127.0.0.1/${port} || true`, description: "canary" })] }],
      args: () => printArgs(marker, ["--permission-mode", "bypassPermissions"]),
      // The canary is this run's only permitted extra destination; the silence ledger excludes it.
      allowPorts: [port],
    });
    completed(result);
    if (!context.detector.ok) throw new CouldNotRun(context.detector.observed);
    const canary = `127.0.0.1:${port}`;
    if (!foreignTraceAttempts(result.run.trace ?? "", []).some((attempt) => attempt.port === port)) {
      throw new CouldNotRun(`strace did not see the CLI's Bash tool connect to ${canary}; the detector is blind to the CLI's process tree`);
    }
    return `strace saw the Bash tool's canary connect to ${canary}`;
  });

  await measure("a quiet turn contacts only POST /v1/messages on the loopback stub", FEASIBILITY, async () => {
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const result = await session(context, {
      conversations: [{ marker, steps: [() => tool("toolu_quiet", "Bash", { command: "true", description: "quiet" })] }],
      args: () => printArgs(marker, ["--permission-mode", "bypassPermissions"]),
    });
    const final = completed(result);
    if (final.is_error === true) throw new CouldNotRun(`turn ended in error: ${String(final.result).slice(0, 200)}`);
    if (result.foreign.length) throw new AssumptionChanged(`contacted ${result.foreign.join(", ")}`);
    const realHome = process.env.HOME;
    const leaked = realHome && realHome !== "/" && result.requests.some((r) => requestText(r.body).includes(realHome));
    if (leaked) throw new AssumptionChanged("a model request named the invoking account's real HOME");
    // Observation only: what the CLI left in its throwaway homes (names, never contents).
    const leftovers = [...filesUnder(result.paths.configDir).map((f) => `config/${f}`), ...filesUnder(result.paths.home).map((f) => `home/${f}`)];
    return `${result.requests.length} requests, all ${[...new Set(result.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`))].join(", ")}; ` +
      `leftover files: ${leftovers.map((f) => f.replace(/projects\/[^/]+\//, "projects/<key>/").replace(/[0-9a-f-]{36}/g, "<uuid>").replace(/\d{10,}/g, "<n>")).join(", ") || "none"}`;
  });
}

// ---------------------------------------------------------------------------------------------
// hooks: PreToolUse firing and both blocking forms, per mode and in a subagent

type HookBehaviour = "allow" | "deny-json" | "exit-2";
const DENY_REASON = "PROBE-HOOK-DENY-JSON";
const EXIT_REASON = "PROBE-HOOK-EXIT-2";

function writeHook(paths: IsolatedHome, behaviour: HookBehaviour, tag = "hook"): { command: string; log: string } {
  const log = join(paths.root, `${tag}.jsonl`);
  const command = join(paths.root, `${tag}.sh`);
  const tail = behaviour === "deny-json"
    ? `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } })}'\nexit 0`
    : behaviour === "exit-2" ? `echo ${EXIT_REASON} >&2\nexit 2` : "exit 0";
  writeFileSync(command, `#!/bin/sh\ncat >> '${log}'\nprintf '\\n' >> '${log}'\n${tail}\n`);
  chmodSync(command, 0o700);
  return { command, log };
}
function hookSettings(command: string): string {
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: MANAGED_WORKTREE_GUARD_MATCHER, hooks: [{ type: "command", command }] }] } });
}
function hookCalls(log: string): Array<Record<string, unknown>> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function hookCase(context: Context, mode: string, behaviour: HookBehaviour, subagent: boolean): Promise<string> {
  const marker = `PROBE-${randomUUID().slice(0, 8)}`;
  const subMarker = `${marker}-SUB`;
  const target = "ran.txt";
  const command = `echo probe > ${target}`;
  const bashId = subagent ? "toolu_sub_bash" : "toolu_main_bash";
  let hook!: { command: string; log: string };
  const conversations: Conversation[] = subagent
    ? [{ marker: subMarker, steps: [() => tool(bashId, "Bash", { command, description: "probe" })] },
      { marker, steps: [(r) => subagentCall(r, "toolu_agent", `${subMarker} run the command`)] }]
    : [{ marker, steps: [() => tool(bashId, "Bash", { command, description: "probe" })] }];
  const result = await session(context, {
    prepare: (paths) => { hook = writeHook(paths, behaviour); },
    conversations: conversations,
    args: () => printArgs(marker, ["--permission-mode", mode, "--settings", hookSettings(hook.command)]),
  });
  completed(result);
  requireMode(result, mode);
  if (subagent && !conversations[0]!.finished) throw new CouldNotRun("the subagent never completed its scripted turn");
  const calls = hookCalls(hook.log).filter((call) => call.tool_name === "Bash");
  const ran = existsSync(join(result.paths.work, target));
  const toolResult = resultFor(result.requests, bashId);
  if (!toolResult) throw new CouldNotRun("the CLI never returned a result for the scripted Bash call");
  expect(calls.length === 1, `hook ran ${calls.length} times for one Bash call`);
  const payload = calls[0]!;
  const input = payload.tool_input as { command?: unknown } | undefined;
  expect(payload.hook_event_name === "PreToolUse" && input?.command === command, "hook payload lacks the PreToolUse event or the exact command");
  expect(payload.permission_mode === mode, `hook payload permission_mode is ${String(payload.permission_mode)}`);
  expect(typeof payload.cwd === "string" && isAbsolute(payload.cwd), "hook payload has no absolute cwd");
  if (subagent) expect(typeof payload.agent_id === "string" && typeof payload.agent_type === "string", "subagent hook payload lacks agent_id/agent_type");
  else expect(payload.agent_id === undefined, "top-level hook payload carries agent_id");
  const resultText = toolResultText(toolResult);
  if (behaviour === "allow") {
    expect(ran, "an allowed call did not run");
    return `hook fired once (${Object.keys(payload).sort().join(",")}); the call ran`;
  }
  expect(!ran, `${behaviour} did not block the call: it ran`);
  const reason = behaviour === "deny-json" ? DENY_REASON : EXIT_REASON;
  expect(resultText.includes(reason), `${behaviour} blocked the call but the reason did not reach the model`);
  return `hook fired once; ${behaviour} blocked the call and the model saw the reason`;
}

async function probeHooks(context: Context): Promise<void> {
  for (const mode of ["auto", "acceptEdits", "bypassPermissions"]) {
    for (const behaviour of ["allow", "deny-json", "exit-2"] as const) {
      await measure(`PreToolUse hook via --settings in ${mode}: ${behaviour}`, ADR, () => hookCase(context, mode, behaviour, false));
    }
  }
  for (const behaviour of ["allow", "deny-json", "exit-2"] as const) {
    await measure(`PreToolUse hook covers a subagent's Bash call (bypassPermissions): ${behaviour}`, ADR, () => hookCase(context, "bypassPermissions", behaviour, true));
  }
}

// ---------------------------------------------------------------------------------------------
// settings: last --settings wins, inline JSON accepted

async function settingsCase(context: Context, forms: Array<"file" | "inline">): Promise<string[]> {
  const marker = `PROBE-${randomUUID().slice(0, 8)}`;
  const hooks: Array<{ command: string; log: string }> = [];
  const result = await session(context, {
    prepare: (paths) => forms.forEach((_, index) => hooks.push(writeHook(paths, "allow", `hook-${index}`))),
    conversations: [{ marker, steps: [() => tool("toolu_settings", "Bash", { command: "true", description: "probe" })] }],
    args: (paths) => printArgs(marker, ["--permission-mode", "bypassPermissions", ...forms.flatMap((form, index) => {
      const document = hookSettings(hooks[index]!.command);
      if (form === "inline") return ["--settings", document];
      const file = join(paths.root, `settings-${index}.json`);
      writeFileSync(file, document);
      return ["--settings", file];
    })]),
  });
  completed(result);
  if (!resultFor(result.requests, "toolu_settings")) throw new CouldNotRun("the CLI never returned a result for the scripted Bash call");
  return hooks.map((hook, index) => hookCalls(hook.log).length ? `${forms[index]}#${index}` : "").filter(Boolean);
}

async function probeSettings(context: Context): Promise<void> {
  await measure("inline JSON --settings is accepted", ADR, async () => {
    const fired = await settingsCase(context, ["inline"]);
    expect(fired.length === 1, "an inline settings document's hook did not run");
    return "the inline document's hook ran";
  });
  for (const forms of [["file", "file"], ["file", "inline"], ["inline", "file"]] as Array<Array<"file" | "inline">>) {
    await measure(`two --settings (${forms.join(", ")}): only the last applies`, ADR, async () => {
      const fired = await settingsCase(context, forms);
      expect(fired.length === 1 && fired[0] === `${forms[1]}#1`, `hooks that ran: ${fired.join(", ") || "none"} (expected only the last)`);
      return "only the last document's hook ran";
    });
  }
}

// ---------------------------------------------------------------------------------------------
// control channel: the can_use_tool envelope against the recorded fixture, and both answers

interface FixtureFrame { issuer: string; frame: { type: string; request_id: string; request: Record<string, unknown> } }
function fixtureKeys(mode: string, issuer: string, command: string): Set<string> {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(`../src/drivers/fixtures/claude-can-use-tool-subagent.json`, import.meta.url)), "utf8")) as {
    captures: Array<{ permissionMode: string; frames: FixtureFrame[] }>;
  };
  const keys = new Set<string>();
  for (const capture of fixture.captures.filter((c) => c.permissionMode === mode)) {
    for (const frame of capture.frames.filter((f) => f.issuer === issuer && (f.frame.request.input as { command?: unknown })?.command === command)) Object.keys(frame.frame.request).forEach((key) => keys.add(key));
  }
  return keys;
}

async function controlCase(context: Context, answer: "allow" | "deny", subagent: boolean): Promise<string> {
  const marker = `PROBE-${randomUUID().slice(0, 8)}`;
  const subMarker = `${marker}-SUB`;
  const command = "rm -rf ./build";
  const bashId = subagent ? "toolu_sub_rm" : "toolu_main_rm";
  const denial = "PROBE-CONTROL-DENIED";
  const conversations: Conversation[] = subagent
    ? [{ marker: subMarker, steps: [() => tool(bashId, "Bash", { command, description: "probe" })] },
      { marker, steps: [(r) => subagentCall(r, "toolu_agent", `${subMarker} run the command`)] }]
    : [{ marker, steps: [() => tool(bashId, "Bash", { command, description: "probe" })] }];
  const main = conversations.at(-1)!;
  const frames: Array<Record<string, unknown>> = [];
  const result = await session(context, {
    prepare: (paths) => mkdirSync(join(paths.work, "build")),
    conversations: conversations,
    // The driver's own interactive argument set for `default` and its stream-json prompt shape. The
    // mode is named explicitly so the envelope is measured even on a release whose flagless default
    // differs; whether the flagless launch starts in `default` is its own assumption below.
    args: () => ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", randomUUID(),
      "--model", MODEL, ...claudePermissionArgs("default").args, "--permission-mode", "default"],
    stdin: () => [JSON.stringify(buildClaudeUserMessage(marker, []))],
    onEvent: (event, write, closeStdin) => {
      if (event.type === "control_request") {
        frames.push(event);
        const request = event.request as Record<string, unknown> | undefined;
        if (request?.subtype !== "can_use_tool") return;
        // Answer exactly as ClaudeCodeDriver.resolvePermission does. Only the Bash call is the subject.
        const response = request.tool_name !== "Bash" || answer === "allow"
          ? { behavior: "allow", updatedInput: request.input }
          : { behavior: "deny", message: denial };
        write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } }));
      }
      if (event.type === "result" && main.finished) closeStdin();
    },
  });
  completed(result);
  requireMode(result, "default");
  const bash = frames.filter((f) => (f.request as Record<string, unknown> | undefined)?.tool_name === "Bash");
  if (!resultFor(result.requests, bashId)) throw new CouldNotRun("the CLI never returned a result for the scripted Bash call");
  expect(bash.length === 1, `${bash.length} can_use_tool frames for one Bash call that needs approval`);
  const frame = bash[0]!;
  const request = frame.request as Record<string, unknown>;
  expect(JSON.stringify(Object.keys(frame).sort()) === JSON.stringify(["request", "request_id", "type"]), `envelope keys are ${Object.keys(frame).sort().join(",")}`);
  expect(frame.type === "control_request" && typeof frame.request_id === "string" && request.subtype === "can_use_tool", "frame is not a can_use_tool control_request");
  expect((request.input as { command?: unknown })?.command === command && request.tool_use_id === bashId, "frame does not carry the issued command and tool_use_id");
  expect(!("cwd" in request) && !JSON.stringify(frame).includes("parent_tool_use_id"), "frame carries cwd or parent_tool_use_id");
  if (subagent) expect(typeof request.agent_id === "string" && request.agent_id, "a subagent's frame lacks request.agent_id");
  else expect(!("agent_id" in request), "a top-level frame carries agent_id");
  if ("blocked_path" in request) expect(typeof request.blocked_path === "string" && isAbsolute(request.blocked_path), "blocked_path is not absolute");
  const ran = !existsSync(join(result.paths.work, "build"));
  if (answer === "allow") expect(ran, "an allowed call did not run");
  else {
    expect(!ran, "a denied call ran");
    expect(toolResultText(resultFor(result.requests, bashId)!).includes(denial), "the deny message did not reach the model");
  }
  const recorded = fixtureKeys("default", subagent ? "subagent" : "top-level", command);
  const keys = new Set(Object.keys(request));
  const added = [...keys].filter((k) => !recorded.has(k));
  const missing = [...recorded].filter((k) => !keys.has(k));
  return `envelope {type, request_id, request}; ${answer} honoured; request keys vs fixture: ` +
    `${added.length ? `added ${added.join(",")}` : "none added"}, ${missing.length ? `absent ${missing.join(",")}` : "none absent"}`;
}

async function probeControl(context: Context): Promise<void> {
  // claudePermissionArgs("default") passes no --permission-mode: the driver relies on the CLI's own
  // default being `default`. Measured on 2.1.296: with an auto-capable model it starts in `auto`.
  await measure("the driver's flagless `default` launch starts the CLI in default mode", `${DRIVERS} (2.6 Approvals mapping)`, async () => {
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const result = await session(context, {
      conversations: [{ marker, steps: [] }],
      args: () => ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", randomUUID(),
        "--model", MODEL, ...claudePermissionArgs("default").args],
      stdin: () => [JSON.stringify(buildClaudeUserMessage(marker, []))],
      onEvent: (event, _write, closeStdin) => { if (event.type === "result") closeStdin(); },
    });
    completed(result);
    const mode = result.init?.permissionMode;
    if (typeof mode !== "string") throw new CouldNotRun("the init event reports no permission mode");
    expect(mode === "default", `with ${MODEL} and no --permission-mode the CLI started in ${mode}`);
    return `started in default with ${MODEL}`;
  });
  for (const [answer, subagent] of [["allow", false], ["deny", false], ["allow", true]] as const) {
    await measure(`can_use_tool envelope matches ${FIXTURE.split("/").pop()} (default, ${subagent ? "subagent" : "top-level"}, ${answer})`,
      `${ADR}; ${FIXTURE}`, () => controlCase(context, answer, subagent));
  }
}

// ---------------------------------------------------------------------------------------------
// mcp-image: an MCP tool's image result reaches the model request

function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw.set([x * 32, y * 32, 128], y * 25 + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function mcpConfig(paths: IsolatedHome, server: string, tools: Array<{ name: string; description: string; content: unknown[] }>): { config: string; log: string } {
  const log = join(paths.root, `${server}-calls.jsonl`);
  const fixture = join(paths.root, `${server}-fixture.json`);
  writeFileSync(fixture, JSON.stringify({ log, tools }));
  const config = join(paths.root, `${server}-mcp.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { [server]: { type: "stdio", command: process.execPath, args: [MCP_SERVER, fixture] } } }));
  return { config, log };
}

async function probeMcpImage(context: Context): Promise<void> {
  const floor = claudeVersionAtLeast(context.version, CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION);
  const name = floor ? `MCP tool image result reaches the model request (floor ${CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION})`
    : `MCP tool image result below the ${CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION} floor (runner does not rely on it; observation)`;
  await measure(name, `${DISCOVERY} (CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION)`, async () => {
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const data = tinyPng().toString("base64");
    let mcp!: { config: string; log: string };
    const result = await session(context, {
      prepare: (paths) => { mcp = mcpConfig(paths, "probe", [{ name: "image", description: "Returns an image.", content: [
        { type: "text", text: "receipt" }, { type: "image", data, mimeType: "image/png" }] }]); },
      conversations: [{ marker, steps: [() => tool("toolu_image", "mcp__probe__image", {})] }],
      args: () => printArgs(marker, ["--mcp-config", mcp.config, "--strict-mcp-config", "--permission-mode", "bypassPermissions"]),
    });
    completed(result);
    const called = existsSync(mcp.log) && readFileSync(mcp.log, "utf8").includes("\"image\"");
    if (!called) throw new CouldNotRun("the CLI never called the scripted MCP tool");
    const toolResult = resultFor(result.requests, "toolu_image");
    if (!toolResult) throw new CouldNotRun("the CLI never returned the MCP tool result to the model");
    const blocks = Array.isArray(toolResult.content) ? toolResult.content as Block[] : [];
    const image = blocks.find((b) => b.type === "image") as { source?: { type?: string; media_type?: string; data?: string } } | undefined;
    const exact = image?.source?.type === "base64" && image.source.data === data;
    const observed = image ? `image block reached the request (${image.source?.media_type ?? "?"}, ${exact ? "exact bytes" : "re-encoded"})` : "no image block reached the request";
    if (!floor) return `${observed}${image ? "; lowering the floor would still need the manual real-model probe:claude-mcp-image" : ", consistent with the floor"}`;
    expect(image, observed);
    return observed;
  });
}

// ---------------------------------------------------------------------------------------------
// steering: a mid-turn stream-json user message is replayed and reaches the model

async function probeSteering(context: Context): Promise<void> {
  const floor = claudeVersionAtLeast(context.version, CLAUDE_STEERING_MIN_VERSION);
  const name = floor ? `mid-turn steering is replayed and reaches the model (floor ${CLAUDE_STEERING_MIN_VERSION})`
    : `mid-turn steering below the ${CLAUDE_STEERING_MIN_VERSION} floor (runner does not offer it; observation)`;
  await measure(name, `${DISCOVERY} (CLAUDE_STEERING_MIN_VERSION); apps/runner/src/drivers/claude-code.ts steer()`, async () => {
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const steer = `PROBE-STEER-${randomUUID().slice(0, 8)}`;
    const steerId = randomUUID();
    let replayed = false;
    let wrote = false;
    const conversation: Conversation = { marker, steps: [
      () => tool("toolu_wait", "Bash", { command: "sleep 4", description: "wait" }),
      () => text("waiting"),
    ] };
    const result = await session(context, {
      conversations: [conversation],
      allowUnfinished: true,
      args: () => ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--session-id", randomUUID(),
        "--model", MODEL, "--replay-user-messages", ...claudePermissionArgs("bypassPermissions", false, true).args],
      stdin: () => [JSON.stringify(buildClaudeUserMessage(marker, []))],
      onEvent: (event, write, closeStdin) => {
        const content = (event.message as { content?: Block[] } | undefined)?.content;
        if (!wrote && event.type === "assistant" && content?.some((b) => b.type === "tool_use" && b.id === "toolu_wait")) {
          wrote = true;
          write(JSON.stringify(buildClaudeUserMessage(steer, [], steerId)));
        }
        if (event.type === "user" && event.isReplay === true && event.uuid === steerId) replayed = true;
        if (event.type === "result" && wrote) {
          const reached = conversation.finished;
          if (reached || replayed) closeStdin();
        }
      },
    });
    completed(result);
    if (!wrote) throw new CouldNotRun("the scripted tool call never started, so no steering was sent");
    const reached = result.requests.some((r) => requestText(r.body).includes(steer));
    const observed = `replay acknowledgement: ${replayed ? "yes" : "no"}; steering text reached the model: ${reached ? "yes" : "no"}`;
    if (!floor) return `${observed}${replayed && reached ? "; the floor could be lowered through a reviewed change" : ""}`;
    expect(replayed && reached, observed);
    return observed;
  });
}

// ---------------------------------------------------------------------------------------------
// transcript: location under CLAUDE_CONFIG_DIR, and resume reads it from there

async function probeTranscript(context: Context): Promise<void> {
  await measure("transcript is CLAUDE_CONFIG_DIR/projects/<claudeProjectPathKey(cwd)>/<session-id>.jsonl and --resume reads it", DRIVERS, async () => {
    const marker = `PROBE-${randomUUID().slice(0, 8)}`;
    const followUp = `PROBE-RESUME-${randomUUID().slice(0, 8)}`;
    const sessionId = randomUUID();
    const first = await session(context, {
      conversations: [{ marker, steps: [] }],
      args: () => printArgs(marker, ["--permission-mode", "bypassPermissions", "--session-id", sessionId]),
    });
    completed(first);
    const expected = join(first.paths.configDir, "projects", claudeProjectPathKey(first.paths.work), `${sessionId}.jsonl`);
    const found = filesUnder(first.paths.root).filter((f) => f.endsWith(`${sessionId}.jsonl`));
    expect(existsSync(expected), `transcript not at the expected path; found: ${found.join(", ") || "none"}`);
    expect(readFileSync(expected, "utf8").includes(marker), "transcript does not hold the prompt");
    expect(!existsSync(join(first.paths.home, ".claude")), "the CLI also wrote HOME/.claude despite CLAUDE_CONFIG_DIR");
    // Resume in a fresh process over the same throwaway homes: the model must see the first turn.
    // Resume in a fresh process over the same throwaway homes: the model must see the first turn.
    const second = await session(context, {
      paths: first.paths,
      // The resumed conversation opens with the first prompt, so it is scripted under that marker.
      conversations: [{ marker, steps: [] }],
      args: () => printArgs(followUp, ["--permission-mode", "bypassPermissions", "--resume", sessionId]),
    });
    completed(second);
    const resumed = second.requests.filter((r) => toolNames(r.body).length && requestText(r.body).includes(followUp));
    if (!resumed.length) throw new CouldNotRun("the resumed turn never reached the stub");
    expect(resumed.some((r) => requestText(r.body).includes(marker)), "the resumed turn did not carry the first turn's prompt");
    return "transcript at <config>/projects/<claudeProjectPathKey(cwd)>/<session>.jsonl; resume carried the prior turn; HOME/.claude untouched";
  });
}

// ---------------------------------------------------------------------------------------------
// discovery: the runner's own discovery over this release, against the recorded floors

async function tracedExec(context: Context, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  const paths = isolatedHome(mkdtempSync(join(context.scratch, "exec-")));
  const proxy = await startRefusingProxy();
  try {
    // A base URL nobody listens on: discovery must not need a model.
    const run = await runClaude({ bin: context.bin, args, cwd: paths.work, env: isolatedClaudeEnv(paths, `http://127.0.0.1:${await closedLoopbackPort()}`, proxy.url),
      timeoutMs, traceFile: context.detector.ok ? join(paths.root, "trace.log") : undefined });
    context.runs += 1;
    context.proxied.push(...proxy.destinations);
    if (context.detector.ok && run.trace === null) context.untraced += 1;
    if (context.detector.ok) context.foreign.push(...foreignTraceAttempts(run.trace ?? "", []).map((a) => `${a.family} ${a.address}:${a.port ?? "?"}`));
    return { code: run.code, stdout: run.stdout, stderr: "", timedOut: run.timedOut, ...(run.spawnError ? { errorCode: run.spawnError } : {}) };
  } finally { await proxy.close(); }
}

async function probeDiscovery(context: Context): Promise<void> {
  const discovery = await probeClaudeCode((args, timeoutMs) => tracedExec(context, args, timeoutMs), "path");
  await measure("runner discovery reads this release's version and help", DISCOVERY, async () => {
    if (discovery.failure?.code === "probe_timeout" || discovery.failure?.code === "version_unverified") throw new CouldNotRun(`discovery failed: ${discovery.failure.code}`);
    expect(discovery.installedVersion === context.version, `discovery read ${String(discovery.installedVersion)}`);
    expect(discovery.streamJsonInput, "help no longer advertises --input-format stream-json");
    for (const mode of ["acceptEdits", "auto", "bypassPermissions", "plan"]) expect(discovery.permissionModes.includes(mode), `help no longer lists permission mode ${mode}`);
    expect(discovery.status !== "unsupported", `discovery classified this release unsupported (${discovery.failure?.message ?? ""})`);
    return `status ${discovery.status}; modes ${discovery.permissionModes.join(",")}; replay ${discovery.replayUserMessages}; fork ${discovery.forkSession}`;
  });
  const base = capabilitiesFor("claude-code");
  if (!base) throw new Error("catalog lacks claude-code");
  const capabilities = claudeCapabilitiesFromProbe(base, discovery);
  const floors: Array<[string, string, boolean]> = [
    ["stdio control contract", CLAUDE_CONTROL_CONTRACT_MIN_VERSION, discovery.controlProtocol],
    ["steering", CLAUDE_STEERING_MIN_VERSION, capabilities.supportsSteering === true],
    ["MCP image tool results", CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION, capabilities.imageToolResults === true],
  ];
  for (const [label, floor, attested] of floors) {
    await measure(`discovery attests ${label} exactly from ${floor}`, DISCOVERY, async () => {
      const at = claudeVersionAtLeast(context.version, floor);
      expect(attested === at, `${label} attested=${attested} on ${context.version} (floor ${floor})`);
      return `${context.version} ${at ? "meets" : "is below"} ${floor}; attested=${attested}`;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// reviewer-pin: the behaviour the 2.1.296 reviewer pins rest on

/** The release both reviewers accept; the suite compares the measured release with it. */
export const REVIEWER_PIN = CONTROLLED_REVIEW_CLI_VERSION;
if (REVIEWER_PIN !== CLAUDE_MEDIA_REVIEWER_CLI_VERSION) throw new Error("the native and media reviewer pins diverged; compare each separately");
/** Measured on 2.1.296 with this probe (2026-10-30): under `--bare` the CLI emits this before its
 * startup init. ClaudeMediaReviewerStream requires init first, so this is recorded as the pin's
 * baseline and reported separately rather than hidden (see docs/claude-assumption-probes.md). */
export const REVIEWER_PIN_PRE_INIT_EVENTS: readonly string[] = ["system/ui_invalidate"];

async function probeReviewer(context: Context): Promise<void> {
  const help = await tracedExec(context, ["--help"]);
  // Both reviewers refuse every release but the pin. A release below it is never a candidate to move
  // the pin to, so there the comparison is reported as an observation (could not run still fails).
  const candidate = claudeVersionAtLeast(context.version, REVIEWER_PIN);
  const compare = (assumption: string, documentation: string, body: () => Promise<string>) => candidate
    ? measure(assumption, documentation, body)
    : measure(`${assumption} (observation below the ${REVIEWER_PIN} pin; reviewers refuse this release)`, documentation, async () => {
      try { return `same as the pin: ${await body()}`; } catch (error) {
        if (error instanceof AssumptionChanged) return `differs from the pin: ${error.message}`;
        throw error;
      }
    });
  await compare("reviewer flag surface (controlled native reviewer and media reviewer)", "apps/runner/src/campaign-review-jobs.ts; apps/runner/src/claude-media-reviewer.ts", async () => {
    if (help.code !== 0 || !help.stdout) throw new CouldNotRun("claude --help failed");
    const missing = [...new Set([...CONTROLLED_REVIEW_REQUIRED_FLAGS, ...CLAUDE_MEDIA_REVIEWER_REQUIRED_FLAGS])].filter((flag) => !help.stdout.includes(flag));
    expect(!missing.length, `help lacks ${missing.join(", ")}`);
    return "every pinned reviewer flag is present";
  });
  // One media reviewer window under the production flags, environment and stream parser.
  const marker = `PROBE-${randomUUID().slice(0, 8)}`;
  let mcp!: { config: string; log: string };
  let window: Session | undefined;
  let windowError: Error | undefined;
  try {
    window = await session(context, {
      prepare: (paths) => { mcp = mcpConfig(paths, MEDIA_MCP_SERVER_NAME, CLAUDE_MEDIA_REVIEWER_TOOLS.map((name) => ({
        name: name.split("__").pop()!, description: "probe", content: [{ type: "text", text: "frame" }] }))); },
      conversations: [{ marker, steps: [() => tool("toolu_frame", CLAUDE_MEDIA_REVIEWER_TOOLS[0]!, { frame: 1 })] }],
      args: () => claudeMediaReviewerArgs({ providerCommand: "claude", mcpConfig: mcp.config, model: MODEL, maxBudgetUsd: 1 }).slice(1),
      env: { ...CLAUDE_MEDIA_REVIEWER_ENV },
      stdin: () => [JSON.stringify(buildClaudeUserMessage(marker, []))],
      onEvent: (event, _write, closeStdin) => { if (event.type === "result") closeStdin(); },
    });
    completed(window);
  } catch (error) { windowError = error as Error; }
  const reviewerWindow = (): Session => {
    if (windowError) throw windowError instanceof AssumptionChanged ? windowError : new CouldNotRun(windowError.message);
    return window!;
  };

  await compare(`events before the media reviewer's startup init match the ${REVIEWER_PIN} baseline`, "docs/claude-assumption-probes.md#reviewer-pin", async () => {
    const events = reviewerWindow().run.events;
    const initIndex = events.findIndex((e) => e.type === "system" && e.subtype === "init");
    if (initIndex < 0) throw new CouldNotRun("no startup init event");
    const before = events.slice(0, initIndex).map((e) => `${String(e.type)}/${String(e.subtype ?? "")}`);
    expect(JSON.stringify(before) === JSON.stringify(REVIEWER_PIN_PRE_INIT_EVENTS),
      `pre-init events ${before.join(", ") || "none"}; ${REVIEWER_PIN} baseline ${REVIEWER_PIN_PRE_INIT_EVENTS.join(", ") || "none"}`);
    return `pre-init events: ${before.join(", ") || "none"} (same as ${REVIEWER_PIN})`;
  });

  await compare("media reviewer init, scoped tool use and priced usage pass the production stream checks", "apps/runner/src/claude-media-reviewer.ts", async () => {
    const events = reviewerWindow().run.events;
    const initIndex = events.findIndex((e) => e.type === "system" && e.subtype === "init");
    if (initIndex < 0) throw new CouldNotRun("no startup init event");
    expect(events[initIndex]!.claude_code_version === context.version, `init reports ${String(events[initIndex]!.claude_code_version)}, not ${context.version}`);
    // Two deliberate substitutions, both measured separately: the pre-init events (above) are not fed
    // to the parser, and the version equality, which is the pin itself, is checked as the pin.
    const stream = new ClaudeMediaReviewerStream({ model: MODEL });
    let refusal: string | null = null;
    for (const event of events.slice(initIndex)) {
      const checked = event.type === "system" && event.subtype === "init" ? { ...event, claude_code_version: REVIEWER_PIN } : event;
      refusal ??= stream.push(JSON.stringify(checked) + "\n");
    }
    expect(!refusal, `production reviewer stream refused: ${refusal}`);
    expect(stream.result.initialized && stream.result.toolCalls === 1, `scoped tool calls seen: ${stream.result.toolCalls}`);
    expect(stream.result.priced && stream.result.turns === 1, "the final result was not priced the way the reviewer requires");
    return `init accepted; 1 scoped tool call; priced result (USD ${stream.result.costUsd})`;
  });
}

// ---------------------------------------------------------------------------------------------

export const PROBE_IDS = ["isolation", "hooks", "settings", "control-channel", "mcp-image", "steering", "transcript", "discovery", "reviewer-pin"] as const;
const PROBES: Record<(typeof PROBE_IDS)[number], (context: Context) => Promise<void>> = {
  isolation: probeIsolation, hooks: probeHooks, settings: probeSettings, "control-channel": probeControl, "mcp-image": probeMcpImage,
  steering: probeSteering, transcript: probeTranscript, discovery: probeDiscovery, "reviewer-pin": probeReviewer,
};

async function main(args: string[]): Promise<number> {
  const id = args[args.indexOf("--probe") + 1] as (typeof PROBE_IDS)[number];
  if (args.indexOf("--probe") < 0 || !PROBE_IDS.includes(id)) throw new Error(`Usage: --probe <${PROBE_IDS.join("|")}>`);
  const bin = process.env.CLAUDE_BIN;
  const version = process.env.CLAUDE_PROBE_VERSION;
  if (!bin || !isAbsolute(bin) || !version) {
    emit(`${id}: probe preconditions`, "could not run", "CLAUDE_BIN (absolute) and CLAUDE_PROBE_VERSION must be set by the suite", FEASIBILITY);
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), `wollipog-claude-probe-${id}-`));
  try {
    const context: Context = { bin, version, scratch, detector: await detectorSeesCanary(scratch), runs: 0, untraced: 0, foreign: [], proxied: [], routes: new Set() };
    await PROBES[id](context);
    emitSilence(context, id);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // Changed wins in mixed runs (the shared contract); could not run still fails the run.
  return statuses.includes("changed") ? 1 : statuses.includes("could not run") ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`could not run: ${(error as Error).message}`);
    process.exitCode = 2;
  });
}
