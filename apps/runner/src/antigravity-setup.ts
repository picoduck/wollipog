/** Google Antigravity setup on this runner (protocol v403, Refs #4780).
 *
 * Checks the installed `agy` CLI, verifies the runner's sign-in by opening (and immediately
 * discarding) an ACP session in a private empty directory, and supervises Google's remote
 * `agy acp --login` paste-code sign-in. Wollipog never installs or updates `agy`.
 *
 * Everything here runs in one credential context (`antigravityCredentialContext`), so setup,
 * readiness checks and, once Antigravity sessions exist (#4779), session launch see the same
 * account. Antigravity keeps its sign-in in the OS keyring of the runner's user, which every
 * process of that user shares, so the context is a shared sign-in, never a per-account one.
 *
 * The CLI's sign-in output, exit codes and session errors are undocumented. They are verified
 * here only against credential-free fixtures, so every unrecognized outcome fails closed to
 * `sign_in_required` or `verification_failed`; nothing but a confirmed session reports `ready`. */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AntigravitySetupFailure,
  AntigravitySetupView,
  AntigravitySignInFailure,
  AntigravitySignInView,
} from "@wollipog/protocol";
import { ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES, safeAntigravitySignInUrl } from "@wollipog/protocol";
import { acpInitializeRequest, negotiateAcpInitialize } from "./acp-contract.js";
import { isAgentAuthRequiredError } from "./acp.js";
import { normalizeAcpConfigOptions, optionForCategory } from "./acp-session-state.js";
import { resolveNative } from "./discovery/resolve.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { killTreeAndWait, spawnAgent, type AgentProcess } from "./spawn.js";

/** Ambient settings that would let the CLI pick another account or billing route than the
 * runner's own Google sign-in: an API key (with `modelProvider: gemini`), a custom endpoint, or
 * Application Default Credentials and their Cloud project. */
export const ANTIGRAVITY_AMBIENT_CREDENTIAL_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "AGY_ADC_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
] as const;
export const ANTIGRAVITY_AMBIENT_CREDENTIAL_PREFIXES = ["GOOGLE_CLOUD_"] as const;

/** How every Antigravity process on this runner is launched. `scrubInheritedEnv` is passed to
 * `spawnAgent`, which also drops the runner's own credentials. */
export interface AntigravityCredentialContext {
  env: Record<string, string>;
  scrubInheritedEnv: string[];
  credentialStore: "shared_os_keyring";
}

/** The one credential context for setup, readiness checks and (with #4779) session launch: the
 * runner user's own HOME and OS keyring, without ambient credentials. Windows matches names in any
 * case; this runs only on Linux and macOS (see `antigravitySetupPlatformSupported`). */
export function antigravityCredentialContext(inherited: NodeJS.ProcessEnv = process.env): AntigravityCredentialContext {
  const prefixed = Object.keys(inherited).filter((name) =>
    ANTIGRAVITY_AMBIENT_CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix)));
  return {
    env: {},
    scrubInheritedEnv: [...new Set([...ANTIGRAVITY_AMBIENT_CREDENTIAL_ENV, ...prefixed])],
    credentialStore: "shared_os_keyring",
  };
}

/** Setup from Connections supports native Linux and macOS runners. Windows paths, shims and its
 * credential store have not been verified, so they keep the terminal setup. */
export function antigravitySetupPlatformSupported(platform: NodeJS.Platform): boolean {
  return platform === "linux" || platform === "darwin";
}

const VERSION_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_LINK_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 64 * 1024;
const CODE_LIMIT = 4_096;
const MODEL_LIMIT = 64;
// A link counts only once a terminator follows it: output arrives in chunks, and a link cut at a
// chunk's end is still a valid URL, just the wrong one.
const COMPLETE_URL_PATTERN = /https:\/\/[^\s<>"'\u0000-\u001f\u007f]+(?=[\s<>"'\u0000-\u001f\u007f])/giu;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]/gu;
const VERSION_PATTERN = /(?:^|[^0-9A-Za-z.])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+_-]+)?)/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Outcome of the access check. `models` is set only for `ready`. */
export type AntigravityAccessResult =
  | { status: "ready"; models: Array<{ id: string; name: string }> }
  | { status: "sign_in_required" }
  | { status: "verification_failed"; failure: AntigravitySetupFailure };

export interface AntigravityProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  context: AntigravityCredentialContext;
  spawn: typeof spawnAgent;
}

function launch(options: AntigravityProcessOptions): AgentProcess {
  return options.spawn({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.context.env,
    scrubInheritedEnv: options.context.scrubInheritedEnv,
    windowsShell: false,
  });
}

