/**
 * The wire between the manager policy hook sidecar and the runner that relays for it (#1472).
 *
 * In `provider` mode the provider runs as the runner's OS user and reaches the hook state
 * directory, so a credential kept there is a credential the provider has, and a circuit kept there
 * is one it can open. On a native Linux host the sidecar therefore holds nothing: it hands the hook
 * event to the session's abstract verdict socket, and the runner — which keeps the credential, its
 * acknowledgement, and the circuit in memory — performs the control-plane round trip and answers
 * with the hook response to print.
 *
 * A guard verdict changes nothing, so that socket answers anyone. A relayed hook event reaches the
 * control plane, so a request must carry the session's relay key. The key travels in the provider's
 * spawn environment, never in its argv: `/proc/<pid>/cmdline` is world-readable and
 * `/proc/<pid>/environ` is owner-only, which keeps another local user out. It does not keep the
 * provider out, and cannot: the provider starts the sidecar, so whatever the sidecar may ask, the
 * provider may ask.
 */

import { connect } from "node:net";
import type { ClaudeHookEventName } from "@wollipog/protocol";
import { managedWorktreeGuardSocketAddress } from "./managed-worktree-guard.js";

/** Present on every relayed hook command. Its presence is a commitment: the sidecar then asks the
 * runner and never reads a credential, acknowledgement, or circuit file, planted or not. */
export const POLICY_HOOK_RELAY_FLAG = "--policy-relay";
/** The session's abstract verdict socket. Absent from the document written to disk. */
export const POLICY_HOOK_RELAY_SOCKET_FLAG = "--policy-socket";
/** The relay key, in the provider's spawn environment. */
export const POLICY_HOOK_RELAY_KEY_ENV = "WOLLIPOG_POLICY_HOOK_RELAY_KEY";

const RELAY_REQUEST_VERSION = 1;
const MAX_RELAY_ANSWER_BYTES = 64 * 1024;

export interface PolicyHookRelayRequest {
  key: string;
  event: ClaudeHookEventName;
  /** The hook payload exactly as the provider wrote it to the sidecar's stdin. */
  input: string;
}

export function policyHookRelaySocketArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf(POLICY_HOOK_RELAY_SOCKET_FLAG);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

export function policyHookRelayRequest(request: PolicyHookRelayRequest): string {
  return JSON.stringify({ version: RELAY_REQUEST_VERSION, policyHook: request });
}

/**
 * The relay request inside a parsed socket message, `null` when the message is not one (the guard's
 * verdict request shares the socket), and a throw when it claims to be one and is malformed.
 */
export function parsePolicyHookRelayRequest(message: unknown): PolicyHookRelayRequest | null {
  if (!message || typeof message !== "object" || Array.isArray(message) || !("policyHook" in message)) return null;
  const { version, policyHook } = message as Record<string, unknown>;
  if (version !== RELAY_REQUEST_VERSION) throw new Error("unsupported relay request version");
  if (!policyHook || typeof policyHook !== "object" || Array.isArray(policyHook)) {
    throw new Error("relay request is not an object");
  }
  const { key, event, input } = policyHook as Record<string, unknown>;
  if (typeof key !== "string" || typeof input !== "string" ||
      (event !== "PreToolUse" && event !== "PostToolUse" && event !== "UserPromptSubmit")) {
    throw new Error("relay request has an unexpected shape");
  }
  return { key, event, input };
}

export function policyHookRelayAnswer(output: string): string {
  return JSON.stringify({ version: RELAY_REQUEST_VERSION, output });
}

function parsePolicyHookRelayAnswer(text: string): string {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("answer is not an object");
  const { version, output } = parsed as Record<string, unknown>;
  if (version !== RELAY_REQUEST_VERSION || typeof output !== "string") throw new Error("answer has an unexpected shape");
  return output;
}

/**
 * Hand one hook event to the runner and wait for the hook response to print. There is deliberately
 * no deadline on the answer: a `PreToolUse` ask parks for as long as a human takes, and the runner
 * holds the connection open meanwhile. A runner that exits closes it, which rejects, as does every
 * other failure; the caller turns a rejection into the event's fail-closed response.
 */
export function requestPolicyHookRelay(socketPath: string, request: PolicyHookRelayRequest): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(output!);
    };
    const socket = connect(managedWorktreeGuardSocketAddress(socketPath));
    // Newline-framed, and this side stays open until the answer: the runner can only learn that a
    // parked sidecar went away from a connection that has not already sent its FIN.
    socket.on("connect", () => socket.write(`${policyHookRelayRequest(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RELAY_ANSWER_BYTES) finish(new Error("the runner's answer is too large"));
      else chunks.push(chunk);
    });
    socket.on("end", () => {
      if (total === 0) {
        finish(new Error("the runner closed the connection without an answer"));
        return;
      }
      try {
        finish(null, parsePolicyHookRelayAnswer(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        finish(new Error(`the runner's answer is not a hook response: ${(error as Error).message}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the runner closed the connection without an answer")));
  });
}
