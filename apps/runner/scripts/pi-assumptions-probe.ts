/** Credential-free re-measurement of the Pi behavior the runner's Pi driver and discovery depend on.
 * Run one group per process through scripts/pi-assumptions.mjs, which supplies the verified network
 * namespace. Never used by discovery or launch eligibility, and never changes a gate. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_AGENT_CONTROL_PROBE_COMMAND,
  PI_AGENT_CONTROL_PROBE_NONCE_ENV,
  PI_AGENT_CONTROL_PROBE_STATUS_KEY,
  PI_AGENT_CONTROL_STATUS_KEY,
  PI_SECURITY_REQUEST_NONCE_ENV,
  PI_SECURITY_REQUEST_PREFIX,
  PI_SECURITY_REQUEST_TITLE,
  piAgentControlExtensionSource,
  piAgentControlProbeSource,
} from "../src/pi-agent-control-extension.js";
import {
  createPiSandbox, observedExternalAttempts, observerLoaded, piCommand, piProbeExit, piResult, PI_PROBE_MODEL,
  PiRpcClient, startScriptedProvider, systemPromptOf, verifyNetworkIsolation, writeFixtureFile, writeProbeModels,
  type IsolationResult, type Json, type PiProbeStatus, type PiSandbox, type ScriptedTurn,
} from "./pi-probe-support.js";
import { compareShapes, recordShapes } from "./pi-rpc-shape.js";

const FAKE_PI = fileURLToPath(new URL("../src/drivers/fixtures/fake-pi-rpc.mjs", import.meta.url));
const ADR_0010 = "docs/adr/0010-additive-orchestrator-role-for-pi.md";
const DOCS = "docs/pi-assumption-probes.md";
const TURN_TIMEOUT_MS = 45_000;
const USER_SKILL = "probe-skill";
const USER_PROMPT = "probe-prompt";
const PROJECT_EXTENSION_COMMAND = "wollipog-probe-project-extension";
const TRUST_OPTIONS = ["Trust This Project", "Skip Project Resources"];

/** Fixture fields the comparison deliberately does not hold real Pi to. Each needs a reason. */
export const FIXTURE_SHAPE_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);