/** Text without its escape sequences. An escape still arriving at the end (a chunk cut after ESC
 * or inside a CSI) is dropped with everything after it, so it can neither show nor end a link:
 * the rest of the link arrives with the sequence's remainder. */
function stripAnsi(value: string): string {
  const stripped = value.replace(ANSI_ESCAPE_PATTERN, "");
  const incompleteOsc = stripped.indexOf("\u001b]");
  const complete = incompleteOsc < 0 ? stripped : stripped.slice(0, incompleteOsc);
  return complete.replace(/(?:\u001b(?:\[[0-?]*[ -/]*)?|\u009b[0-?]*[ -/]*)$/u, "");
}

/** The version `agy --version` printed, or undefined when it printed nothing recognizable. */
export function parseAntigravityVersion(output: string): string | undefined {
  const match = stripAnsi(output.slice(0, 4_096)).match(VERSION_PATTERN)?.[1];
  return match && match.length <= 64 ? match : undefined;
}

/** The first complete, credential-free HTTPS link in sign-in output, trimmed of trailing
 * punctuation. A link still at the end of the output may be cut short, so it is not one yet. */
export function parseAntigravitySignInUrl(output: string): string | undefined {
  for (const candidate of stripAnsi(output).match(COMPLETE_URL_PATTERN) ?? []) {
    const trimmed = candidate.replace(/[),.;]+$/u, "");
    if (safeAntigravitySignInUrl(trimmed)) return trimmed;
  }
  return undefined;
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !CONTROL.test(value) ? value : undefined;
}

/** The models an ACP `session/new` response advertises: the stable `model` select config option,
 * else the session model state some agents send. Bounded and deduplicated. */
export function advertisedAntigravityModels(response: unknown): Array<{ id: string; name: string }> {
  const models: Array<{ id: string; name: string }> = [];
  const ids = new Set<string>();
  const add = (rawId: unknown, rawName: unknown) => {
    const id = boundedText(rawId, 256);
    if (!id || ids.has(id) || models.length >= MODEL_LIMIT) return;
    ids.add(id);
    // A nameless model is shown by its id, cut to the 160 characters a name may have.
    models.push({ id, name: boundedText(rawName, 160) ?? (id.length <= 160 ? id : `${id.slice(0, 159)}…`) });
  };
  const value = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const option = optionForCategory(normalizeAcpConfigOptions(value.configOptions), "model");
  if (option) {
    for (const candidate of option.options) add(candidate.value, candidate.name);
    return models;
  }
  const state = value.models && typeof value.models === "object" ? value.models as Record<string, unknown> : {};
  if (Array.isArray(state.availableModels)) {
    for (const candidate of state.availableModels) {
      if (candidate && typeof candidate === "object") {
        const model = candidate as Record<string, unknown>;
        add(model.modelId, model.name);
      }
    }
  }
  return models;
}

/** Run `agy --version`. Undefined `version` with `ok` means it exited successfully but printed no
 * recognizable version. */
export async function checkAntigravityVersion(
  options: AntigravityProcessOptions & { kill: typeof killTreeAndWait; timeoutMs?: number },
): Promise<{ ok: true; version?: string } | { ok: false; failure: AntigravitySetupFailure }> {
  let child: AgentProcess;
  try { child = launch({ ...options, args: [...options.args, "--version"] }); }
  catch { return { ok: false, failure: "version_check_failed" }; }
  let output = "";
  const capture = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(0, OUTPUT_LIMIT); };
  child.stdout.on("data", capture);
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<number | "timeout" | "error">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? VERSION_TIMEOUT_MS);
    child.once("error", () => resolve("error"));
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    await options.kill(child).catch(() => false);
    return { ok: false, failure: "timed_out" };
  }
  if (outcome !== 0) return { ok: false, failure: "version_check_failed" };
  const version = parseAntigravityVersion(output);
  return version ? { ok: true, version } : { ok: true };
}

/** Verify access: ACP initialize, then `session/new` in `cwd` (a private empty directory) with no
 * prompt. The process is terminated right after, which discards the session. An authentication
 * error means the sign-in is missing or expired; anything else that is not a session with at least
 * one advertised model fails verification. */
