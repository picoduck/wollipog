import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GovernanceAuditEntry,
  PermissionOption,
  SessionEvent,
  SessionEventPayload,
  SessionView,
  StructuredRequestResolutionReason,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../../api.js";
import { ApiProvider } from "../../api-context.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { GovernancePolicyNamesContext, type GovernancePolicyNames } from "../../decision-record.js";
import { governanceDecisions } from "../../governance.js";
import { ViewerIdentityContext, viewerIdentity } from "../../resolver-identity.js";
import { StoreProvider } from "../../store.js";
import { deriveTimeline, type TimelineItem } from "../../timeline.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../../ui-transport.js";
import { EventTimeline } from "../EventTimeline.js";
import { GovernancePolicyNamesProvider } from "../GovernancePolicyNamesProvider.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

installDomTestCleanup(domWindow);

const RESOLVED_AT = Date.UTC(2026, 9, 5, 9, 30, 15);

/** Alice is the only member, so a person's decision is hers: "by You". */
const soloViewer = viewerIdentity({
  context: {
    userId: "alice", userName: "Alice", organizationId: "org", organizationName: "Personal",
    role: "owner", deviceId: null, localBootstrap: true,
  },
  organizations: [],
  memberships: [],
  teams: [],
});

let seq = 0;
function event(payload: SessionEventPayload, ts = RESOLVED_AT): SessionEvent {
  seq += 1;
  return { id: seq, sessionId: "session", seq, ts, payload };
}

/** Distinctive option ids, so a raw id leaking into the row is unmistakable. */
const OPTION_SETS: Record<string, PermissionOption[]> = {
  acp: [
    { optionId: "opt-allow-once-x7", name: "Allow Once", kind: "allow_once" },
    { optionId: "opt-allow-always-x7", name: "Always Allow", kind: "allow_always" },
    { optionId: "opt-reject-once-x7", name: "Reject", kind: "reject_once" },
    { optionId: "opt-reject-always-x7", name: "Always Reject", kind: "reject_always" },
  ],
  codex: [
    { optionId: "accept", name: "Allow Once", kind: "allow_once" },
    { optionId: "acceptForSession", name: "Allow for Session", kind: "allow_always" },
    { optionId: "decline", name: "Reject", kind: "reject_once" },
    { optionId: "cancel", name: "Cancel", kind: "cancel" },
  ],
  kindless: [
    { optionId: "allow", name: "Allow" },
    { optionId: "deny", name: "Deny" },
    { optionId: "opt-trust-x7", name: "Trust This Configuration" },
  ],
};

const REASONS: Array<StructuredRequestResolutionReason | undefined> =
  [undefined, "submitted", "dismissed", "replaced", "expired", "provider_resolved"];

const EXPECTED_BY_REASON: Partial<Record<StructuredRequestResolutionReason, string>> = {
  dismissed: "Dismissed",
  replaced: "Replaced",
  expired: "Expired",
  provider_resolved: "Resolved by Provider",
};

function expectedWord(option: PermissionOption | undefined, optionId: string | null, reason?: StructuredRequestResolutionReason, parent = false): string {
  // The runner records a chosen Cancel as a dismissal (session-manager's permission_resolved).
  if (reason === "dismissed" && option?.kind === "cancel") return "Ended Early";
  if (!parent && reason && EXPECTED_BY_REASON[reason]) return EXPECTED_BY_REASON[reason]!;
  if (optionId === null) return "Dismissed";
  if (!option) return optionId === "auth:automatic-retry" ? "Rechecked Automatically" : "Another Account Selected";
  if (option.kind?.startsWith("allow") || (!option.kind && option.optionId === "allow")) return "Allowed";
  if (option.kind?.startsWith("reject") || (!option.kind && option.optionId === "deny")) return "Rejected";
  if (option.kind === "cancel") return "Ended Early";
  return "Resolved";
}

interface Case { item: TimelineItem; optionId: string | null; word: string }

/** Every resolution the timeline builds from the runner's events: each offered option, a dismissal,
 * the runner's own sign-in outcomes, every reason, and each again through a parent session. */