class CouldNotRun extends Error {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function commandExtension(name: string): string {
  return `export default function (pi) { pi.registerCommand(${JSON.stringify(name)}, { description: "probe", handler: async () => {} }); }\n`;
}

const MCP_STUB = `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : message.method === "tools/list"
      ? { tools: [{ name: "probe_noop", description: "Probe no-op", inputSchema: { type: "object", properties: {} } }] }
      : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;

function launch(sandbox: PiSandbox, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; fake?: boolean } = {}): PiRpcClient {
  const env: NodeJS.ProcessEnv = { ...sandbox.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return options.fake
    ? new PiRpcClient(process.execPath, [FAKE_PI, ...args], { cwd: options.cwd ?? sandbox.project, env })
    : new PiRpcClient(piCommand(), args, { cwd: options.cwd ?? sandbox.project, env });
}

async function runTurn(client: PiRpcClient, message: string): Promise<Json[]> {
  const start = client.events.length;
  const response = await client.request({ type: "prompt", message });
  if (response.success !== true) throw new CouldNotRun(`prompt was refused: ${String(response.error ?? "no error")}`);
  await client.waitFor(event => event.type === "agent_settled" && client.events.indexOf(event) > start, TURN_TIMEOUT_MS, "agent_settled");
  return client.events.slice(start);
}

function assistantText(events: Json[]): string {
  return events.filter(e => e.type === "message_end" && e.message?.role === "assistant")
    .flatMap(e => Array.isArray(e.message.content) ? e.message.content : [])
    .filter((part: Json) => part?.type === "text").map((part: Json) => part.text).join("");
}

function commandNames(response: Json): string[] {
  const commands = response.data?.commands;
  if (!Array.isArray(commands)) throw new CouldNotRun("get_commands returned no command catalog");
  return commands.map((command: Json) => command?.name).filter((name: unknown): name is string => typeof name === "string");
}

async function withSandbox<T>(label: string, run: (sandbox: PiSandbox) => Promise<T>): Promise<T> {
  const sandbox = createPiSandbox(label);
  try { return await run(sandbox); } finally { sandbox.cleanup(); }
}

/** Run one assumption; any thrown error is an environment failure, never a measurement. */
async function measure(assumption: string, documentation: string, run: () => Promise<{ status: PiProbeStatus; observed: string }>): Promise<PiProbeStatus> {
  try {
    const { status, observed } = await run();
    return piResult(assumption, status, observed, documentation);
  } catch (error) {
    return piResult(assumption, "could not run", `could not run: ${errorText(error)}`, documentation);
  }
}

const outcome = (problems: string[], ok: string) => problems.length ? { status: "changed" as const, observed: problems.join("; ") } : { status: "unchanged" as const, observed: ok };

// ---------------------------------------------------------------------------------------------
// Network isolation, the scripted-provider turn, and PI_OFFLINE.

async function networkGroup(isolation: IsolationResult): Promise<PiProbeStatus[]> {
  const statuses = [piResult("Network namespace negative control", isolation.verified ? "unchanged" : "could not run",
    isolation.verified ? isolation.observed : `could not run: ${isolation.observed}`, `${DOCS}#network-isolation`)];
  statuses.push(await measure("Pi completes an RPC turn against the scripted loopback provider with no other network", `${DOCS}#network-isolation`, () =>
    withSandbox("network", async sandbox => {
      const provider = await startScriptedProvider(() => ({ text: "SCRIPTED_REPLY_OK" }));
      writeProbeModels(sandbox, provider.port);
      const client = launch(sandbox, ["--mode", "rpc", "--no-session", "--no-approve"]);
      let text = "";
      try {
        await client.request({ type: "get_state" });
        text = assistantText(await runTurn(client, "Say hello"));
      } finally { await client.close(); await provider.close(); }
      if (!observerLoaded(sandbox)) throw new CouldNotRun("the network observer did not load into Pi");
      const external = observedExternalAttempts(sandbox);
      if (text !== "SCRIPTED_REPLY_OK" || provider.requests.length !== 1) {
        return { status: "changed", observed: `Pi returned ${JSON.stringify(text.slice(0, 80))} after ${provider.requests.length} provider requests` };
      }
      if (external.length) return { status: "changed", observed: `Pi attempted non-loopback network with PI_OFFLINE=1: ${JSON.stringify(external.slice(0, 3))}` };
      if (!isolation.verified) throw new CouldNotRun("the turn completed, but network silence is unproven without a verified network namespace");
      return { status: "unchanged", observed: "one provider request, scripted reply relayed, no non-loopback attempt observed, inside the verified namespace" };
    })));
  statuses.push(await measure("PI_OFFLINE=1 and --offline suppress Pi's startup network activity", `${DOCS}#network-isolation`, async () => {
    if (!isolation.verified) throw new CouldNotRun("the online control run is only performed inside a verified network namespace");
    const attempts = async (label: string, args: string[], env: NodeJS.ProcessEnv, settleMs: number) => withSandbox(label, async sandbox => {
      // A dummy built-in-provider key, valid only inside this throwaway environment, makes Pi refresh its remote catalog.
      const client = launch(sandbox, ["--mode", "rpc", "--no-session", "--no-approve", ...args], { env: { ANTHROPIC_API_KEY: "wollipog-probe-dummy-key", ...env } });
      try {
        await client.request({ type: "get_state" });
        await client.request({ type: "get_available_models" });
        const deadline = Date.now() + settleMs;
        while (Date.now() < deadline && !observedExternalAttempts(sandbox).length) await new Promise(resolve => setTimeout(resolve, 250));
        if (!observedExternalAttempts(sandbox).length) await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
      } finally { await client.close(); }
      if (!observerLoaded(sandbox)) throw new CouldNotRun("the network observer did not load into Pi");
      return observedExternalAttempts(sandbox);
    });
    const online = await attempts("online", [], { PI_OFFLINE: undefined, PI_SKIP_VERSION_CHECK: undefined }, 10_000);
    if (!online.length) throw new CouldNotRun("the online control run made no network attempt, so suppression cannot be distinguished");
    const viaEnv = await attempts("offline-env", [], {}, 6000);
    const viaFlag = await attempts("offline-flag", ["--offline"], { PI_OFFLINE: undefined }, 6000);
    const hosts = (list: Json[]) => [...new Set(list.map(entry => `${entry.kind}:${entry.host}`))].join(", ");
    return outcome([
      ...(viaEnv.length ? [`PI_OFFLINE=1 still attempted ${hosts(viaEnv)}`] : []),
      ...(viaFlag.length ? [`--offline still attempted ${hosts(viaFlag)}`] : []),
    ], `online control attempted ${hosts(online)} (refused inside the namespace); PI_OFFLINE=1 and --offline attempted nothing`);
  }));
  return statuses;
}

// ---------------------------------------------------------------------------------------------
// RPC handshake and record shapes against fake-pi-rpc.mjs.

function seedUserResources(sandbox: PiSandbox): void {
  writeFixtureFile(join(sandbox.agentDir, "skills", USER_SKILL, "SKILL.md"),
    `---\nname: ${USER_SKILL}\ndescription: Probe skill used to measure command discovery.\n---\n\nProbe skill.\n`);
  writeFixtureFile(join(sandbox.agentDir, "prompts", `${USER_PROMPT}.md`), "---\ndescription: Probe prompt template\n---\nProbe prompt.\n");
}

interface DiscoveryExchange { events: Json[]; state: Json; models: Json; commands: Json; entries?: Json; selected: Json; levels: Json; ready: boolean }

