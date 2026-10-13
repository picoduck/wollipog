import React from "react";
import { createRoot } from "react-dom/client";
import type { SessionNamingSettingsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { SessionTitlesPanel } from "../components/SessionTitlesPanel.js";
import { BehaviorPanel, SettingsView } from "../components/SettingsView.js";
import "../styles.css";

/**
 * Settings › Behavior with Session Titles (#3025) against an in-memory server, so every state the
 * issue names can be opened without a control plane: `?source=` picks the stored source (`first`,
 * `agent`, `endpoint`, `endpoint-key`, `follow`, `unavailable`), `viewer` drops owner or admin
 * permission, `fail=load` rejects the read as a dropped connection does, `fail=save` refuses saves.
 */
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? "first";

const machines: SessionNamingSettingsView["harnessMachines"] = [{
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  harnesses: [{
    agentId: "claude-code",
    name: "Claude Code",
    driver: "claude-code",
    provider: "claude",
    billingSource: "subscription",
    models: [
      { id: "haiku", displayName: "Haiku", efforts: ["low", "medium", "high"] },
      { id: "sonnet", displayName: "Sonnet", efforts: ["low", "medium", "high"] },
    ],
  }, {
    agentId: "codex",
    name: "Codex",
    driver: "codex-app-server",
    provider: "codex",
    billingSource: "api",
    models: [{ id: "luna", displayName: "Luna", efforts: ["low", "medium"] }],
  }],
}, {
  runnerId: "runner-laptop",
  machineName: "Travel Laptop",
  harnesses: [{
    agentId: "claude-code-laptop",
    name: "Claude Code",
    driver: "claude-code",
    provider: "claude",
    billingSource: "subscription",
    models: [{ id: "haiku", displayName: "Haiku", efforts: ["low", "medium"] }],
  }],
}];

const endpoint = (apiKeyConfigured: boolean): NonNullable<SessionNamingSettingsView["customModel"]> => ({
  endpointOrigin: "https://titles.example.com",
  model: "title-small",
  timeoutMs: 5_000,
  apiKeyConfigured,
  configurationSource: "runner",
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  online: true,
});

const haiku: NonNullable<SessionNamingSettingsView["harnessTarget"]> = {
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  agentId: "claude-code",
  harnessName: "Claude Code",
  driver: "claude-code",
  provider: "claude",
  billingSource: "subscription",
  model: "haiku",
  modelName: "Haiku",
  effort: "low",
  available: true,
};

let state: SessionNamingSettingsView = {
  mode: "prompt_text_only",
  effectiveMode: "prompt_text_only",
  source: "organization",
  canManage: !params.has("viewer"),
  modes: {
    prompt_text_only: { available: true },
    session_agent_account: { available: true },
    custom_model_endpoint: { available: false, reason: "Set up a custom endpoint first." },
  },
  harnessMachines: machines,
  customModelTargets: [
    { runnerId: "runner-studio", machineName: "Studio Workstation", online: true, available: true, configured: false },
    { runnerId: "runner-laptop", machineName: "Travel Laptop", online: false, available: false, configured: false, reason: "Travel Laptop is offline." },
  ],
};
if (source === "agent") state = { ...state, mode: "session_agent_account", effectiveMode: "session_agent_account", harnessTarget: haiku };
if (source === "follow") {
  state = { ...state, mode: "session_agent_account", effectiveMode: "session_agent_account" };
  delete state.harnessMachines;
}
if (source === "endpoint" || source === "endpoint-key") {
  state = {
    ...state,
    mode: "custom_model_endpoint",
    effectiveMode: "custom_model_endpoint",
    modes: { ...state.modes, custom_model_endpoint: { available: true } },
    customModel: endpoint(source === "endpoint-key"),
  };
}
if (source === "unavailable") {
  state = {
    ...state,
    mode: "session_agent_account",
    effectiveMode: "prompt_text_only",
    harnessTarget: { ...haiku, available: false, reason: "Studio Workstation is offline." },
  };
}

const respond = (value: unknown, status = 200) => Response.json(value, { status });
const client = createApiClient({
  instanceId: "synthetic-session-titles",
  publicOrigin: location.origin,
  close() {},
  async request(path, init) {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (path === "/api/artifact-upload-settings") return respond({ preference: "manual" });
    if (!path.startsWith("/api/session-naming")) return respond({ error: "Not supported in synthetic fixture" }, 404);
    if (method === "GET") {
      if (params.get("fail") === "load") throw new TypeError("Failed to fetch");
      return respond(state);
    }
    if (params.get("fail") === "save") return respond({ error: "the selected Machine rejected the custom model configuration (unavailable)" }, 409);
    if (path === "/api/session-naming") {
      state = { ...state, mode: body.mode as SessionNamingSettingsView["mode"], effectiveMode: body.mode as SessionNamingSettingsView["mode"] };
    } else if (path === "/api/session-naming/harness") {
      const machine = machines.find((candidate) => candidate.runnerId === body.runnerId)!;
      const agent = machine.harnesses.find((candidate) => candidate.agentId === body.agentId)!;
      const model = agent.models.find((candidate) => candidate.id === body.model)!;
      state = {
        ...state,
        mode: "session_agent_account",
        effectiveMode: "session_agent_account",
        harnessTarget: {
          ...haiku,
          runnerId: machine.runnerId,
          machineName: machine.machineName,
          agentId: agent.agentId,
          harnessName: agent.name,
          driver: agent.driver,
          provider: agent.provider,
          billingSource: agent.billingSource,
          model: model.id,
          modelName: model.displayName,
          effort: String(body.effort),
        },
      };
    } else if (path === "/api/session-naming/custom-model" && method === "PUT") {
      state = {
        ...state,
        mode: "custom_model_endpoint",
        effectiveMode: "custom_model_endpoint",
        modes: { ...state.modes, custom_model_endpoint: { available: true } },
        customModel: {
          ...endpoint(Boolean(body.apiKey) || state.customModel?.apiKeyConfigured === true),
          endpointOrigin: new URL(String(body.endpoint)).origin,
          model: String(body.model),
          timeoutMs: Number(body.timeoutMs),
        },
      };
    } else if (path === "/api/session-naming/custom-model/api-key" && state.customModel) {
      state = { ...state, customModel: { ...state.customModel, apiKeyConfigured: method === "POST" } };
    } else if (path === "/api/session-naming/custom-model/test") {
      return respond({ ok: true, status: "available" });
    }
    return respond(state);
  },
});

document.documentElement.dataset.theme = params.get("theme") ?? "dark";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <div className="app" style={{ height: "100dvh", display: "block" }}>
          <main className="main-body" style={{ height: "100%" }}>
            <SettingsView
              section="behavior"
              onNavigate={() => undefined}
              panels={{
                appearance: null, notifications: null, approvals: null, orchestrator: null, network: null, experimental: null, about: null,
                behavior: <BehaviorPanel sessionNaming={<SessionTitlesPanel />} />,
              }}
            />
          </main>
        </div>
      </FeedbackProvider>
    </ApiProvider>
  </React.StrictMode>,
);
