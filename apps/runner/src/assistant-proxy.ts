/**
 * Runner-side MCP proxy for Wollipog Assistant threads (#4663).
 *
 * An Assistant thread's session reaches the control plane's `/assistant/mcp` only through this
 * proxy. The thread credential is minted here, kept in this process's memory and never written
 * to a file, an environment variable, a process argument or the session's transcript: the agent
 * has a shell, so anything it can read it could exfiltrate. The control plane receives only the
 * credential's SHA-256 and binds it to the thread's Assistant connection with a short expiry.
 *
 * The agent side is a stdio adapter (`--assistant-mcp`) holding a per-session relay key. The key
 * authorizes forwarding MCP requests for this one session to this one path, which is exactly the
 * tool access the session already has, and confers no credential. Every call is authorized live by
 * the control plane against the thread connection's grant and owner and recorded in its activity.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { ASSISTANT_THREAD_CREDENTIAL_TTL_MS } from "@wollipog/protocol";
import {
  AgentControlRelaySockets,
  type AgentControlRelayRequest,
  type AgentControlRelayResponse,
} from "./agent-control-relay.js";
import { assistantMcpConfigPath } from "./assistant-launch.js";

export const ASSISTANT_RELAY_ENDPOINT_ENV = "WOLLIPOG_ASSISTANT_RELAY_ENDPOINT";
export const ASSISTANT_RELAY_KEY_ENV = "WOLLIPOG_ASSISTANT_RELAY_KEY";
export const ASSISTANT_MCP_PATH = "/assistant/mcp";
const ACK_TIMEOUT_MS = 10_000;

interface ThreadCredential {
  token: string;
  tokenHash: string;
  /** Set once the control plane bound this credential. */
  expiresAt: number | null;
  refusal: string | null;
  settled: Promise<void>;
  settle: () => void;
}

interface ProxyState {
  relayKey: string;
  cpUrl: string;
  credential: ThreadCredential | null;
}

export interface AssistantProxyDeps {
  /** Where launches write Claude Code's proxy server entry; removed when the proxy closes. */
  configDir?: string;
  /** Sends `assistant_credential` with the hash; the answer arrives through `acknowledge`. */
  register(sessionId: string, tokenHash: string): void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  ackTimeoutMs?: number;
}

function keyMatches(expected: string, presented: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(presented).digest();
  return timingSafeEqual(left, right);
}

export class AssistantProxies {
  private readonly states = new Map<string, ProxyState>();
  private readonly relays: AgentControlRelaySockets;

  constructor(private readonly deps: AssistantProxyDeps) {
    this.relays = new AgentControlRelaySockets((sessionId, request, signal) => this.forward(sessionId, request, signal));
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Starts (or keeps) the session's proxy and registers a fresh credential for this launch. */
  async provision(sessionId: string, cpUrl: string): Promise<{ endpoint: string; relayKey: string }> {
    const endpoint = await this.relays.ensure(sessionId);
    let state = this.states.get(sessionId);
    if (!state) {
      state = { relayKey: "", cpUrl, credential: null };
      this.states.set(sessionId, state);
    }
    // A new relay key per launch: an earlier provider's adapter can no longer reach the proxy.
    state.relayKey = randomBytes(32).toString("base64url");
    state.cpUrl = cpUrl;
    this.rotate(sessionId, state);
    return { endpoint, relayKey: state.relayKey };
  }

  private rotate(sessionId: string, state: ProxyState): ThreadCredential {
    const token = `wollipoga_${randomBytes(32).toString("base64url")}`;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const credential: ThreadCredential = {
      token, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: null, refusal: null, settled, settle,
    };
    state.credential?.settle();
    state.credential = credential;
    this.deps.register(sessionId, credential.tokenHash);
    return credential;
  }

  /** The control plane's answer. An answer for a superseded credential changes nothing. */
  acknowledge(sessionId: string, tokenHash: string, accepted: boolean, expiresAt?: number, error?: string): void {
    const credential = this.states.get(sessionId)?.credential;
    if (!credential || credential.tokenHash !== tokenHash) return;
    if (accepted && typeof expiresAt === "number") credential.expiresAt = expiresAt;
    else credential.refusal = error ?? "the control plane refused the thread credential";
    credential.settle();
  }

  /** Unanswered registrations, re-sent after a reconnect. Hashes only. */
  pendingRegistrations(): Array<{ sessionId: string; tokenHash: string }> {
    return [...this.states].flatMap(([sessionId, state]) => state.credential && state.credential.expiresAt === null &&
      !state.credential.refusal ? [{ sessionId, tokenHash: state.credential.tokenHash }] : []);
  }

  has(sessionId: string): boolean { return this.states.has(sessionId); }

  /** Forgets the credential and closes the proxy. Later adapter calls cannot connect. */
  async revoke(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (state) {
      state.credential?.settle();
      state.credential = null;
    }
    this.states.delete(sessionId);
    await this.relays.close(sessionId);
    // The key in it is dead with the proxy; the file goes too.
    if (this.deps.configDir) {
      try { rmSync(assistantMcpConfigPath(this.deps.configDir, sessionId), { force: true }); } catch { /* best effort */ }
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.states.keys()]) await this.revoke(sessionId);
  }

  private async ready(sessionId: string, state: ProxyState, signal: AbortSignal): Promise<ThreadCredential> {
    let credential = state.credential;
    const now = this.now();
    // Refresh well before expiry, and retry after a refusal so the assistant hears the current reason.
    if (!credential || credential.refusal ||
        (credential.expiresAt !== null && credential.expiresAt - now < ASSISTANT_THREAD_CREDENTIAL_TTL_MS / 2)) {
      credential = this.rotate(sessionId, state);
    }
    if (credential.expiresAt === null && !credential.refusal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.ackTimeoutMs ?? ACK_TIMEOUT_MS); });
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([credential.settled, timedOut, aborted]);
      clearTimeout(timer);
    }
    if (state.credential !== credential) throw new Error("The Wollipog Assistant thread credential was replaced or revoked.");
    if (credential.refusal) throw new Error(`Wollipog refused this thread's Assistant access: ${credential.refusal}.`);
    if (credential.expiresAt === null) throw new Error("Wollipog did not confirm this thread's Assistant access in time. Try again shortly.");
    return credential;
  }

  /** Forwards one MCP request to the control plane's Assistant endpoint with the thread
   * credential. The adapter chooses neither the destination nor the credential. */
  private async forward(sessionId: string, request: AgentControlRelayRequest, signal: AbortSignal): Promise<AgentControlRelayResponse> {
    const state = this.states.get(sessionId);
    if (!state || !keyMatches(state.relayKey, request.key)) throw new Error("The Wollipog Assistant proxy refused this request.");
    if (request.method !== "POST" || request.path !== ASSISTANT_MCP_PATH || request.body === undefined) {
      throw new Error("The Wollipog Assistant proxy forwards only MCP requests.");
    }
    const send = async (credential: ThreadCredential) => (this.deps.fetch ?? globalThis.fetch)(new URL(ASSISTANT_MCP_PATH, state.cpUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", accept: "application/json" },
      body: request.body,
      signal,
    });
    const credential = await this.ready(sessionId, state, signal);
    let response = await send(credential);
    // An expired credential (clock skew, or a long gap) is replaced once; a refusal of the new
    // one reaches the assistant with the control plane's reason.
    if (response.status === 401 && this.states.get(sessionId) === state && state.credential === credential) {
      credential.refusal = "expired";
      response = await send(await this.ready(sessionId, state, signal));
    }
    return { status: response.status, body: await response.text() };
  }
}