/** Mirror probePiRpc (apps/runner/src/discovery/pi-rpc.ts) for one model. */
async function discoveryExchange(fake: boolean): Promise<DiscoveryExchange> {
  return withSandbox(fake ? "fake-discovery" : "discovery", async sandbox => {
    const provider = await startScriptedProvider(() => ({ text: "unused" }));
    writeProbeModels(sandbox, provider.port);
    seedUserResources(sandbox);
    writeFixtureFile(join(sandbox.project, ".pi", "settings.json"), "{}\n");
    const nonce = randomBytes(24).toString("base64url");
    const extension = writeFixtureFile(join(sandbox.root, "agent-control-probe.mjs"), piAgentControlProbeSource(nonce));
    const client = launch(sandbox, ["--extension", extension, "--mode", "rpc", "--no-session"], { fake, env: { [PI_AGENT_CONTROL_PROBE_NONCE_ENV]: nonce } });
    try {
      const [state, models, commands] = await Promise.all([
        client.request({ type: "get_state" }), client.request({ type: "get_available_models" }), client.request({ type: "get_commands" })]);
      const entries = await client.request({ type: "get_entries" }, 2000).catch(() => undefined);
      const first = (models.data?.models ?? [])[0] as Json | undefined;
      if (!first) throw new CouldNotRun("get_available_models returned no model to select");
      const selected = await client.request({ type: "set_model", provider: first.provider, modelId: first.id });
      const levels = await client.request({ type: "get_available_thinking_levels" });
      const ready = await client.waitFor(event => event.type === "extension_ui_request" && event.method === "setStatus" &&
        event.statusKey === PI_AGENT_CONTROL_PROBE_STATUS_KEY && event.statusText === nonce, 5000, "probe readiness").then(() => true, () => false);
      return { events: client.events, state, models, commands, entries, selected, levels, ready };
    } finally { await client.close(); await provider.close(); }
  });
}

function sessionReply(body: Json): ScriptedTurn {
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  return last?.role === "tool"
    ? { text: "Tool finished" }
    : { reasoning: "Reason carefully", text: "Hello from Pi", toolCalls: [{ name: "read", arguments: { path: "README.md" } }, { name: "bash", arguments: { command: "printf partial" } }] };
}

interface TrustLaunch { client: PiRpcClient; nonce: string }

/** Launch exactly as a verified ordinary driver session: the runner's Agent Control extension, its
 * readiness and security nonces, and no --no-approve unless asked for. */
function agentControlLaunch(sandbox: PiSandbox, extraArgs: string[], fake: boolean, scenario?: string, leading: string[] = []): TrustLaunch {
  const nonce = randomBytes(24).toString("base64url");
  const extension = writeFixtureFile(join(sandbox.root, "session.pi-agent-control.mjs"), piAgentControlExtensionSource());
  const stub = writeFixtureFile(join(sandbox.root, "agent-control-stub.mjs"), MCP_STUB);
  const client = launch(sandbox, [...leading, "-e", extension, "--mode", "rpc", ...extraArgs], { fake, env: {
    WOLLIPOG_PI_AGENT_CONTROL_COMMAND: process.execPath, WOLLIPOG_PI_AGENT_CONTROL_ARGS: JSON.stringify([stub]),
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: nonce, [PI_SECURITY_REQUEST_NONCE_ENV]: nonce,
    ...(scenario ? { WOLLIPOG_FAKE_PI_SCENARIO: scenario } : {}),
  } });
  return { client, nonce };
}

function trustEnvelope(event: Json, nonce: string): Json | undefined {
  const prefix = `${PI_SECURITY_REQUEST_TITLE}\n${PI_SECURITY_REQUEST_PREFIX}${nonce}.`;
  if (event.type !== "extension_ui_request" || event.method !== "select" || typeof event.title !== "string" || !event.title.startsWith(prefix)) return undefined;
  try { return JSON.parse(Buffer.from(event.title.slice(prefix.length), "base64url").toString("utf8")) as Json; } catch { return undefined; }
}

function confirmEnvelope(event: Json, nonce: string): Json | undefined {
  const prefix = `${PI_SECURITY_REQUEST_PREFIX}${nonce}.`;
  if (event.type !== "extension_ui_request" || event.method !== "confirm" || event.title !== PI_SECURITY_REQUEST_TITLE ||
    typeof event.message !== "string" || !event.message.startsWith(prefix)) return undefined;
  try { return JSON.parse(Buffer.from(event.message.slice(prefix.length), "base64url").toString("utf8")) as Json; } catch { return undefined; }
}

interface SessionExchange { events: Json[]; approvals: Json[]; toolOutput: string }

/** Mirror PiRpcDriver.initialize, one turn, and its checkpoint reads. Tool approvals are answered
 * as the driver does in bypassPermissions mode. */
