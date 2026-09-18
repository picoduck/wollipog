import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, PromptImageInput, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import "../styles.css";

declare global {
  interface Window {
    resolveSessionUsageQuestion(): void;
    setSessionUsageRunnerOnline(online: boolean): void;
    publishLiveSessionUsage(): void;
  }
}

/** Real-browser SessionDetail harness for recovery geometry and earlier-history pagination:
 * `?mode=preview|expanded`, `?height=<px>`, and `?pinned=1` configure the recovery fixture.
 * By default recovery stays active for the page life; `?settled=1` completes it, while
 * `?pagination=1` resolves a bounded opening window and then holds the automatic earlier-page
 * request in flight for inspection. `?pagination=resolve` serves multiple variable-height pages;
 * `?event-heavy=1` makes 200 raw opening events collapse into one partial rendered response, and
 * `?live=1` adds a live tail event during the first prepend. */
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "preview" ? ("preview" as const) : ("expanded" as const);
const frameHeight = Number(params.get("height") ?? "600");
const frameWidth = Number(params.get("width") ?? "900");
const pinnedOpen = params.get("pinned") === "1";
const pagination = params.get("pagination") === "1";
const resolvedPagination = params.get("pagination") === "resolve";
const eventHeavyOpening = params.get("event-heavy") === "1";
const liveDuringPagination = params.get("live") === "1";
const paginationDelay = Number(params.get("pagination-delay") ?? "80");
const settled = params.get("settled") === "1";
/** `?context=choice` swaps in a Claude catalog whose Opus base lists 200K and 1M windows, with the
 * session on `opus[1m]`; `?served=<tokens>` is the window the provider reported after launch. */
const contextChoice = params.get("context") === "choice";
const serviceTierFixture = params.has("tiers");
const serviceTierChoice = params.get("tiers") === "1";
const composerFixture = params.get("composer");
const composerDraftText = (params.get("draft") ?? "").replaceAll("\\n", "\n");
const composerDraftImages: PromptImageInput[] = params.get("attachment") === "1"
  ? [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]
  : [];
const servedWindow = Number(params.get("served") ?? "0");
// `?window=none` drops the context window (an agent that advertises no capacity); `?cost=none`
// marks the session unpriced, `?cost=unavailable` has no pricing provenance, and `?cost=free`
// carries provider-reported zero provenance. `?usage=absent` removes all processed usage,
// `?usage-detail=pending|failed` holds or rejects the model breakdown, and `?cost=<amount>`
// sets the total so layout specs can stress the strip with a figure much wider than the default
// (#893). Cost variants keep the token counts unless usage is explicitly absent.
const unknownContextWindow = params.get("window") === "none";
const costParam = params.get("cost");
const unpricedCost = costParam === "none";
const unavailableCost = costParam === "unavailable";
const freeCost = costParam === "free";
const absentUsage = params.get("usage") === "absent";
const activeUsage = params.get("active-usage") === "1";
const usageDetail = params.get("usage-detail");
const parsedCost = Number(costParam);
const sessionCostUsd = unpricedCost || freeCost || costParam === null || !Number.isFinite(parsedCost)
  ? 1.37
  : parsedCost;
/** The default fixture's 1.21 / 0.16 split, held as a ratio so a `?cost=` override still sums to the
 * headline figure and a sub-cent total never produces a negative per-model row. */
const miniModelCostUsd = sessionCostUsd * (0.16 / 1.37);
const mainModelCostUsd = sessionCostUsd - miniModelCostUsd;

const SESSION_ID = "session-usage-e2e";

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
} as RunnerView;