function permissionCases(): Case[] {
  const cases: Case[] = [];
  for (const [set, options] of Object.entries(OPTION_SETS)) {
    const choices: Array<string | null> = [...options.map((option) => option.optionId), null, "auth:automatic-retry", "auth:select-account"];
    for (const optionId of choices) {
      for (const reason of REASONS) {
        for (const parent of [false, true]) {
          const requestId = `req-${cases.length}`;
          const items = deriveTimeline([
            event({ kind: "permission_request", requestId, title: `Run Step ${set}`, options, context: { toolName: "Bash", input: "npm test" } }),
            event({
              kind: "permission_resolved", requestId, optionId,
              ...(reason ? { resolutionReason: reason } : {}),
              ...(parent ? { resolvedByParentSessionId: "parent-session-x7" } : {}),
            }),
          ]);
          const item = items.find((candidate) => candidate.kind === "permission")!;
          const option = options.find((candidate) => candidate.optionId === optionId);
          cases.push({ item: { ...item, id: cases.length + 1 }, optionId, word: expectedWord(option, optionId, reason, parent) });
        }
      }
    }
  }
  return cases;
}

function parentSession(): SessionView {
  return {
    id: "parent-session-x7", runnerId: "runner-1", workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Release Orchestrator\nCoordinate the release.", status: "running",
    column: "review", runId: null, useWorktree: false, worktreePath: null,
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  } as SessionView;
}

let policyNames!: GovernancePolicyNames;
function PolicyNamesProbe() {
  policyNames = useContext(GovernancePolicyNamesContext);
  return null;
}