async function sessionExchange(fake: boolean): Promise<SessionExchange> {
  return withSandbox(fake ? "fake-session" : "session", async sandbox => {
    const provider = await startScriptedProvider(sessionReply);
    writeProbeModels(sandbox, provider.port);
    writeFixtureFile(join(sandbox.project, ".pi", "settings.json"), "{}\n");
    writeFixtureFile(join(sandbox.project, "README.md"), "WOLLIPOG_PROBE_README\n");
    const { client, nonce } = agentControlLaunch(sandbox, [], fake, fake ? "startup-trust" : undefined);
    const approvals: Json[] = [];
    client.listen(event => {
      const payload = confirmEnvelope(event, nonce);
      if (!payload) return;
      approvals.push(payload);
      client.send({ type: "extension_ui_response", id: event.id, confirmed: true });
    });
    try {
      // The driver answers a trust request if one arrives; whether it does is measured by the trust group.
      const state = client.request({ type: "get_state" }, 30_000);
      const trust = await Promise.race([
        client.waitFor(event => trustEnvelope(event, nonce)?.kind === "project_trust", 30_000, "project_trust security request").catch(() => undefined),
        state.then(() => undefined, () => undefined),
      ]);
      if (trust) client.send({ type: "extension_ui_response", id: trust.id, value: "Skip Project Resources" });
      const established = await state;
      await client.waitFor(event => event.type === "extension_ui_request" && event.method === "setStatus" &&
        event.statusKey === PI_AGENT_CONTROL_STATUS_KEY && event.statusText === nonce, 30_000, "Agent Control readiness");
      const model = established.data?.model as Json | undefined;
      if (!model?.provider || !model.id) throw new CouldNotRun("get_state reported no active model");
      await client.request({ type: "set_model", provider: model.provider, modelId: model.id });
      await client.request({ type: "set_thinking_level", level: "low" });
      await runTurn(client, "Use a tool");
      const entries = await client.request({ type: "get_entries" });
      const firstId = entries.data?.entries?.[0]?.id;
      if (typeof firstId === "string") await client.request({ type: "get_entries", since: firstId });
      await client.request({ type: "get_session_stats" });
      // The scripted provider's second request carries the tool results back to the model.
      const toolOutput = (provider.requests[1]?.messages ?? []).filter((m: Json) => m?.role === "tool")
        .map((m: Json) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: Json) => p?.text ?? "").join("") : "")
        .join("\n");
      return { events: client.events, approvals, toolOutput };
    } finally { await client.close(); await provider.close(); }
  });
}

async function contractGroup(): Promise<PiProbeStatus[]> {
  const statuses: PiProbeStatus[] = [];
  let real: DiscoveryExchange | undefined;
  statuses.push(await measure("Discovery RPC handshake and model, thinking-level and command catalogs", "apps/runner/src/discovery/pi-rpc.ts", async () => {
    real = await discoveryExchange(false);
    const problems: string[] = [];
    for (const [name, response] of [["get_state", real.state], ["get_available_models", real.models], ["get_commands", real.commands],
      ["set_model", real.selected], ["get_available_thinking_levels", real.levels]] as const) {
      if (response.success !== true) problems.push(`${name} failed`);
    }
    const models = real.models.data?.models;
    if (!Array.isArray(models) || !models.some((m: Json) => m?.provider === PI_PROBE_MODEL.provider && m?.id === PI_PROBE_MODEL.id && typeof m?.name === "string")) {
      problems.push("get_available_models omitted the configured provider/id/name");
    }
    if (real.selected.data?.provider !== PI_PROBE_MODEL.provider || real.selected.data?.id !== PI_PROBE_MODEL.id) problems.push("set_model did not confirm provider/id in data");
    if (!Array.isArray(real.levels.data?.levels) || !real.levels.data.levels.every((l: unknown) => typeof l === "string")) problems.push("thinking levels are not a string array");
    if (real.state.data?.model?.provider !== PI_PROBE_MODEL.provider || typeof real.state.data?.thinkingLevel !== "string") problems.push("get_state lacks the active model or thinkingLevel");
    const commands = (real.commands.data?.commands ?? []) as Json[];
    const find = (name: string) => commands.find(c => c?.name === name);
    const expect = (name: string, source: string) => {
      const command = find(name);
      if (!command) problems.push(`get_commands omitted ${name}`);
      else if (command.source !== source) problems.push(`${name} reported source=${command.source}`);
    };
    expect(`skill:${USER_SKILL}`, "skill");
    expect(USER_PROMPT, "prompt");
    expect(PI_AGENT_CONTROL_PROBE_COMMAND, "extension");
    return outcome(problems, `handshake satisfied; skill:${USER_SKILL} source=skill, ${USER_PROMPT} source=prompt, probe command source=extension`);
  }));
  statuses.push(await measure("get_commands reports each command's location (user/project) read by commandSource()", "apps/runner/src/discovery/pi-rpc.ts", async () => {
    if (!real) throw new CouldNotRun("the discovery handshake did not run");
    const skill = ((real.commands.data?.commands ?? []) as Json[]).find(c => c?.name === `skill:${USER_SKILL}`);
    if (!skill) throw new CouldNotRun(`get_commands omitted skill:${USER_SKILL}`);
    return outcome(skill.location === "user" ? [] : [`a user skill reported location=${JSON.stringify(skill.location)} and sourceInfo.scope=${JSON.stringify(skill.sourceInfo?.scope)}; commandSource() can never classify a project command`],
      "user skill reported location=user");
  }));
  statuses.push(await measure("Discovery probe extension receives project_trust and reports readiness", "apps/runner/src/discovery/pi-rpc.ts", async () => {
    if (!real) throw new CouldNotRun("the discovery handshake did not run");
    return outcome(real.ready ? [] : ["the probe extension never reported readiness, so project_trust was not delivered before session_start"],
      "project_trust reached the CLI extension before session_start; readiness status and probe command observed");
  }));
  statuses.push(await measure("get_entries returns an empty entry list with leafId null under --no-session", "apps/runner/src/discovery/pi-rpc.ts", async () => {
    if (!real) throw new CouldNotRun("the discovery handshake did not run");
    const data = real.entries?.data;
    if (!real.entries) return { status: "changed", observed: "get_entries gave no response within 2 s; conversation fork would not be advertised" };
    const types = Array.isArray(data?.entries) ? data.entries.map((entry: Json) => String(entry?.type)) : [];
    return outcome(Array.isArray(data?.entries) && data.entries.length === 0 && data.leafId === null ? [] :
      [`get_entries returned ${types.length} startup entries (${types.join(", ")}) and leafId ${data?.leafId === null ? "null" : typeof data?.leafId}; discovery would not advertise conversation fork`],
      "entries=[], leafId=null; conversation fork stays advertised");
  }));
  let realSession: SessionExchange | undefined;
  statuses.push(await measure("Tool calls reach the driver as nonce-bound security confirms, and confirmed: true runs the tool", "apps/runner/src/drivers/pi-rpc.ts; apps/runner/src/pi-agent-control-extension.ts", async () => {
    realSession = await sessionExchange(false);
    const kinds = realSession.approvals.map(approval => approval?.kind);
    return outcome([
      ...(kinds.length === 2 && kinds.every(kind => kind === "tool_call") ? [] : [`the read and bash calls raised security confirms of kinds ${JSON.stringify(kinds)}`]),
      ...(realSession.toolOutput.includes("WOLLIPOG_PROBE_README") && realSession.toolOutput.includes("partial") ? [] : ["a confirmed tool did not return its output to the model"]),
    ], "one tool_call confirm per tool call (read, bash); confirmed: true ran both and their output reached the provider");
  }));
  statuses.push(await measure("RPC record shapes emitted by fake-pi-rpc.mjs match real Pi", "apps/runner/src/drivers/fixtures/fake-pi-rpc.mjs", async () => {
    if (!real || !realSession) throw new CouldNotRun("the real discovery or session exchange did not run");
    const [fakeDiscovery, fakeSession] = [await discoveryExchange(true), await sessionExchange(true)];
    const fixture = recordShapes([...fakeDiscovery.events, ...fakeSession.events]);
    const differences = compareShapes(fixture, recordShapes([...real.events, ...realSession.events]), FIXTURE_SHAPE_EXCEPTIONS);
    return outcome(differences.map(d => `fixture drift: ${d}`), `all ${fixture.size} fixture record kinds, fields, types and enum values were emitted by real Pi`);
  }));
  return statuses;
}