const session: SessionView = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "codex",
  agentName: "Codex",
  title: "Session Usage Fixture",
  status: activeUsage ? "running" : "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/tmp/recovery-e2e-worktree",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "codex-app-server",
  model: "codex-large",
  effort: null,
  permissionMode: null,
  tokensIn: absentUsage ? 0 : activeUsage ? 18_714 : 184_000,
  tokensOut: absentUsage ? 0 : activeUsage ? 21 : 21_000,
  costUsd: absentUsage || unpricedCost || unavailableCost || freeCost ? 0 : activeUsage ? 0.075276 : sessionCostUsd,
  ...(freeCost ? { costSource: "providerReported" as const }
    : unpricedCost ? { costSource: "unpriced" as const } : {}),
  contextTokensUsed: unknownContextWindow ? undefined : Number(params.get("used") ?? "72000"),
  adopted: false,
  // A known context window makes the ContextWindowMeter render in the strip's leading cell,
  // so the specs can prove the active recovery echo wins that cell in compact mode.
  contextWindow: unknownContextWindow ? undefined : 200_000,
};
const driverName = params.get("driver") === "claude-code" || contextChoice ? "claude-code" : "codex-app-server";
session.driver = driverName as SessionView["driver"];
if (contextChoice) {
  runner.agents = [{
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    available: true,
    capabilities: {
      modelSource: "live",
      models: [
        { id: "default", displayName: "Default (Opus 5)", default: true, contextWindow: 1_000_000, description: "Opus 5 with 1M context · Best for everyday, complex tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "opus", displayName: "Opus 5", contextWindow: 200_000, description: "Opus 5 with 200K context", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "opus[1m]", displayName: "Opus 5 (1M Context)", baseModelId: "opus", contextWindow: 1_000_000, description: "Opus 5 with 1M context", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "sonnet", displayName: "Sonnet 5", description: "Sonnet 5 · Efficient for routine tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000, description: "Haiku 4.5 · Fastest for quick answers" },
      ],
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    },
  }] as RunnerView["agents"];
  session.agentId = "claude";
  session.agentName = "Claude Code";
  session.model = params.get("model") ?? "opus[1m]";
  session.effort = "high";
  session.contextWindow = servedWindow > 0 ? servedWindow : undefined;
}
if (serviceTierFixture) {
  runner.protocolVersion = serviceTierChoice ? 126 : 125;
  runner.agents = [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
    capabilities: {
      modelSource: "live",
      models: [{
        id: "gpt-tiered",
        displayName: "GPT Tiered",
        default: true,
        efforts: ["low", "high"],
        serviceTiers: [{
          id: "fast",
          name: "Fast",
          description: "Faster responses that use more ChatGPT credits.",
        }],
        defaultServiceTier: "default",
      }],
      effortLevels: ["low", "high"],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["auto-review"],
    },
  }] as RunnerView["agents"];
  session.model = "gpt-tiered";
  session.effort = "high";
  session.serviceTier = serviceTierChoice ? "fast" : null;
}
if (composerFixture) {
  const isClaude = composerFixture === "claude";
  const isPi = composerFixture === "pi";
  const isOrchestrator = composerFixture === "orchestrator";
  const driver = isClaude ? "claude-code" : isPi ? "pi" : "codex-app-server";
  const agentName = isOrchestrator ? "Codex Orchestrator" : isClaude ? "Claude Code" : isPi ? "Pi" : "Codex";
  const modelName = isClaude
    ? "Claude Opus 5.1 Extended Context Preview"
    : isPi
      ? "Pi Sonnet Extended Context Preview"
    : "GPT-6-Astra Extended Context Preview";
  const permissionModes = isOrchestrator
    ? ["orchestrator"]
    : isClaude
      ? ["default", "acceptEdits", "bypassPermissions"]
      : isPi
        ? ["default", "dontAsk", "bypassPermissions"]
      : ["auto-review", "danger-full-access"];
  const serviceTiers = isClaude || isPi ? undefined : [{
    id: "fast",
    name: "Fast",
    description: "Faster responses that use more ChatGPT credits.",
  }];
  runner.protocolVersion = isOrchestrator ? 140 : 136;
  runner.agents = [{
    id: isClaude ? "claude" : "codex",
    name: agentName,
    command: isClaude ? "claude" : "codex",
    args: [],
    env: {},
    driver,
    available: true,
    capabilities: {
      modelSource: "live",
      models: [
        {
          id: "long-model",
          displayName: modelName,
          default: true,
          contextWindow: 200_000,
          description: `${modelName} with a 200K context window`,
          efforts: ["low", "medium", "high"],
          ...(serviceTiers ? { serviceTiers, defaultServiceTier: "default" } : {}),
        },
        {
          id: "long-model[1m]",
          baseModelId: "long-model",
          displayName: `${modelName} (1M Context)`,
          contextWindow: 1_000_000,
          description: `${modelName} with a 1M context window`,
          efforts: ["low", "medium", "high"],
          ...(serviceTiers ? { serviceTiers, defaultServiceTier: "default" } : {}),
        },
      ],
      effortLevels: ["low", "medium", "high"],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes,
      ...(isPi ? { elicitation: {
        default: ["stdio-control" as const],
        dontAsk: ["none" as const],
        bypassPermissions: ["none" as const],
      } } : {}),
    },
  }] as RunnerView["agents"];
  session.agentId = isClaude ? "claude" : isPi ? "pi" : "codex";
  session.agentName = agentName;
  session.driver = driver;
  session.model = "long-model[1m]";
  session.effort = "high";
  session.permissionMode = isOrchestrator
    ? "orchestrator"
    : params.get("unsafe") === "1"
      ? isClaude ? "bypassPermissions" : "danger-full-access"
      : permissionModes[0]!;
  if (isOrchestrator) {
    session.parentControl = "questions_and_approvals";
    session.parentControlPolicy = {
      revision: 4,
      decisions: {
        implementation_question: "orchestrator",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "orchestrator",
        ui_evidence_approval: "human",
      },
    };
    session.orchestratorPolicy = {
      version: 1,
      behavior: {
        childHarness: null,
        childModel: "long-model[1m]",
        childEffort: "high",
        maximumConcurrentChildren: 3,
        followUps: "recommend_only",
        completion: "stop_and_archive",
      },
      delegation: {
        parentControl: "questions_and_approvals",
        decisions: { ...session.parentControlPolicy.decisions },
      },
      execution: { strictProjectIsolation: false, integrationIsolation: false },
      sources: {
        behavior: {
          childHarness: "user_default",
          childModel: "user_default",
          childEffort: "user_default",
          maximumConcurrentChildren: "session_override",
          followUps: "user_default",
          completion: "session_override",
        },
        delegation: {
          parentControl: "user_default",
          decisions: {
            implementation_question: "session_override",
            pr_merge: "user_default",
            merged_branch_deletion: "user_default",
            follow_up_issue_publication: "session_override",
            ui_evidence_approval: "user_default",
          },
        },
        execution: { strictProjectIsolation: "user_default", integrationIsolation: "user_default" },
      },
    };
    if (params.get("campaign-state") !== "off") {
      session.orchestratorCampaign = {
        status: "waiting_human",
        policyRevision: 4,
        decisionOwners: { ...session.parentControlPolicy.decisions },
        limits: {
          maximumConcurrentChildren: 3,
          occupied: 2,
          remaining: 1,
          costBudgetUsd: null,
          maxToolCalls: null,
        },
        uiEvidenceReview: {
          status: "unavailable",
          effectiveOwner: "human",
          reason: "This Orchestrator client cannot inspect the evidence bytes.",
        },
        children: { total: 4, active: 2, waitingHuman: 1, blocked: 0, verified: 1, cleanupPending: 0 },
        pendingDecisions: { human: 1, orchestrator: 0 },
        followUps: { unique: 2, duplicates: 1 },
      };
    }
  }
  session.serviceTier = serviceTiers ? "fast" : null;
  session.contextWindow = 1_000_000;
}
if (params.get("plan") === "1") session.permissionMode = "plan";
if (params.get("action") === "stop") {
  session.status = "running";
  session.activeTurnId = "turn-1";
} else if (params.get("action") === "restart") {
  session.status = "stopped";
}
if (params.get("quarantine") === "1") {
  session.historyQuarantine = {
    reason: "oversized_tool_call",
    detectedAt: 1,
    recoveryTurn: 2,
    recovery: "handoff",
  };
}
if (params.get("approval") === "checkpoint") {
  session.status = "input_required";
  session.costCheckpointsUsd = [1, 2.5];
  session.costCheckpointApprovedUsd = 1;
  session.pendingApproval = {
    requestId: "cost-checkpoint:session-usage-e2e:1",
    kind: "cost_checkpoint",
    title: "Cost checkpoint — $2.61 of $2.50. Continue?",
    options: [
      { optionId: "continue", name: "Continue", kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ],
  };
} else if (params.get("approval") === "permission") {
  session.status = "input_required";
  session.pendingApproval = {
    requestId: "permission:session-usage-e2e:1",
    kind: "permission",
    title: "Run the requested tool?",
    options: [
      { optionId: "allow", name: "Allow Once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "deny" },
    ],
  };
} else if (params.get("approval") === "question") {
  setQuestionResponseStyle("composer");
  session.status = "input_required";
  session.pendingApproval = {
    requestId: "question:session-usage-e2e:1",
    kind: "question",
    title: "Choose a release target",
    options: [],
    questions: [{
      id: "target",
      question: "Which environment should receive the release?",
      options: [{ label: "Staging" }, { label: "Production" }],
    }],
  };
}

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: true,
  },
  runners: [runner],
  boxes: [],
  projects: [],
  sessions: [session],
  runs: [],
  pods: [],
};