async function mount(items: TimelineItem[], client: Partial<ApiClient> = {}, onOpenSession?: (id: string) => void) {
  const sockets: UiSocket[] = [];
  const connection: UiConnectionRuntime = {
    instanceId: `decision-records-${seq}`, runtimeKey: `decision-records-${seq}`,
    onCredentialChange: () => () => {},
    createSocket: () => {
      const socket: UiSocket = { readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
        onclose: null, onerror: null, send() {}, close() {} };
      sockets.push(socket);
      return socket;
    },
    close() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client_ = { ...api, ...client };
  const render = (shown: TimelineItem[]) => act(async () => {
    root.render(<ApiProvider client={client_}><StoreProvider connection={connection}>
      <GovernancePolicyNamesProvider>
        <PolicyNamesProbe />
        <ViewerIdentityContext.Provider value={soloViewer}>
          <EventTimeline ariaLabel="Decisions" items={shown} onOpenSession={onOpenSession} />
        </ViewerIdentityContext.Provider>
      </GovernancePolicyNamesProvider>
    </StoreProvider></ApiProvider>);
  });
  await render(items);
  const rows = () => [...container.querySelectorAll<HTMLDetailsElement>("details.tl-decision")];
  return {
    container,
    rows,
    render,
    online: () => act(async () => {
      sockets.at(-1)!.onmessage?.({ data: JSON.stringify({ type: "snapshot", runners: [], boxes: [], sessions: [parentSession()], runs: [], pods: [] }) });
      await Promise.resolve();
    }),
    unmount: () => act(async () => { root.unmount(); container.remove(); }),
  };
}

test("every permission resolution reads as a past-tense outcome, never an arrow or a raw option id (#2204)", async () => {
  const cases = permissionCases();
  assert.ok(cases.length > 200, `covers every combination (${cases.length})`);
  const view = await mount(cases.map((entry) => entry.item));
  try {
    const rows = view.rows();
    assert.equal(rows.length, cases.length, "each resolved permission is one Decision Record");
    rows.forEach((row, index) => {
      const { optionId, word } = cases[index]!;
      const text = row.textContent ?? "";
      const summary = row.querySelector("summary")!;
      assert.equal(row.querySelector(".tl-decision-outcome")?.textContent, word, `case ${index}: ${optionId}`);
      assert.doesNotMatch(text, /→/);
      assert.doesNotMatch(text, /opt-[a-z-]+-x7|parent-session-x7|req-\d+/, `case ${index}: no raw id`);
      if (optionId && !["allow", "deny", "cancel"].includes(optionId)) {
        assert.ok(!text.includes(optionId), `case ${index}: the option id ${optionId} is never shown`);
      }
      assert.doesNotMatch(summary.getAttribute("aria-label") ?? "", /x7|→/);
      // Facts appear once: Decided By at most once, the command in a code well, Recorded last.
      const terms = [...row.querySelectorAll("dt")].map((term) => term.textContent);
      assert.ok(terms.filter((term) => term === "Decided By").length <= 1);
      assert.equal(terms.at(-1), "Recorded");
      assert.equal(row.querySelector(".code-well pre")?.textContent, "npm test");
    });

    // The first case for each option is submitted by a person, not a parent.
    const allowed = rows[cases.findIndex((entry) => entry.optionId === "opt-allow-once-x7")]!;
    assert.equal(allowed.querySelector(".tl-decision-outcome")?.className, "tl-decision-outcome t-success");
    assert.equal(allowed.querySelector(".tl-decision-by")?.textContent, "by You");
    assert.ok(allowed.querySelector(".lucide-circle-check"), "a success outcome shows CircleCheck");
    const rejected = rows[cases.findIndex((entry) => entry.optionId === "opt-reject-once-x7")]!;
    assert.equal(rejected.querySelector(".tl-decision-outcome")?.className, "tl-decision-outcome t-neutral");
    assert.ok(rejected.querySelector(".lucide-circle-x"), "a neutral outcome shows CircleX");
    assert.equal(rejected.querySelector("summary")?.getAttribute("aria-label"), "Rejected Run Step acp by You");
    assert.match(rejected.querySelector("summary .tl-decision-time")?.getAttribute("title") ?? "", /2026.*:30:15/,
      "the absolute time, with seconds, is the relative time's tooltip");
    assert.equal(rejected.querySelector(".disclosure-chevron.lucide-chevron-right") !== null, true, "the §5.5 chevron");
  } finally {
    await view.unmount();
  }
});

test("a parent session's decision names the parent by title and links to it, never by id", async () => {
  const items = deriveTimeline([
    event({ kind: "permission_request", requestId: "parent-req", title: "Push Release Branch", options: OPTION_SETS.acp! }),
    event({ kind: "permission_resolved", requestId: "parent-req", optionId: "opt-allow-once-x7", resolvedByParentSessionId: "parent-session-x7" }),
  ]);
  const opened: string[] = [];
  const view = await mount(items, {}, (id) => opened.push(id));
  try {
    const row = () => view.rows()[0]!;
    assert.equal(row().querySelector(".tl-decision-by")?.textContent, "by Parent Session", "neutral until the parent's title loads");
    await view.online();
    assert.equal(row().querySelector(".tl-decision-by")?.textContent, "by Release Orchestrator");
    assert.equal(row().querySelector("summary")?.getAttribute("aria-label"), "Allowed Push Release Branch by Release Orchestrator");
    const link = row().querySelector<HTMLButtonElement>("dd button.link")!;
    assert.equal(link.textContent, "Release Orchestrator");
    await act(async () => { link.click(); });
    assert.deepEqual(opened, ["parent-session-x7"]);
    assert.doesNotMatch(view.container.textContent ?? "", /parent-session-x7/);
  } finally {
    await view.unmount();
  }
});

function audit(overrides: Partial<GovernanceAuditEntry>): GovernanceAuditEntry {
  return {
    auditId: "audit-1", requestId: "hook-1", approvalKind: "policy_hook", stage: "resolution", outcome: "allowed",
    actor: { kind: "human", id: "alice" }, scope: { sessionId: "session", runnerId: "runner-1", toolName: "Bash" },
    timestamp: RESOLVED_AT, ...overrides,
  };
}

test("policy decisions load the policy names once, name the policy, and keep its id behind Copy Audit ID", async () => {
  const decisions = governanceDecisions([
    audit({ auditId: "audit-block", requestId: "hook-block", stage: "policy_decision", outcome: "denied",
      actor: { kind: "policy", id: "deny-shell-x7" }, governancePolicyId: "deny-shell-x7" }),
    audit({ auditId: "audit-timeout", requestId: "hook-timeout", outcome: "timed_out",
      actor: { kind: "system", id: "policy-ask-timeout" }, governancePolicyId: "ask-deploys-x7" }),
  ]);
  let loads = 0;
  const governancePolicies: ApiClient["governancePolicies"] = async () => {
    loads += 1;
    return { policies: [
      { policyId: "deny-shell-x7", name: "No Shell in Production" },
      { policyId: "ask-deploys-x7", name: "Ask Before Deploys" },
    ] as never };
  };
  const view = await mount(decisions.map((decision, index): TimelineItem => ({ kind: "governance_decision", id: -1 - index, decision })),
    { governancePolicies });
  try {
    assert.equal(loads, 0, "names wait for an authenticated connection");
    const [blocked, timedOut] = view.rows();
    assert.equal(blocked!.querySelector(".tl-decision-by")?.textContent, "by Policy");
    await view.online();
    assert.equal(loads, 1, "one load serves every row");
    assert.equal(blocked!.querySelector(".tl-decision-outcome")?.textContent, "Blocked");
    assert.equal(blocked!.querySelector(".tl-decision-outcome")?.className, "tl-decision-outcome t-danger");
    assert.ok(blocked!.querySelector(".lucide-shield-x"));
    assert.equal(blocked!.querySelector(".tl-decision-by")?.textContent, "by No Shell in Production");
    assert.equal(timedOut!.querySelector(".tl-decision-outcome")?.textContent, "Timed Out");
    assert.equal(timedOut!.querySelector(".tl-decision-outcome")?.className, "tl-decision-outcome t-warning");
    assert.ok(timedOut!.querySelector(".lucide-timer-off"));
    assert.equal(timedOut!.querySelector(".tl-decision-by")?.textContent, "by Ask Before Deploys");

    blocked!.open = true;
    const terms = [...blocked!.querySelectorAll("dt")].map((term) => term.textContent);
    assert.deepEqual(terms, ["Decided By", "Tool", "Recorded"]);
    assert.equal(terms.filter((term) => term === "Decided By").length, 1);
    assert.doesNotMatch(view.container.textContent ?? "", /x7|audit-|hook-|Policy ·/, "ids are only copied");

    let copied = "";
    Object.defineProperty(domWindow.navigator, "clipboard", {
      configurable: true, value: { writeText: async (text: string) => { copied = text; } },
    });
    const copy = [...blocked!.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy Audit ID"))!;
    await act(async () => { copy.click(); });
    assert.equal(copied, "Audit ID: audit-block\nRequest ID: hook-block\nPolicy ID: deny-shell-x7");
  } finally {
    await view.unmount();
  }
});

test("a chosen Cancel, which the runner records as a dismissal, reads Ended Early", async () => {
  const items = deriveTimeline([
    event({ kind: "permission_request", requestId: "codex-cancel", title: "Run Migrations", options: OPTION_SETS.codex! }),
    event({ kind: "permission_resolved", requestId: "codex-cancel", optionId: "cancel", resolutionReason: "dismissed" }),
    event({ kind: "permission_request", requestId: "plain-dismiss", title: "Run Seeds", options: OPTION_SETS.codex! }),
    event({ kind: "permission_resolved", requestId: "plain-dismiss", optionId: null, resolutionReason: "dismissed" }),
  ]);
  const view = await mount(items);
  try {
    assert.deepEqual(view.rows().map((row) => row.querySelector(".tl-decision-outcome")?.textContent), ["Ended Early", "Dismissed"]);
  } finally {
    await view.unmount();
  }
});

test("policy names reload once for a policy they lack, and again after a policy is saved here", async () => {
  const policies = [{ policyId: "alpha-x7", name: "Alpha" }];
  let loads = 0;
  const governancePolicies: ApiClient["governancePolicies"] = async () => {
    loads += 1;
    return { policies: policies.map((policy) => ({ ...policy })) as never };
  };
  const blockedBy = (policyId: string, index: number): TimelineItem => ({
    kind: "governance_decision", id: -100 - index,
    decision: governanceDecisions([audit({ auditId: `audit-${policyId}`, requestId: `hook-${policyId}`, stage: "policy_decision",
      outcome: "denied", actor: { kind: "policy", id: policyId }, governancePolicyId: policyId })])[0]!,
  });
  const view = await mount([blockedBy("alpha-x7", 0)], { governancePolicies });
  const by = () => view.rows().map((row) => row.querySelector(".tl-decision-by")?.textContent);
  try {
    await view.online();
    assert.equal(loads, 1);
    assert.deepEqual(by(), ["by Alpha"]);

    // A policy created after the names loaded, without a reconnect.
    policies.push({ policyId: "beta-x7", name: "Beta" });
    await view.render([blockedBy("alpha-x7", 0), blockedBy("beta-x7", 1)]);
    assert.equal(loads, 2, "a row naming an unknown policy reloads the names");
    assert.deepEqual(by(), ["by Alpha", "by Beta"]);

    // A policy that no longer exists asks once, not on every render.
    await view.render([blockedBy("alpha-x7", 0), blockedBy("beta-x7", 1), blockedBy("gone-x7", 2)]);
    await view.render([blockedBy("alpha-x7", 0), blockedBy("beta-x7", 1), blockedBy("gone-x7", 2)]);
    assert.equal(loads, 3);
    assert.deepEqual(by(), ["by Alpha", "by Beta", "by Policy"]);

    // Saving a policy here (Settings › Behavior) reloads them, so a rename shows.
    policies[0]!.name = "Alpha Renamed";
    await act(async () => { policyNames.invalidate(); });
    assert.deepEqual(by(), ["by Alpha Renamed", "by Beta", "by Policy"]);
    // The reload, then one more ask for the policy that is still gone; then it settles.
    assert.equal(loads, 5);
    await view.render([blockedBy("alpha-x7", 0), blockedBy("beta-x7", 1), blockedBy("gone-x7", 2)]);
    assert.equal(loads, 5);
  } finally {
    await view.unmount();
  }
});
