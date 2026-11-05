import React from "react";
import { createRoot } from "react-dom/client";
import type {
  CampaignDecisionsResponse,
  DecisionModelSettingsView,
  DecisionModelTestResult,
  DecisionOccurrenceView,
} from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { CampaignDecisions } from "../components/CampaignDecisions.js";
import { DecisionModelPanel } from "../components/DecisionModelPanel.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { SettingsView } from "../components/SettingsView.js";
import "../styles.css";

/**
 * Settings › Orchestrator › Decision Model (#4101) against an in-memory server: `?source=` picks the
 * stored setting (`automatic`, `chosen`, `unavailable`), `viewer` drops owner or admin permission,
 * `test=fail` makes Test Decision Model end without a verdict, and `view=campaign` shows the Campaign
 * Status Decision Model section instead.
 */
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? "automatic";

const machines: DecisionModelSettingsView["machines"] = [{
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  harnesses: [{
    agentId: "claude-code",
    name: "Claude Code",
    driver: "claude-code",
    provider: "claude",
    billingSource: "subscription",
    models: [
      { id: "haiku", displayName: "Haiku", efforts: ["low", "medium"] },
      { id: "sonnet", displayName: "Sonnet", efforts: ["low", "medium", "high"] },
    ],
  }, {
    agentId: "codex",
    name: "Codex App Server",
    driver: "codex-app-server",
    provider: "codex",
    billingSource: "api",
    models: [{ id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", efforts: ["minimal", "low"] }],
  }],
}];

const chosen: NonNullable<DecisionModelSettingsView["target"]> = {
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  agentId: "claude-code",
  harnessName: "Claude Code",
  driver: "claude-code",
  context: { kind: "native" },
  provider: "claude",
  billingSource: "subscription",
  model: "haiku",
  modelName: "Haiku",
  effort: "low",
  available: true,
};

let state: DecisionModelSettingsView = {
  source: "automatic",
  canManage: !params.has("viewer"),
  machines,
  automaticPreference: ["haiku", "luna", "mini", "nano", "flash"],
};
if (source === "chosen") state = { ...state, source: "organization", target: chosen };
if (source === "unavailable") {
  state = { ...state, source: "organization", target: { ...chosen, available: false, reason: "The selected Machine is offline." } };
}

const target = {
  source: "automatic" as const,
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  agentId: "claude-code",
  harnessName: "Claude Code",
  driver: "claude-code" as const,
  provider: "claude" as const,
  model: "haiku",
  effort: "low",
};

const decided: DecisionOccurrenceView = {
  occurrenceId: "dec_probe",
  kind: "probe",
  promptVersion: "probe.v1",
  state: "decided",
  verdict: "confirm",
  reason: "picoduck/example is listed in the boundary.",
  target,
  inputDigests: {},
  attempts: [{ attempt: 1, latencyMs: 3_140 }],
  usage: { inputTokens: 210, outputTokens: 48, cacheReadInputTokens: 0, cacheCreationInputTokens: 3_208, costUsd: 0.0052 },
  createdAt: Date.now() - 60_000,
};

const testResult = (): DecisionModelTestResult => params.get("test") === "fail"
  ? {
      latencyMs: 41_800,
      occurrence: {
        ...decided,
        state: "failed",
        failureClass: "rate_limited",
        attempts: [
          { attempt: 1, errorClass: "rate_limited", latencyMs: 900 },
          { attempt: 2, errorClass: "rate_limited", latencyMs: 1_100 },
          { attempt: 3, errorClass: "rate_limited", latencyMs: 1_000 },
        ],
        usage: { ...decided.usage, costUsd: null },
      },
    }
  : { latencyMs: 3_200, occurrence: { ...decided, target: state.target ? { ...target, source: "organization" } : target } };

const { verdict: _verdict, reason: _reason, ...withoutAnswer } = decided;
const campaign: CampaignDecisionsResponse = {
  campaignSessionId: "s_campaign",
  decisions: [
    decided,
    {
      ...decided,
      occurrenceId: "dec_uncertain",
      state: "uncertain",
      verdict: "uncertain",
      reason: "The request names two repositories and the boundary lists one.",
      humanRequestId: "wfd_owner",
    },
    {
      ...withoutAnswer,
      occurrenceId: "dec_failed",
      state: "failed",
      failureClass: "runner_incapable",
      attempts: [{ attempt: 1, errorClass: "runner_incapable", latencyMs: 0 }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 },
    },
  ],
  usage: { calls: 3, inputTokens: 420, outputTokens: 96, cacheReadInputTokens: 0, cacheCreationInputTokens: 6_416, costUsd: 0.0104, unpricedCalls: 0 },
};

const respond = (value: unknown, status = 200) => Response.json(value, { status });
const client = createApiClient({
  instanceId: "synthetic-decision-model",
  publicOrigin: location.origin,
  close() {},
  async request(path, init) {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (path.endsWith("/campaign/decisions")) return respond(campaign);
    if (path === "/api/decision-model/test") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return respond(testResult());
    }
    if (path !== "/api/decision-model") return respond({ error: "Not supported in synthetic fixture" }, 404);
    if (method === "PUT") {
      const machine = machines.find((candidate) => candidate.runnerId === body.runnerId)!;
      const agent = machine.harnesses.find((candidate) => candidate.agentId === body.agentId)!;
      const model = agent.models.find((candidate) => candidate.id === body.model)!;
      state = {
        ...state,
        source: "organization",
        target: {
          ...chosen,
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
    } else if (method === "DELETE") {
      const { target: _removed, ...rest } = state;
      state = { ...rest, source: "automatic" };
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
            {params.get("view") === "campaign" ? (
              <div className="campaign-status" style={{ padding: 24, maxWidth: 760 }}>
                <div className="campaign-status-sections"><CampaignDecisions campaignId="s_campaign" /></div>
              </div>
            ) : (
              <SettingsView
                section="orchestrator"
                onNavigate={() => undefined}
                panels={{
                  appearance: null, notifications: null, behavior: null, approvals: null, reviews: null, network: null,
                  storage: null, experimental: null, about: null,
                  orchestrator: <DecisionModelPanel />,
                }}
              />
            )}
          </main>
        </div>
      </FeedbackProvider>
    </ApiProvider>
  </React.StrictMode>,
);
