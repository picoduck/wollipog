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
import {
  ASSISTANT_EVIDENCE_INSPECT,
  ASSISTANT_EVIDENCE_RELAY_ACK,
  ASSISTANT_EVIDENCE_RELAY_DELIVER,
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  type UiEvidenceReviewDelivery,
} from "@wollipog/protocol";
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
    // Only this trusted proxy may send the internal methods with the memory-held credential.
    const message = JSON.parse(request.body) as { id?: unknown; method?: unknown; params?: {
      name?: unknown; arguments?: { occurrenceId?: unknown; evidenceId?: unknown; sessionId?: unknown };
    } } | null;
    if (message?.method === ASSISTANT_EVIDENCE_RELAY_ACK || message?.method === ASSISTANT_EVIDENCE_RELAY_DELIVER) {
      throw new Error("Evidence delivery methods are private to the Wollipog runner.");
    }
    const inspect = message?.method === "tools/call" && message.params?.name === ASSISTANT_EVIDENCE_INSPECT;
    const body = inspect ? JSON.stringify({ ...message, method: ASSISTANT_EVIDENCE_RELAY_DELIVER }) : request.body;
    const send = async (credential: ThreadCredential, payload: string) => (this.deps.fetch ?? globalThis.fetch)(new URL(ASSISTANT_MCP_PATH, state.cpUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", accept: "application/json" },
      body: payload,
      signal,
    });
    let credential = await this.ready(sessionId, state, signal);
    let response = await send(credential, body);
    // An expired credential (clock skew, or a long gap) is replaced once; a refusal of the new
    // one reaches the assistant with the control plane's reason.
    if (response.status === 401 && this.states.get(sessionId) === state && state.credential === credential) {
      credential.refusal = "expired";
      credential = await this.ready(sessionId, state, signal);
      response = await send(credential, body);
    }
    const responseBody = await response.text();
    if (!inspect || !response.ok || !responseBody) return { status: response.status, body: responseBody };

    const delivered = JSON.parse(responseBody) as { id?: unknown; delivery?: UiEvidenceReviewDelivery };
    // Older control planes and refusals send an ordinary MCP error.
    if (!delivered.delivery) return { status: response.status, body: responseBody };
    const toolResult = (result: object) => ({
      status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
    });
    const refuse = (reason: string) => toolResult({ isError: true, content: [{ type: "text", text: reason }] });
    const { data, mimeType, sizeBytes, receipt } = delivered.delivery;
    const args = message.params?.arguments;
    if (delivered.id !== message.id || !receipt || receipt.reviewerSessionId !== sessionId ||
        receipt.occurrenceId !== args?.occurrenceId || receipt.evidenceId !== args?.evidenceId ||
        receipt.childSessionId !== args?.sessionId || !receipt.assistantBinding ||
        !PROMPT_IMAGE_MIME_TYPES.includes(mimeType as (typeof PROMPT_IMAGE_MIME_TYPES)[number]) ||
        typeof data !== "string" || !(sizeBytes > 0 && sizeBytes <= MAX_PROMPT_IMAGE_BYTES) ||
        data.length !== Math.ceil(sizeBytes / 3) * 4) {
      return refuse("Wollipog returned invalid evidence delivery metadata.");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length !== sizeBytes || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) {
      return refuse("Delivered evidence does not match the digest bound to this decision.");
    }
    if (signal.aborted || state.credential !== credential || !keyMatches(state.relayKey, request.key)) {
      return refuse("The thread connection changed before the evidence could be delivered.");
    }
    const ack = await send(credential, JSON.stringify({ jsonrpc: "2.0", id: message.id,
      method: ASSISTANT_EVIDENCE_RELAY_ACK, params: { arguments: args,
        acknowledgement: { receiptId: receipt.receiptId, sha256: receipt.sha256 } } }));
    const acknowledged = await ack.json() as { result?: { acknowledged?: boolean; isError?: boolean; content?: { text?: string }[] } };
    if (!ack.ok || acknowledged.result?.acknowledged !== true) {
      return refuse(acknowledged.result?.isError && acknowledged.result.content?.[0]?.text ||
        "Wollipog could not record the verified image delivery.");
    }
    return toolResult({ content: [
      { type: "text", text: JSON.stringify({ evidenceId: receipt.evidenceId, artifactId: receipt.artifactId,
        sha256: receipt.sha256, receiptId: receipt.receiptId, mimeType, sizeBytes }) },
      { type: "image", data, mimeType },
    ] });
  }
}
