/** Narrow, per-agent compatibility handling for the shared ACP client (#4779).
 *
 * The shared client stays agent-neutral. A profile only removes ACP features an agent advertises
 * but that Wollipog must not use for it, and words its failures; it never adds behavior. Google
 * Antigravity (`agy acp`, verified with agy 1.5.14 on Linux) is the only profile:
 *
 * - Sign-in and sign-out belong to the machine's setup in Connections, which runs Google's remote
 *   `agy acp --login` in the same credential context as sessions. The advertised ACP auth methods
 *   include an API key and Application Default Credentials, which would change the account or
 *   billing a session uses, and `logout` would sign every session on the runner out of the shared
 *   OS-keyring sign-in. Neither is offered from a session.
 * - `session/load` of an id agy cannot read (an unknown id, or a conversation it could not persist)
 *   succeeds with an empty session, so it is never used: a load cannot prove that the conversation
 *   it returns is the one Wollipog recorded. `session/resume` fails cleanly in the same case.
 * - With runner-owned execution isolation (bwrap or Seatbelt) agy's state directory is read-only,
 *   so nothing it says is persisted and resume is not offered either (`resumable: false`).
 * - agy writes its diagnostic log to stderr when it cannot open its log file (read-only state
 *   again), and that log names the signed-in account. Its stderr is therefore never mirrored.
 * - Session listing is not offered: adopting a conversation started outside Wollipog would need
 *   `session/load`. */

import type { InitializeRequest } from "@agentclientprotocol/sdk";
import type { AcpNegotiation } from "./acp-contract.js";

export interface AcpCompatibility {
  profile: "antigravity";
  /** Whether this launch can persist the agent's conversations, so resume by id may be offered. */
  resumable: boolean;
  /** Variables the agent's explicit environment may never carry, whatever layer added them (an
   * approved worktree setup environment, say): the agent's credential context drops them from the
   * inherited environment, and this keeps them out of the one the launch supplies. */
  withheldEnvironment?: { names: readonly string[]; prefixes: readonly string[] };
  /** Values the agent's credential context requires, applied after every other layer, so a worktree
   * setup environment cannot override them (the managed copy's `AGY_CLI_DISABLE_AUTO_UPDATE`). */
  pinnedEnvironment?: Readonly<Record<string, string>>;
  /** Bounds for the handshake and for opening or resuming the session: a process that never
   * answers fails the launch with the profile's error instead of leaving it starting. */
  deadlines?: { handshakeMs: number; sessionMs: number };
  /** What the launch runs, asked at the moment the client spawns it rather than when the launch was
   * prepared: an update can replace the executable while preparation awaits. The answer's command
   * and pinned values replace the prepared ones; null refuses the launch with the start failure,
   * and nothing is spawned. */
  resolveLaunch?: () => { command: string; pinnedEnvironment?: Readonly<Record<string, string>> } | null;
}

/** A launch the profile refused when it was about to spawn (nothing verified to run). Its message
 * is the profile's start failure. */
export class AcpLaunchRefusedError extends Error {
  override readonly name = "AcpLaunchRefusedError";
}

/** The command and profile a launch spawns with: `resolveLaunch`'s answer when the profile has one.
 * Throws `AcpLaunchRefusedError` when it answers that nothing may run. */
export function resolveAcpLaunch(
  command: string,
  compatibility: AcpCompatibility | undefined,
): { command: string; compatibility: AcpCompatibility | undefined } {
  const resolve = compatibility?.resolveLaunch;
  if (!compatibility || !resolve) return { command, compatibility };
  const target = resolve();
  if (!target) throw new AcpLaunchRefusedError(acpCompatibilityFailure(compatibility, "start"));
  const { pinnedEnvironment: _prepared, ...profile } = compatibility;
  const pinned = target.pinnedEnvironment && Object.keys(target.pinnedEnvironment).length
    ? { pinnedEnvironment: { ...target.pinnedEnvironment } } : {};
  return { command: target.command, compatibility: { ...profile, ...pinned } };
}

/** Whether the client's `fs/write_text_file` service is offered. A profiled agent never gets it: the
 * runner performs those writes itself, outside the agent's sandbox, where a managed worktree's
 * read-only registration files are not read-only. agy 1.5.14 writes files with its own tools,
 * inside its sandbox, so it does not need the service. */
