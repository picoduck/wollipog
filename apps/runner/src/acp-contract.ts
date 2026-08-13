/**
 * ACP protocol baseline and negotiation compatibility layer.
 *
 * The official SDK artifact version and the ACP wire version are deliberately separate. ACP keeps
 * wire version 1 for additive stable methods and negotiates those methods through capabilities.
 * Experimental SDK fields are observed for diagnostics only and never activated here.
 */

import type {
  AgentCapabilities as WireAgentCapabilities,
  InitializeRequest,
  InitializeResponse,
} from "@agentclientprotocol/sdk";

export const ACP_SDK_VERSION = "1.2.1";
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_CLIENT_VERSION = "0.1.0";

export interface AcpStableCapabilities {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  sessionList: boolean;
  sessionDelete: boolean;
  sessionAdditionalDirectories: boolean;
  sessionResume: boolean;
  sessionClose: boolean;
  logout: boolean;
}

export type AcpExperimentalCapability = "mcp-acp" | "session-fork" | "providers" | "nes";

export interface AcpImplementationDiagnostics {
  name: string;
  title: string | null;
  /** Older protocol-v1 agents may omit the now-required SDK field. */
  version: string | null;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description: string | null;
}

export interface AcpNegotiation {
  protocolVersion: number;
  schemaAuthority: { package: "@agentclientprotocol/sdk"; version: string };
  agentInfo: AcpImplementationDiagnostics | null;
  /** Stable, agent-managed authentication choices safe to render to the user. */
  authMethods: AcpAuthMethod[];
  stable: AcpStableCapabilities;
  /** Advertised upstream preview/draft features. Presence is diagnostic, not authorization. */
  experimentalAdvertised: AcpExperimentalCapability[];
}

export function acpInitializeRequest(): InitializeRequest {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      // Phase 3 enables stable session config/lifecycle features only with their UI/behavior slice.
      // Do not advertise experimental auth, elicitation, NES, plan-update, or position encodings.
    },
    clientInfo: { name: "wollipog", version: ACP_CLIENT_VERSION },
  };
}

/** Decode the additive initialize response without retaining arbitrary metadata or auth details. */
export function negotiateAcpInitialize(value: unknown): AcpNegotiation {
  if (!isRecord(value) || !Number.isInteger(value.protocolVersion)) {
    throw new Error("ACP initialize response is missing an integer protocolVersion");
  }
  if (value.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ACP protocol version ${String(value.protocolVersion)}; this runner supports ${ACP_PROTOCOL_VERSION}`,
    );
  }

  // The official SDK is the compile-time schema authority. The compatibility decoder above keeps
  // older/additive agents from crashing us on optional metadata while still failing closed on the
  // wire-version boundary.
  const response = value as InitializeResponse;
  const caps = isRecord(response.agentCapabilities)
    ? (response.agentCapabilities as WireAgentCapabilities)
    : {};
  const session = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
  const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {};
  const mcp = isRecord(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
  const auth = isRecord(caps.auth) ? caps.auth : {};

  const experimentalAdvertised: AcpExperimentalCapability[] = [];
  if (mcp.acp === true) experimentalAdvertised.push("mcp-acp");
  if (isRecord(session.fork)) experimentalAdvertised.push("session-fork");
  if (isRecord(caps.providers)) experimentalAdvertised.push("providers");
  if (isRecord(caps.nes)) experimentalAdvertised.push("nes");

  return {
    protocolVersion: response.protocolVersion,
    schemaAuthority: { package: "@agentclientprotocol/sdk", version: ACP_SDK_VERSION },
    agentInfo: normalizeImplementation(response.agentInfo),
    authMethods: normalizeAuthMethods(response.authMethods),
    stable: {
      loadSession: caps.loadSession === true,
      promptImage: prompt.image === true,
      promptAudio: prompt.audio === true,
      promptEmbeddedContext: prompt.embeddedContext === true,
      mcpHttp: mcp.http === true,
      mcpSse: mcp.sse === true,
      sessionList: isRecord(session.list),
      sessionDelete: isRecord(session.delete),
      sessionAdditionalDirectories: isRecord(session.additionalDirectories),
      sessionResume: isRecord(session.resume),
      sessionClose: isRecord(session.close),
      logout: isRecord(auth.logout),
    },
    experimentalAdvertised,
  };
}

function normalizeAuthMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return [];
  const methods: AcpAuthMethod[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (methods.length >= 16) break;
    if (!isRecord(candidate)) continue;
    // env_var and terminal are draft client-managed flows. Until their RFDs stabilize, only the
    // absent/"agent" discriminator is eligible: the agent owns browser/device interaction.
    if (candidate.type !== undefined && candidate.type !== "agent") continue;
    const id = boundedString(candidate.id, 160);
    const name = boundedString(candidate.name, 160);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    methods.push({ id, name, description: boundedString(candidate.description, 320) });
  }
  return methods;
}

function normalizeImplementation(value: unknown): AcpImplementationDiagnostics | null {
  if (!isRecord(value)) return null;
  const name = boundedString(value.name, 120);
  if (!name) return null;
  const title = boundedString(value.title, 160);
  const version = boundedString(value.version, 80);
  return { name, title, version };
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\r\n\t]/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