function usageAmount(input: number, output: number, costUsd: number, processed: number, costSource: "providerReported" | "modelPriced" | "unpriced" = "providerReported") {
  return {
    inputTokens: input, outputTokens: output, costUsd, uncachedInputTokens: input, cachedInputTokens: Math.round(input * 4.2),
    cacheCreationTokens: Math.round(input / 8), reasoningTokens: 0, cacheSavingsUsd: costUsd * 0.6, costSource, unpricedRecords: costSource === "unpriced" ? 3 : 0,
    processedTokens: processed,
  };
}

let fixtureSocket: FixtureSocket | null = null;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    fixtureSocket = this;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshotMessage) });
    }, 0);
  }
  send() {}
  close() {}
}

window.resolveSessionUsageQuestion = () => {
  session.status = "idle";
  session.pendingApproval = null;
  fixtureSocket?.onmessage?.({ data: JSON.stringify({
    type: "session_upsert",
    session: { ...session },
  } satisfies ControlPlaneToUi) });
};

window.setSessionUsageRunnerOnline = (online) => {
  runner.status = online ? "online" : "offline";
  fixtureSocket?.onmessage?.({ data: JSON.stringify({
    type: "runner_upsert",
    runner: { ...runner },
  } satisfies ControlPlaneToUi) });
};