export async function checkAntigravityAccess(
  options: AntigravityProcessOptions & { kill: typeof killTreeAndWait; handshakeTimeoutMs?: number; sessionTimeoutMs?: number; now?: () => number },
): Promise<AntigravityAccessResult> {
  const now = options.now ?? Date.now;
  let child: AgentProcess;
  try { child = launch({ ...options, args: [...options.args, "acp"] }); }
  catch { return { status: "verification_failed", failure: "handshake_failed" }; }
  const peer = new JsonRpcPeer(child.stdin, child.stdout);
  child.stderr.resume();
  child.once("error", () => peer.dispose("Antigravity could not be started"));
  child.once("close", () => peer.dispose("Antigravity exited"));
  try {
    try {
      const initialize = await peer.request("initialize", acpInitializeRequest() as unknown as Record<string, unknown>,
        { deadlineAt: now() + (options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS), failOnDiscardedRecord: true });
      negotiateAcpInitialize(initialize);
    } catch (error) {
      return { status: "verification_failed", failure: timedOut(error) ? "timed_out" : "handshake_failed" };
    }
    let response: unknown;
    try {
      response = await peer.request("session/new", { cwd: options.cwd, mcpServers: [] },
        { deadlineAt: now() + (options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS) });
    } catch (error) {
      if (isAgentAuthRequiredError(error)) return { status: "sign_in_required" };
      return { status: "verification_failed", failure: timedOut(error) ? "timed_out" : "session_check_failed" };
    }
    const sessionId = response && typeof response === "object" ? (response as { sessionId?: unknown }).sessionId : undefined;
    const models = advertisedAntigravityModels(response);
    if (!boundedText(sessionId, 1_024) || models.length === 0) {
      return { status: "verification_failed", failure: "session_check_failed" };
    }
    return { status: "ready", models };
  } finally {
    peer.dispose("Antigravity access check finished");
    await options.kill(child).catch(() => false);
  }
}

function timedOut(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { requestTimeout?: unknown }).requestTimeout === true;
}

interface ActiveSignIn {
  view: AntigravitySignInView;
  child: AgentProcess;
  /** Output per stream, kept only until the link is found: each stream frames its own lines. */
  output: { stdout: string; stderr: string };
  /** The link was published. Output is never read again, so nothing printed after it (such as a
   * diagnostic that echoes the submitted code) can be published or reopen the code step. */
  linkPublished: boolean;
  timer: ReturnType<typeof setTimeout>;
  linkTimer?: ReturnType<typeof setTimeout>;
  codeSubmitted: boolean;
  ended: boolean;
}

export interface AntigravitySetupSupervisorOptions {
  /** Runner data directory; private scratch directories are created under it. */
  dataDir: string;
  onUpdate: (setup: AntigravitySetupView) => void;
  platform?: NodeJS.Platform;
  inheritedEnv?: NodeJS.ProcessEnv;
  resolveExecutable?: () => Promise<string | null>;
  spawn?: typeof spawnAgent;
  kill?: typeof killTreeAndWait;
  now?: () => number;
  signInTimeoutMs?: number;
  signInLinkTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  sessionTimeoutMs?: number;
  versionTimeoutMs?: number;
}