// ---------------------------------------------------------------------------------------------
// ADR 0010.

async function adrGroup(): Promise<PiProbeStatus[]> {
  const statuses: PiProbeStatus[] = [];
  const systemPrompt = (args: string[]) => withSandbox("append", async sandbox => {
    const provider = await startScriptedProvider(() => ({ text: "ok" }));
    writeProbeModels(sandbox, provider.port);
    const client = launch(sandbox, [...args, "--mode", "rpc", "--no-session", "--no-approve"]);
    try {
      await client.request({ type: "get_state" });
      await runTurn(client, "Say ok");
    } finally { await client.close(); await provider.close(); }
    if (!provider.requests.length) throw new CouldNotRun("Pi sent no provider request");
    return systemPromptOf(provider.requests[0]!);
  });
  statuses.push(await measure("Repeated --append-system-prompt values accumulate in order, joined by a blank line", ADR_0010, async () => {
    const prompt = await systemPrompt(["--append-system-prompt", "WOLLIPOG_PROBE_ALPHA", "--append-system-prompt", "WOLLIPOG_PROBE_BETA"]);
    const alpha = prompt.indexOf("WOLLIPOG_PROBE_ALPHA"), beta = prompt.indexOf("WOLLIPOG_PROBE_BETA");
    if (alpha < 0 || beta < 0) return { status: "changed", observed: `system prompt contained ${alpha < 0 ? "no ALPHA" : "ALPHA"} and ${beta < 0 ? "no BETA" : "BETA"}` };
    return outcome(prompt.includes("WOLLIPOG_PROBE_ALPHA\n\nWOLLIPOG_PROBE_BETA") ? [] :
      [`both values present but ${alpha < beta ? "not separated by exactly one blank line" : "in reverse order"}`], "both values reached the system prompt as ALPHA, blank line, BETA");
  }));
  // ADR 0010 measured 0.85.0 handing the = form to extensions; 1.4.0 (the recorded baseline) rejects it.
  statuses.push(await measure("--append-system-prompt=TEXT is rejected as an unknown option and never appends", ADR_0010, () =>
    withSandbox("append-equals", async sandbox => {
      const provider = await startScriptedProvider(() => ({ text: "ok" }));
      writeProbeModels(sandbox, provider.port);
      const client = launch(sandbox, ["--append-system-prompt=WOLLIPOG_PROBE_GAMMA", "--mode", "rpc", "--no-session", "--no-approve"]);
      try {
        const started = await client.request({ type: "get_state" }).then(() => true, () => false);
        if (!started) {
          await client.close();
          // Only the recognisable refusal counts; any other startup failure is not a measurement.
          if (client.exitCode !== 0 && /Unknown option: --append-system-prompt\b/.test(client.stderr)) {
            return { status: "unchanged" as const, observed: "Pi exited non-zero with \"Unknown option: --append-system-prompt\" before any RPC response" };
          }
          throw new CouldNotRun(`Pi did not answer get_state and exited ${String(client.exitCode)} without the unknown-option refusal`);
        }
        await runTurn(client, "Say ok");
      } finally { await client.close(); await provider.close(); }
      const prompt = provider.requests[0] ? systemPromptOf(provider.requests[0]) : "";
      return { status: "changed" as const, observed: prompt.includes("WOLLIPOG_PROBE_GAMMA")
        ? "the = form is now accepted and appends to the system prompt" : "the = form is accepted again without appending (the 0.85.0 behavior)" };
    })));
  statuses.push(await measure("An explicit -e extension loads under --no-extensions while discovered and built-in extensions do not", ADR_0010, () =>
    withSandbox("extensions", async sandbox => {
      writeProbeModels(sandbox, 9);
      writeFixtureFile(join(sandbox.agentDir, "extensions", "probe-user.js"), commandExtension("wollipog-probe-user-extension"));
      const explicit = writeFixtureFile(join(sandbox.root, "probe-explicit.mjs"), commandExtension("wollipog-probe-explicit-extension"));
      const commands = async (args: string[]) => {
        const client = launch(sandbox, [...args, "-e", explicit, "--mode", "rpc", "--no-session", "--no-approve"]);
        try {
          const response = await client.request({ type: "get_commands" });
          commandNames(response);
          return response.data.commands as Json[];
        } finally { await client.close(); }
      };
      const control = await commands([]);
      const builtins = control.filter(c => c?.sourceInfo?.source === "builtin").map(c => String(c.name));
      if (!control.some(c => c?.name === "wollipog-probe-user-extension") || !control.some(c => c?.name === "wollipog-probe-explicit-extension") || !builtins.length) {
        throw new CouldNotRun("without --no-extensions the user, explicit and built-in extensions did not all load, so the control failed");
      }
      const disabled = (await commands(["--no-extensions"])).map(c => String(c?.name));
      return outcome([
        ...(disabled.includes("wollipog-probe-explicit-extension") ? [] : ["the explicit -e extension did not load under --no-extensions"]),
        ...(disabled.includes("wollipog-probe-user-extension") ? ["a discovered user extension still loaded under --no-extensions"] : []),
        ...builtins.filter(name => disabled.includes(name)).map(name => `built-in extension command ${name} still loaded under --no-extensions`),
      ], `control loaded user, explicit and built-in (${builtins.join(", ")}) extensions; --no-extensions loaded only the explicit -e extension`);
    })));
  return statuses;
}