window.publishLiveSessionUsage = () => {
  if (!activeUsage) return;
  session.tokensIn = 50_000;
  session.tokensOut = 4_500;
  session.costUsd = 0.30;
  session.updatedAt += 1;
  fixtureSocket?.onmessage?.({ data: JSON.stringify({
    type: "session_upsert",
    session: { ...session },
  } satisfies ControlPlaneToUi) });
};

const connection: UiConnectionRuntime = {
  instanceId: "recovery-e2e",
  runtimeKey: "recovery-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

/** The default endpoints never answer, keeping recovery active for geometry tests. Pagination mode
 * resolves only the opening window; its next request stays pending so loading state is observable. */
let tailRequestCount = 0;
// Usage screenshots want the settled transcript on screen; the harness defaults to settled.
const settledUsage = params.get("settled") !== "0";
const client = {
  ...api,
  prompt: async () => {
    document.body.dataset.composerAction = "send";
    return { ...session, status: "running" as const };
  },
  cancelTurn: async () => {
    document.body.dataset.composerAction = "stop";
    return { ...session, status: "idle" as const, activeTurnId: undefined };
  },
  restart: async () => {
    document.body.dataset.composerAction = "restart";
    return { ...session, status: "starting" as const };
  },
  sessionUsage: async () => {
    if (usageDetail === "pending") return new Promise<never>(() => {});
    if (usageDetail === "failed") throw new Error("Usage detail unavailable");
    if (activeUsage) {
      const live = session.tokensOut > 21;
      return {
        sessionId: SESSION_ID,
        totals: {
          inputTokens: session.tokensIn,
          outputTokens: session.tokensOut,
          costUsd: session.costUsd,
          uncachedInputTokens: live ? 10_000 : 4_714,
          cachedInputTokens: live ? 40_000 : 14_000,
          cacheCreationTokens: 0,
          reasoningTokens: live ? 1_200 : 0,
          cacheSavingsUsd: live ? 0.12 : 0.04,
          costSource: "modelPriced" as const,
          unpricedRecords: 0,
          processedTokens: session.tokensIn + session.tokensOut,
        },
        byModel: [],
      };
    }
    return {
      sessionId: SESSION_ID,
      totals: unpricedCost
        ? usageAmount(184_000, 21_000, 0, 205_000, "unpriced")
        : freeCost ? usageAmount(184_000, 21_000, 0, 205_000)
        : usageAmount(184_000, 21_000, sessionCostUsd, 205_000, "modelPriced"),
      byModel: [
        {
          model: driverName === "claude-code" ? "claude-fable-5-1" : "gpt-5.5-codex",
          ...usageAmount(160_000, 18_000, freeCost ? 0 : mainModelCostUsd, 178_000),
        },
        {
          model: driverName === "claude-code" ? "claude-haiku-4-5" : "gpt-5.5-codex-mini",
          ...usageAmount(
            24_000,
            3_000,
            unpricedCost || freeCost ? 0 : miniModelCostUsd,
            27_000,
            unpricedCost ? "unpriced" : freeCost ? "providerReported" : "modelPriced",
          ),
        },
      ],
      pricing: {
        status: "fresh" as const,
        source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        fetchedAt: 1,
        knownModels: 1200,
      },
    };
  },
  session: () => new Promise<never>(() => {}),
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, before: number | undefined, eventEpoch: number) => {
    tailRequestCount += 1;
    document.body.dataset.tailRequestCount = String(tailRequestCount);
    if ((settled || settledUsage) && before === undefined) {
      return Promise.resolve({
        events: activeFixtureEvents, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
      });
    }
    if (resolvedPagination && before !== undefined) {
      const pageSize = eventHeavyOpening ? 200 : 8;
      const pageStart = Math.max(0, before - 1 - pageSize);
      const events = activeFixtureEvents.slice(pageStart, before - 1);
      if (liveDuringPagination && tailRequestCount === 2) {
        window.setTimeout(() => fixtureSocket?.onmessage?.({ data: JSON.stringify({
          type: "session_event",
          event: {
            id: 81,
            sessionId: SESSION_ID,
            seq: 81,
            ts: 81,
            payload: {
              kind: "agent_message",
              text: `live answer ${"arriving while older activity loads ".repeat(5)}`,
              final: true,
            },
          },
        } satisfies ControlPlaneToUi) }), 30);
      }
      return new Promise((resolve) => window.setTimeout(() => resolve({
        events,
        eventEpoch,
        nextBefore: events[0]?.seq ?? 0,
        hasMoreOlder: pageStart > 0,
        cacheComplete: true,
      }), paginationDelay));
    }
    if ((!pagination && !resolvedPagination) || before !== undefined) return new Promise<never>(() => {});
    const openingWindow = activeFixtureEvents.slice(-24);
    const boundedOpeningWindow = eventHeavyOpening ? activeFixtureEvents.slice(-200) : openingWindow;
    return Promise.resolve({
      events: boundedOpeningWindow, eventEpoch, nextBefore: boundedOpeningWindow[0]?.seq ?? 0,
      hasMoreOlder: true, turnAligned: eventHeavyOpening ? false : true, cacheComplete: true,
    });
  },
} as unknown as ApiClient;

const payloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 4; turn += 1) {
  payloads.push({ kind: "user_message", text: `Question ${turn + 1}: summarise the usage overhaul and its remaining risks.`, images: [] });
  payloads.push({ kind: "agent_message", text: `Answer ${turn + 1}: the ledger prices at ingestion and the view reads the buckets. ${"Detail. ".repeat(turn + 2)}`, final: true });
  payloads.push({
    kind: "token_usage",
    inputTokens: 2_400 + turn * 900,
    cachedInputTokens: 38_000 + turn * 4_000,
    cacheCreationInputTokens: 1_200,
    outputTokens: 640 + turn * 120,
    ...(turn === 2 ? {} : { costUsd: 0.18 + turn * 0.07 }),
    durationMs: 12_300 + turn * 4_000,
    model: driverName === "claude-code" ? "claude-fable-5-1" : "gpt-5.5-codex",
  });
}
const fixtureEvents: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: index + 1,
  payload,
}));

const eventHeavyPayloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 110; turn += 1) {
  eventHeavyPayloads.push(
    { kind: "user_message", text: `earlier question ${turn + 1}`, images: [] },
    { kind: "agent_message", text: `earlier complete answer ${turn + 1}`, final: true },
  );
}
eventHeavyPayloads.push({
  kind: "user_message",
  text: "Explain the bounded opening-window behavior.",
  images: [],
});
for (let chunk = 0; chunk < 240; chunk += 1) {
  eventHeavyPayloads.push({
    kind: "agent_message",
    text: "x ",
    final: chunk === 239,
  });
}
const eventHeavyFixtureEvents: SessionEvent[] = eventHeavyPayloads.map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: index + 1,
  payload,
}));
const activeFixtureEvents = eventHeavyOpening ? eventHeavyFixtureEvents : fixtureEvents;

function EventSeeder() {
  const ready = useStoreSelector((state) => state.sessions.has(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    for (const event of activeFixtureEvents) {
      dispatch({ type: "msg", msg: { type: "session_event", event } });
    }
  }, [dispatch, ready]);
  return null;
}

const rightPanel = {
  open: false,
  mode: "launcher" as const,
  width: 360,
  dragging: false,
  subagentTarget: null,
  toggle() {},
  openMode() {},
  show() {},
  setMode() {},
  setWidth() {},
  setDragging() {},
  close() {},
  selectSubagent() {},
  showSubagent() {},
  consumeSubagentFocusRequest() {},
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <EventSeeder />
      {/* The frame stands in for the pane an inbox splitter produces: fixed height, clipped. */}
      <div
        id="frame"
        style={{ height: frameHeight, width: frameWidth, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <SessionDetail
          sessionId={SESSION_ID}
          mode={mode}
          rightPanel={rightPanel}
          onOpenTerminal={() => {}}
          pinnedOpen={pinnedOpen}
          composerDraftLoader={async () => ({
            text: composerDraftText,
            images: composerDraftImages,
            updatedAt: 1,
          })}
        />
      </div>
    </StoreProvider>
  </ApiProvider>,
);