/** Owns this runner's Antigravity setup: one check and at most one sign-in at a time. */
export class AntigravitySetupSupervisor {
  private view: AntigravitySetupView;
  private checking: Promise<AntigravitySetupView> | null = null;
  private signIn: ActiveSignIn | null = null;
  private stopped = false;
  private readonly spawn: typeof spawnAgent;
  private readonly kill: typeof killTreeAndWait;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: AntigravitySetupSupervisorOptions) {
    this.spawn = options.spawn ?? spawnAgent;
    this.kill = options.kill ?? killTreeAndWait;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.view = { version: 1, status: "checking", checkedAt: this.now(), credentialStore: "shared_os_keyring" };
  }

  current(): AntigravitySetupView {
    return structuredClone(this.view);
  }

  credentialContext(): AntigravityCredentialContext {
    return antigravityCredentialContext(this.options.inheritedEnv ?? process.env);
  }

  /** Check the runtime and its sign-in. Concurrent calls share one check. While a sign-in runs, the
   * sign-in's own verification decides, so the current setup is returned unchanged. */
  check(): Promise<AntigravitySetupView> {
    if (this.stopped) return Promise.resolve(this.current());
    if (this.signIn && !this.signIn.ended) return Promise.resolve(this.current());
    if (!this.checking) {
      this.checking = this.runCheck().finally(() => { this.checking = null; });
    }
    return this.checking;
  }

  /** Start Google's remote sign-in. Requires a found runtime and no other sign-in or check. */
  startSignIn(): AntigravitySetupView {
    if (this.stopped) throw new Error("The runner is shutting down.");
    if (this.signIn && !this.signIn.ended) throw new Error("A Google Antigravity sign-in is already running on this machine.");
    if (this.checking) throw new Error("Google Antigravity is being checked. Try again when the check finishes.");
    const executable = this.view.executable?.path;
    if (!executable || this.view.status === "missing_runtime" || this.view.status === "unsupported") {
      throw new Error("Google Antigravity is not installed on this machine. Install it, then check again.");
    }
    const operationId = `agy_login_${randomUUID()}`;
    const view: AntigravitySignInView = { operationId, status: "starting", startedAt: this.now() };
    let child: AgentProcess;
    try {
      const cwd = this.scratchRoot();
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      child = launch({ command: executable, args: ["acp", "--login"], cwd,
        context: this.credentialContext(), spawn: this.spawn });
    } catch {
      throw new Error("The Google Antigravity sign-in command could not be started.");
    }
    const active: ActiveSignIn = {
      view,
      child,
      output: { stdout: "", stderr: "" },
      linkPublished: false,
      codeSubmitted: false,
      ended: false,
      timer: setTimeout(() => this.endSignIn(active, "timed_out"), this.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS),
    };
    active.timer.unref?.();
    active.linkTimer = setTimeout(() => {
      if (!active.linkPublished) this.endSignIn(active, "failed", "link_unavailable");
    }, this.options.signInLinkTimeoutMs ?? SIGN_IN_LINK_TIMEOUT_MS);
    active.linkTimer.unref?.();
    this.signIn = active;
    // Output is read only until the link appears, stays in memory and bounded, and is never logged,
    // published or retained. After the link, both streams are drained unread.
    child.stdout.on("data", (chunk: Buffer) => this.capture(active, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.capture(active, "stderr", chunk));
    child.stdin.on("error", () => {
      if (!active.ended && active.view.status === "awaiting_code") this.endSignIn(active, "failed", "input_closed");
    });
    child.once("error", () => this.endSignIn(active, "failed", "not_completed"));
    child.once("close", (code) => { void this.settleSignIn(active, code); });
    this.view = { ...this.view, signIn: view };
    this.publish();
    return this.current();
  }

  /** Write the authorization code to the waiting sign-in command. The code is never retained. */
  submitCode(operationId: string, code: string): AntigravitySetupView {
    const active = this.signIn;
    if (!active || active.ended || active.view.operationId !== operationId || active.view.status !== "awaiting_code") {
      throw new Error("This sign-in is not waiting for an authorization code.");
    }
    const normalized = code.trim();
    if (!normalized || normalized.length > CODE_LIMIT || /[\u0000\r\n]/u.test(normalized)) {
      throw new Error("The authorization code must be a single line of 1 to 4096 characters.");
    }
    if (active.child.stdin.destroyed || active.child.stdin.writableEnded) {
      this.endSignIn(active, "failed", "input_closed");
      throw new Error("The sign-in command is no longer accepting an authorization code.");
    }
    try {
      active.child.stdin.write(`${normalized}\n`);
    } catch {
      this.endSignIn(active, "failed", "input_closed");
      throw new Error("The sign-in command is no longer accepting an authorization code.");
    }
    active.codeSubmitted = true;
    this.updateSignIn(active, { operationId, status: "waiting_for_provider", startedAt: active.view.startedAt });
    return this.current();
  }

  cancelSignIn(operationId: string): AntigravitySetupView {
    const active = this.signIn;
    if (!active || active.view.operationId !== operationId) throw new Error("This sign-in was not found.");
    if (active.ended) {
      this.publish();
      throw new Error("This sign-in is no longer running.");
    }
    this.endSignIn(active, "cancelled");
    return this.current();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.signIn && !this.signIn.ended) this.endSignIn(this.signIn, "cancelled");
  }

  private async runCheck(): Promise<AntigravitySetupView> {
    const signIn = this.view.signIn;
    const base = { version: 1 as const, credentialStore: "shared_os_keyring" as const, ...(signIn ? { signIn } : {}) };
    this.view = { ...base, status: "checking", checkedAt: this.now(), ...(this.view.executable ? { executable: this.view.executable } : {}) };
    this.publish();
    if (!antigravitySetupPlatformSupported(this.platform)) {
      return this.settleCheck({ ...base, status: "unsupported", failure: "unsupported_platform", checkedAt: this.now() });
    }
    const path = await (this.options.resolveExecutable ?? defaultResolveExecutable)().catch(() => null);
    if (!path) return this.settleCheck({ ...base, status: "missing_runtime", checkedAt: this.now() });
    const versioned = await checkAntigravityVersion({ command: path, args: [], cwd: this.options.dataDir,
      context: this.credentialContext(), spawn: this.spawn, kill: this.kill, timeoutMs: this.options.versionTimeoutMs });
    if (!versioned.ok) {
      return this.settleCheck({ ...base, status: "verification_failed", failure: versioned.failure,
        executable: { path }, checkedAt: this.now() });
    }
    const executable = { path, ...(versioned.version ? { version: versioned.version } : {}) };
    const access = await this.checkAccess(path);
    if (access.status === "ready") {
      return this.settleCheck({ ...base, status: "ready", executable, models: access.models, checkedAt: this.now() });
    }
    return this.settleCheck({ ...base, status: access.status, executable,
      ...(access.status === "verification_failed" ? { failure: access.failure } : {}), checkedAt: this.now() });
  }

  private async checkAccess(path: string): Promise<AntigravityAccessResult> {
    let scratch: string | undefined;
    try {
      const root = this.scratchRoot();
      await mkdir(root, { recursive: true, mode: 0o700 });
      scratch = await mkdtemp(join(root, "check-"));
    } catch {
      return { status: "verification_failed", failure: "session_check_failed" };
    }
    try {
      return await checkAntigravityAccess({ command: path, args: [], cwd: scratch, context: this.credentialContext(),
        spawn: this.spawn, kill: this.kill, now: this.now,
        handshakeTimeoutMs: this.options.handshakeTimeoutMs, sessionTimeoutMs: this.options.sessionTimeoutMs });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Runner-private directory the sign-in runs in and access checks make their empty folders in. */
  private scratchRoot(): string {
    return join(this.options.dataDir, "antigravity-setup");
  }

  private settleCheck(view: AntigravitySetupView): AntigravitySetupView {
    // A sign-in's progress during the check is newer than the check's copy of it.
    const { signIn: _stale, ...rest } = view;
    this.view = { ...rest, ...(this.view.signIn ? { signIn: this.view.signIn } : {}) };
    this.publish();
    return this.current();
  }

  private capture(active: ActiveSignIn, stream: "stdout" | "stderr", chunk: Buffer): void {
    if (active.ended || active.linkPublished || active.view.status !== "starting") return;
    active.output[stream] = `${active.output[stream]}${chunk.toString("utf8")}`.slice(-OUTPUT_LIMIT);
    const verificationUrl = parseAntigravitySignInUrl(active.output[stream]);
    if (!verificationUrl) return;
    active.linkPublished = true;
    active.output = { stdout: "", stderr: "" };
    if (active.linkTimer) clearTimeout(active.linkTimer);
    this.updateSignIn(active, { operationId: active.view.operationId, status: "awaiting_code",
      startedAt: active.view.startedAt, verificationUrl });
  }

  /** The sign-in command exited. Only a successful exit followed by a confirmed session check
   * reports success; the check's result becomes the setup either way. */
  private async settleSignIn(active: ActiveSignIn, code: number | null): Promise<void> {
    if (active.ended) return;
    if (code !== 0) {
      this.endSignIn(active, "failed", "not_completed");
      return;
    }
    this.clearTimers(active);
    this.updateSignIn(active, { operationId: active.view.operationId, status: "verifying", startedAt: active.view.startedAt });
    active.ended = true;
    const setup = await this.check();
    if (this.signIn !== active) return;
    const succeeded = setup.status === "ready";
    this.updateSignIn(active, {
      operationId: active.view.operationId,
      status: succeeded ? "succeeded" : "failed",
      startedAt: active.view.startedAt,
      ...(succeeded ? {} : { failure: "not_verified" as const }),
    });
  }

  private endSignIn(active: ActiveSignIn, status: "failed" | "cancelled" | "timed_out", failure?: AntigravitySignInFailure): void {
    if (active.ended) return;
    active.ended = true;
    active.output = { stdout: "", stderr: "" };
    this.clearTimers(active);
    this.updateSignIn(active, { operationId: active.view.operationId, status, startedAt: active.view.startedAt,
      ...(failure ? { failure } : {}) });
    void this.kill(active.child).catch(() => false);
  }

  private clearTimers(active: ActiveSignIn): void {
    clearTimeout(active.timer);
    if (active.linkTimer) clearTimeout(active.linkTimer);
  }

  private updateSignIn(active: ActiveSignIn, view: AntigravitySignInView): void {
    active.view = view;
    if (this.signIn !== active) return;
    this.view = { ...this.view, signIn: view };
    this.publish();
  }

  private publish(): void {
    this.options.onUpdate(this.current());
  }
}

/** Whether a sign-in is still running. */
export function antigravitySignInActive(view: AntigravitySetupView): boolean {
  return !!view.signIn && ANTIGRAVITY_SIGN_IN_ACTIVE_STATUSES.includes(view.signIn.status);
}

async function defaultResolveExecutable(): Promise<string | null> {
  return (await resolveNative("agy"))?.path ?? null;
}