// ---------------------------------------------------------------------------------------------
// Session store, --session, --fork / --session-id.

export function expectedSessionDirectory(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

async function sessionsGroup(): Promise<PiProbeStatus[]> {
  const statuses: PiProbeStatus[] = [];
  await withSandbox("sessions", async sandbox => {
    const provider = await startScriptedProvider(() => ({ text: "Hello from Pi" }));
    writeProbeModels(sandbox, provider.port);
    const project = realpathSync(sandbox.project);
    const directory = expectedSessionDirectory(sandbox.agentDir, project);
    let source: { id: string; file: string; leaf: string } | undefined;
    const open = async (args: string[], cwd = project) => {
      const client = launch(sandbox, ["--mode", "rpc", "--no-approve", ...args], { cwd });
      const state = await client.request({ type: "get_state" }).catch(async error => { await client.close(); throw error; });
      return { client, id: state.data?.sessionId as unknown, file: state.data?.sessionFile as unknown };
    };
    try {
      statuses.push(await measure("Persistent sessions are stored as <agent-dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl with a session header", "apps/runner/src/external/parse.ts; apps/runner/src/execution-isolation.ts", async () => {
        const { client, id, file } = await open([]);
        let leaf: unknown;
        try {
          await runTurn(client, "Say hello");
          leaf = (await client.request({ type: "get_entries" })).data?.leafId;
        } finally { await client.close(); }
        if (typeof id !== "string" || typeof file !== "string" || typeof leaf !== "string") return { status: "changed", observed: "get_state/get_entries lacked sessionId, sessionFile or leafId" };
        source = { id, file, leaf };
        const problems: string[] = [];
        if (dirname(file) !== directory) problems.push(`session directory is ${dirname(file).replace(sandbox.home, "~")}, expected ${directory.replace(sandbox.home, "~")}`);
        if (!new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_${id.replace(/[^\w-]/g, "")}\\.jsonl$`).test(basename(file))) problems.push(`session file name ${basename(file)}`);
        if (!file.split(sep).join("/").includes("/.pi/agent/sessions/")) problems.push("session path lacks the .pi/agent/sessions segment");
        const header = existsSync(file) ? JSON.parse(readFileSync(file, "utf8").split("\n")[0] || "{}") as Json : undefined;
        if (header?.type !== "session" || header.id !== id) problems.push(`session header is ${JSON.stringify(header ?? "missing").slice(0, 120)}`);
        return outcome(problems, "~/.pi/agent/sessions/--<cwd with separators as ->--/<ISO timestamp>_<uuid>.jsonl, header {type: session, id}");
      }));
      statuses.push(await measure("--session <id> resumes the same session id, file and leaf", "apps/runner/src/drivers/pi-rpc.ts", async () => {
        if (!source) throw new CouldNotRun("no source session was established");
        const { client, id, file } = await open(["--session", source.id]);
        try {
          const leaf = (await client.request({ type: "get_entries" })).data?.leafId;
          return outcome([...(id === source.id ? [] : [`resumed id ${String(id)}`]), ...(file === source.file ? [] : ["resumed a different session file"]),
            ...(leaf === source.leaf ? [] : ["resumed leaf differs"])], "same id, file and leaf");
        } finally { await client.close(); }
      }));
      statuses.push(await measure("--fork <id> --session-id <uuid> creates an independent session with that id that keeps the source leaf", "apps/runner/src/drivers/pi-rpc.ts", async () => {
        if (!source) throw new CouldNotRun("no source session was established");
        const forkId = randomUUID();
        const { client, id, file } = await open(["--fork", source.id, "--session-id", forkId]);
        try {
          const entries = await client.request({ type: "get_entries", since: source.leaf });
          const problems: string[] = [];
          if (id !== forkId) problems.push(`fork reported id ${String(id)} instead of the --session-id value`);
          if (typeof file !== "string" || file === source.file) problems.push("fork reported no independent session file");
          else {
            if (!basename(file).endsWith(`_${forkId}.jsonl`) && basename(file) !== `${forkId}.jsonl`) problems.push(`fork file name ${basename(file)}`);
            if (dirname(file) !== directory) problems.push("fork file is outside the source's session directory");
            if (!existsSync(file)) problems.push("fork file does not exist");
          }
          if (entries.success !== true || entries.data?.leafId !== source.leaf) problems.push(`get_entries since the source leaf returned leafId ${String(entries.data?.leafId)}`);
          return outcome(problems, "fork used the requested id, wrote <timestamp>_<uuid>.jsonl beside the source and preserved the leaf");
        } finally { await client.close(); }
      }));
      statuses.push(await measure("A project sessionDir setting is ignored under --no-approve", "docs/pi-assumption-probes.md#session-store", async () => {
        const other = join(sandbox.root, "project-with-session-dir");
        writeFixtureFile(join(other, ".pi", "settings.json"), JSON.stringify({ sessionDir: "project-sessions" }));
        const cwd = realpathSync(other);
        const { client, file } = await open([], cwd);
        await client.close();
        if (typeof file !== "string") return { status: "changed", observed: "get_state reported no session file" };
        return outcome(file.startsWith(join(cwd, "project-sessions")) ? ["the repository's .pi/settings.json sessionDir chose the session location despite --no-approve"] : [],
          "the session stayed under the agent directory; the project sessionDir was not used");
      }));
    } finally { await provider.close(); }
  });
  return statuses;
}

// ---------------------------------------------------------------------------------------------
// project_trust delivery and --no-approve.

/** A CLI extension loaded ahead of the runner's that records each project_trust dispatch and
 * whether Pi offered it a UI, then defers (or decides, when given a decision). */
function trustRecorder(log: string, decision?: Json): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("project_trust", async (event, ctx) => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: event?.cwd, hasUI: ctx?.hasUI === true }) + "\\n");
    return ${decision ? JSON.stringify(decision) : '{ trusted: "undecided" }'};
  });
}
`;
}

function recordedTrust(log: string): Json[] {
  try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Json); } catch { return []; }
}

async function trustGroup(): Promise<PiProbeStatus[]> {
  const statuses: PiProbeStatus[] = [];
  const prepare = (sandbox: PiSandbox) => {
    writeProbeModels(sandbox, 9);
    writeFixtureFile(join(sandbox.project, ".pi", "extensions", "probe-project.js"), commandExtension(PROJECT_EXTENSION_COMMAND));
    return { project: realpathSync(sandbox.project), log: join(sandbox.root, "trust.log") };
  };
  statuses.push(await measure("project_trust reaches the driver as a nonce-bound security select that blocks startup", "apps/runner/src/drivers/pi-rpc.ts; apps/runner/src/pi-agent-control-extension.ts", () =>
    withSandbox("trust", async sandbox => {
      const { project, log } = prepare(sandbox);
      const recorder = writeFixtureFile(join(sandbox.root, "trust-recorder.mjs"), trustRecorder(log));
      const { client, nonce } = agentControlLaunch(sandbox, [], false, undefined, ["-e", recorder]);
      try {
        let stateResolved = false;
        const state = client.request({ type: "get_state" }, 30_000).then(value => { stateResolved = true; return value; });
        const request = await Promise.race([
          client.waitFor(event => trustEnvelope(event, nonce) !== undefined, 30_000, "project_trust security request").catch(() => undefined),
          state.then(() => undefined),
        ]);
        let blockedStartup = false;
        if (request) {
          await new Promise(resolve => setTimeout(resolve, 300));
          blockedStartup = !stateResolved;
          client.send({ type: "extension_ui_response", id: request.id, value: "Skip Project Resources" });
        }
        await state;
        const ready = await client.waitFor(event => event.type === "extension_ui_request" && event.method === "setStatus" &&
          event.statusKey === PI_AGENT_CONTROL_STATUS_KEY && event.statusText === nonce, 30_000, "Agent Control readiness").then(() => true, () => false);
        const names = commandNames(await client.request({ type: "get_commands" }));
        const dispatched = recordedTrust(log);
        if (!dispatched.length) return { status: "changed" as const, observed: "project_trust was never dispatched to CLI extensions for a project with .pi/extensions" };
        if (!request) {
          return { status: "changed" as const, observed: `project_trust was dispatched with hasUI=${dispatched[0]!.hasUI}; no security select reached the client, get_state answered and ` +
            `the project extension ${names.includes(PROJECT_EXTENSION_COMMAND) ? "loaded" : "was skipped"}, so a verified session can never ask to trust a project` };
        }
        const payload = trustEnvelope(request, nonce);
        const problems: string[] = [];
        if (payload?.kind !== "project_trust") problems.push("payload kind is not project_trust");
        if (payload?.cwd !== project) problems.push("payload cwd is not the canonical project directory");
        if (JSON.stringify(request.options) !== JSON.stringify(TRUST_OPTIONS)) problems.push(`options were ${JSON.stringify(request.options)}`);
        if (typeof request.id !== "string") problems.push("request has no string id");
        if (!blockedStartup) problems.push("get_state answered before the trust decision");
        if (!ready) problems.push("Agent Control readiness was not reported after the decision");
        if (names.includes(PROJECT_EXTENSION_COMMAND)) problems.push("Skip Project Resources still loaded the project extension");
        return outcome(problems, "select with the exact two options and canonical cwd held get_state until answered; Skip kept the project extension out");
      } finally { await client.close(); }
    })));
  statuses.push(await measure("A CLI extension's remembered yes loads project extensions and is saved in <agent-dir>/trust.json", "apps/runner/src/pi-agent-control-extension.ts", () =>
    withSandbox("trust-remember", async sandbox => {
      const { project, log } = prepare(sandbox);
      const decider = writeFixtureFile(join(sandbox.root, "trust-decider.mjs"), trustRecorder(log, { trusted: "yes", remember: true }));
      const names = async (args: string[]) => {
        const client = launch(sandbox, [...args, "--mode", "rpc", "--no-session"]);
        try { return commandNames(await client.request({ type: "get_commands" })); } finally { await client.close(); }
      };
      const decided = await names(["-e", decider]);
      if (!recordedTrust(log).length) throw new CouldNotRun("project_trust was not dispatched to the deciding extension");
      let store = "";
      try { store = readFileSync(join(sandbox.agentDir, "trust.json"), "utf8"); } catch { /* absent */ }
      const remembered = await names([]);
      return outcome([
        ...(decided.includes(PROJECT_EXTENSION_COMMAND) ? [] : ["the project extension did not load after the extension trusted the project"]),
        ...(store.includes(JSON.stringify(project).slice(1, -1)) ? [] : ["<agent-dir>/trust.json does not record the canonical project path"]),
        ...(remembered.includes(PROJECT_EXTENSION_COMMAND) ? [] : ["a later launch without the extension did not apply the remembered decision"]),
      ], "project extension loaded; trust.json recorded the canonical project path; a later launch applied it");
    })));
  statuses.push(await measure("--no-approve skips project resources without dispatching project_trust", "apps/runner/src/drivers/pi-rpc.ts", () =>
    withSandbox("trust-no-approve", async sandbox => {
      const { log } = prepare(sandbox);
      const recorder = writeFixtureFile(join(sandbox.root, "trust-recorder.mjs"), trustRecorder(log));
      const { client, nonce } = agentControlLaunch(sandbox, ["--no-approve"], false, undefined, ["-e", recorder]);
      try {
        await client.request({ type: "get_state" }, 30_000);
        const names = commandNames(await client.request({ type: "get_commands" }));
        return outcome([
          ...(recordedTrust(log).length || client.events.some(event => trustEnvelope(event, nonce)) ? ["project_trust was still dispatched under --no-approve"] : []),
          ...(names.includes(PROJECT_EXTENSION_COMMAND) ? ["the project extension loaded under --no-approve"] : []),
        ], "no project_trust dispatch, project extension absent");
      } finally { await client.close(); }
    })));
  return statuses;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const group = argv[argv.indexOf("--group") + 1];
  const isolation = await verifyNetworkIsolation();
  if (group === "isolation-check") { console.log(JSON.stringify({ event: "pi_isolation", ...isolation })); return isolation.verified ? 0 : 2; }
  const groups: Record<string, () => Promise<PiProbeStatus[]>> = {
    network: () => networkGroup(isolation), "rpc-contract": contractGroup, "adr-0010": adrGroup, sessions: sessionsGroup, "project-trust": trustGroup,
  };
  const run = group ? groups[group] : undefined;
  if (!run) throw new Error(`Usage: pi-assumptions-probe.ts --group ${Object.keys(groups).join("|")}|isolation-check`);
  return piProbeExit(await run());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, error => { console.error(errorText(error)); process.exitCode = 2; });
}