export function acpClientFileWritesOffered(compatibility?: AcpCompatibility): boolean {
  return !compatibility;
}

/** The initialize request a profiled agent receives: the shared one, without the write service. */
export function compatibleAcpInitializeRequest(request: InitializeRequest, compatibility?: AcpCompatibility): InitializeRequest {
  if (acpClientFileWritesOffered(compatibility)) return request;
  const fs = request.clientCapabilities?.fs;
  return { ...request, clientCapabilities: { ...request.clientCapabilities, fs: { ...fs, writeTextFile: false } } };
}

/** JSON-RPC options bounding one launch request, for a profile that sets deadlines. */
export function acpLaunchRequestOptions(
  compatibility: AcpCompatibility | undefined,
  stage: "handshake" | "session",
  now: () => number = Date.now,
): { deadlineAt?: number } {
  const deadlines = compatibility?.deadlines;
  if (!deadlines) return {};
  return { deadlineAt: now() + (stage === "handshake" ? deadlines.handshakeMs : deadlines.sessionMs) };
}

/** Whether a JSON-RPC failure is a request that hit its deadline. */
export function acpRequestTimedOut(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { requestTimeout?: unknown }).requestTimeout === true;
}

/** The explicit launch environment without the variables the profile withholds. */
export function compatibleAcpEnvironment(env: Record<string, string>, compatibility?: AcpCompatibility): Record<string, string> {
  const withheld = compatibility?.withheldEnvironment;
  const filtered = withheld
    ? Object.fromEntries(Object.entries(env).filter(([name]) =>
      !withheld.names.includes(name) && !withheld.prefixes.some((prefix) => name.startsWith(prefix))))
    : env;
  // The credential context's own values win over every layer (the managed copy's updater switch).
  return compatibility?.pinnedEnvironment ? { ...filtered, ...compatibility.pinnedEnvironment } : filtered;
}

const AGENT_NAME = { antigravity: "Google Antigravity" } as const;

/** The negotiated capabilities this launch may use: the advertised ones less the features the
 * profile withholds. Without a profile the negotiation is returned unchanged. */
export function compatibleAcpNegotiation(negotiation: AcpNegotiation, compatibility?: AcpCompatibility): AcpNegotiation {
  if (!compatibility) return negotiation;
  return {
    ...negotiation,
    authMethods: [],
    stable: {
      ...negotiation.stable,
      logout: false,
      loadSession: false,
      sessionList: false,
      sessionResume: negotiation.stable.sessionResume && compatibility.resumable,
    },
  };
}

/** Whether the agent's stderr may enter the transcript. */
export function acpStderrMirrored(compatibility?: AcpCompatibility): boolean {
  return !compatibility;
}

/** The status a profiled agent's failure shows, so installation, sign-in and turn failures read
 * differently. Undefined without a profile: the shared client keeps its own wording. */
export function acpCompatibilityFailure(
  compatibility: AcpCompatibility | undefined,
  stage: "start" | "sign_in" | "resume" | "turn",
  detail?: string,
): string | undefined {
  if (!compatibility) return undefined;
  const name = AGENT_NAME[compatibility.profile];
  switch (stage) {
    case "start":
      return `${name} could not be started on this machine. Check its setup in Connections.`;
    case "sign_in":
      return `${name} needs sign-in on this machine. Sign in from Connections, then try again.`;
    case "resume":
      return `${name} could not resume this conversation, so its history here is read-only. Start a new session to continue.`;
    case "turn": {
      const full = detail ? redactAccountIdentifiers(detail).replace(/\s+/gu, " ").trim() : "";
      // Bounded, and visibly cut rather than ending mid-word.
      const reason = full.length > TURN_DETAIL_LIMIT ? `${full.slice(0, TURN_DETAIL_LIMIT - 1).trimEnd()}…` : full;
      return reason ? `${name} could not complete this turn: ${reason}` : `${name} could not complete this turn.`;
    }
  }
}

const TURN_DETAIL_LIMIT = 300;
const EMAIL =/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/** Agent text with email-shaped account identifiers removed. */
export function redactAccountIdentifiers(text: string): string {
  return text.replace(EMAIL, "[account]");
}
