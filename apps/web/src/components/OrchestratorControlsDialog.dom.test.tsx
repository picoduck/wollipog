import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import type {
  CampaignLaunchPreflight,
  OrchestratorCampaignProjection,
  OrchestratorCampaignPolicy,
  ParentControlDecisionPolicy,
  ParentControlMode,
  SessionView,
  WorkflowDecisionAuthority,
} from "@wollipog/protocol";
import { api, ApiError, createApiClient, type ApiClient } from "../api.js";
import { API_REQUEST_DEADLINE_MS, createBrowserApiTransport } from "../api-transport.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";
import { fireDomEvent } from "./test-dom-events.js";
import {
  ORCHESTRATOR_CONTROLS_CONFLICT,
  ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS,
  OrchestratorControlsDialog,
  WORKFLOW_DECISION_LABELS,
  childSessionRequestsNote,
  orchestratorControlsSummary,
  workflowDecisionsNote,
  workflowDecisionsSummary,
} from "./OrchestratorControlsDialog.js";

/**
 * #2192: an Orchestrator's Child Session Requests choice and its five workflow gates live in a
 * close-only dialog. Each change saves at once, with a "Saved" check, against the current policy
 * revision; a failure is a danger notice inside the dialog, and the stored value comes back.
 */

const domWindow = new Window({ url: "http://localhost/" });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const HUMAN_ONLY: ParentControlDecisionPolicy = {
  implementation_question: "human",
  pr_merge: "human",
  merged_branch_deletion: "human",
  follow_up_issue_publication: "human",
  ui_evidence_approval: "human",
  review_round_extension: "human",
};

const POLICY: OrchestratorCampaignPolicy = {
  version: 1,
  behavior: {
    childHarness: { agentId: "claude", driver: "claude-code", context: { kind: "native" } },
    childModel: "claude-opus-5",
    childEffort: "high",
    maximumConcurrentChildren: 6,
    followUps: "recommend_only",
    completion: "retain",
  },
  delegation: { parentControl: "off", decisions: { ...HUMAN_ONLY } },
  sources: {
    behavior: {
      childHarness: "user_default",
      childModel: "session_override",
      childEffort: "user_default",
      maximumConcurrentChildren: "user_default",
      followUps: "system_default",
      completion: "system_default",
    },
    delegation: {
      parentControl: "active_campaign",
      decisions: {
        implementation_question: "legacy_session",
        pr_merge: "legacy_session",
        merged_branch_deletion: "legacy_session",
        follow_up_issue_publication: "legacy_session",
        ui_evidence_approval: "legacy_session",
        review_round_extension: "legacy_session",
      },
    },
  },
} as OrchestratorCampaignPolicy;

const CAMPAIGN = {
  status: "waiting_human",
  policyRevision: 3,
  decisionOwners: { ...HUMAN_ONLY },
  limits: { maximumConcurrentChildren: 6, occupied: 2, remaining: 4, costBudgetUsd: null, maxToolCalls: null },
  uiEvidenceReview: { status: "unavailable", effectiveOwner: "human", reasonCode: "harness_unsupported", reason: "No image reader." },
  children: { total: 3, active: 2, waitingHuman: 1, blocked: 0, verified: 0, cleanupPending: 0 },
  pendingDecisions: { human: 1, orchestrator: 0 },
  followUps: { unique: 2, duplicates: 1 },
} as OrchestratorCampaignProjection;

function orchestrator(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "orch",
    role: "orchestrator",
    permissionMode: "orchestrator",
    driver: "claude-code",
    parentControl: "off",
    parentControlPolicy: { revision: 3, decisions: { ...HUMAN_ONLY, implementation_question: "orchestrator", follow_up_issue_publication: "orchestrator" } },
    orchestratorPolicy: POLICY,
    orchestratorCampaign: CAMPAIGN,
    ...overrides,
  } as unknown as SessionView;
}

interface Harness {
  dialog: () => HTMLElement;
  rerender: (session: SessionView) => Promise<void>;
  changed: SessionView[];
  closed: () => number;
  /** Unmounts the dialog, as closing it does. */
  unmount: () => Promise<void>;
}

const unmounts = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const unmount of [...unmounts]) await unmount();
});
// After the unmounts above, so React removes its portals before the body is cleared.
installDomTestCleanup(domWindow);

async function open(
  session: SessionView,
  client: Partial<ApiClient>,
  refusal: string | null = null,
  { strict = false }: { strict?: boolean } = {},
): Promise<Harness> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const changed: SessionView[] = [];
  let closed = 0;
  const merged = { ...api, ...client } as ApiClient;
  let alive = true;
  const render = (current: SessionView): void => {
    if (!alive) return;
    const dialog = (
      <ApiProvider client={merged}>
        <OrchestratorControlsDialog
          session={current}
          refusal={refusal}
          onClose={() => { closed += 1; }}
          // The store's part: the session the dialog is given follows what it reports.
          onSessionChanged={(next) => { changed.push(next); render(next); }}
        />
      </ApiProvider>
    );
    // The app renders under StrictMode, whose mount runs every effect's setup, cleanup and setup.
    root.render(strict ? <React.StrictMode>{dialog}</React.StrictMode> : dialog);
  };
  await act(async () => render(session));
  const unmount = async () => {
    if (!unmounts.delete(unmount)) return;
    alive = false;
    await act(async () => root.unmount());
    container.remove();
  };
  unmounts.add(unmount);
  return {
    dialog: () => {
      const node = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
      assert.ok(node, "the dialog is open");
      return node;
    },
    rerender: (next) => act(async () => render(next)),
    changed,
    closed: () => closed,
    unmount,
  };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

function fullCampaign(): SessionView {
  return orchestrator({ orchestratorPolicy: { ...POLICY, control: { mode: "full_control", boundary: {
    version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo", objective: "Deliver #12",
    authorizedByUserId: "fixture-human", authorizedAt: 1, operations: ["pr_merge"], delegatablePolicyIds: [],
  } } } });
}

test("explicit Full Control revocation uses the current revision and preserves campaign selections", async () => {
  const initial = fullCampaign();
  const writes: unknown[] = [];
  const fresh = { ...initial, orchestratorPolicy: { ...initial.orchestratorPolicy!, control: { mode: "custom" as const } },
    parentControlPolicy: { ...initial.parentControlPolicy!, revision: 4 } };
  const preflights: unknown[] = [];
  const harness = await open(initial, {
    revokeCampaignControl: async (...args) => { writes.push(args); return fresh; },
    fullControlEnablePreflight: async (...args) => { preflights.push(args); return { preflight: enablePreflight(false), expectedRevision: 4 }; },
  });
  await act(async () => [...harness.dialog().querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === "Revoke Full Control")!.click());
  assert.deepEqual(writes, [["orch", 3]]);
  assert.equal(harness.changed[0]!.parentControlPolicy!.revision, 4);
  assert.deepEqual(harness.changed[0]!.orchestratorPolicy!.behavior, initial.orchestratorPolicy!.behavior);
  assert.deepEqual(harness.changed[0]!.orchestratorPolicy!.execution, initial.orchestratorPolicy!.execution);
  assert.match(harness.dialog().textContent ?? "", /Effective Mode: Custom/);
  // The choice follows the revoked root: Custom, with no enable action or check offered back.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(harness.dialog().querySelector<HTMLInputElement>('[data-control-mode="custom"]')!.checked, true);
  assertNoDomNode(harness.dialog().querySelector('section[aria-label="Enable Full Control"]'));
  assert.deepEqual(footerButtons(harness.dialog()), ["Done"]);
  assert.deepEqual(preflights, []);
});

test("a conflicting Full Control revocation reloads without replay and descendants cannot revoke", async () => {
  const initial = fullCampaign();
  let writes = 0;
  const fresh = { ...initial, parentControlPolicy: { ...initial.parentControlPolicy!, revision: 4 } };
  const harness = await open(initial, {
    revokeCampaignControl: async () => { writes++; throw new ApiError("campaign authority revision changed", 409); },
    session: async () => ({ session: fresh }),
  });
  const revoke = () => [...harness.dialog().querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === "Revoke Full Control")!;
  await act(async () => revoke().click());
  assert.equal(writes, 1);
  assert.equal(harness.changed[0]!.parentControlPolicy!.revision, 4);
  assert.match(harness.dialog().textContent ?? "", /These controls changed elsewhere/);
  await harness.rerender({ ...fresh, parentSessionId: "root", orchestratorCampaign: { ...CAMPAIGN, control: initial.orchestratorPolicy!.control!, policyRevision: 4 } });
  assert.equal(revoke().disabled, true);
  assert.match(harness.dialog().textContent ?? "", /Change control on the root campaign/);
});

test("a descendant displays the current root mode after revoke and does not treat its copied mode as effective", async () => {
  const initial = fullCampaign();
  const harness = await open({ ...initial, parentSessionId: "root",
    orchestratorCampaign: { ...CAMPAIGN, control: { mode: "custom" }, policyRevision: 4 } }, {});
  assert.match(harness.dialog().textContent ?? "", /Effective Mode: Custom/);
  assertNoDomNode(harness.dialog().querySelector('[data-control-mode]'), "a descendant cannot enable Full Control");
  assert.equal([...harness.dialog().querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Revoke Full Control"), false);
  await harness.unmount();
  const legacy = await open({ ...initial, id: "legacy-nested", parentSessionId: "root", orchestratorCampaign: undefined }, {});
  assert.match(legacy.dialog().textContent ?? "", /Effective Mode: Current Root State Not Reported/);
});

/** A server preflight in the shape the enable route returns. Not ready means a genuine impossibility. */
function enablePreflight(ready: boolean): CampaignLaunchPreflight {
  const verified = (id: CampaignLaunchPreflight["capabilities"][number]["id"], capability: string) => ({ id, capability, state: "verified" as const, mandatory: true, reason: `${capability} is verified.` });
  const blocker = "The runner could not verify this campaign's repository; check that the runner is online and the origin is github.com.";
  return { ready, digest: (ready ? "b" : "a").repeat(64), inspectionCancellation: "supported",
    summary: { repository: ready ? "owner/repo" : null, issueNumbers: [12], objective: "Deliver #12",
      root: { agentId: "claude", driver: "claude-code", model: "claude-opus-5-5", effort: null, isolation: { mode: "provider", network: "inherit" },
        strictProjectIsolation: false, integrationIsolation: false, completion: "retain" },
      budget: { costUsd: null, toolCalls: null, concurrency: 4, acceptedFollowUps: 0, source: "unset", reviewIncluded: false },
      review: { controlled: false, statement: "The regular cross-model review workflow, because controlled review is unavailable." },
      followUps: { policy: "recommend_only", relatedFollowUps: false, maxIssues: 1, closureReasons: ["completed"] },
      evidence: { statement: "The Orchestrator reviews screenshots.",
        destination: { kind: "private_session_artifacts", configurationId: "session_artifacts:org", disclosureRevision: 1 }, provider: null, envelope: false },
      humanRequired: [],
      blockers: ready ? [] : [{ capability: "Repository and Issue Scope", reason: blocker }] },
    capabilities: [ready ? verified("repository_scope", "Repository and Issue Scope")
      : { id: "repository_scope", capability: "Repository and Issue Scope", state: "unsupported", mandatory: true, reason: blocker },
      verified("authority_contract", "Full Control Authority")],
    advanced: { proposal: null, plan: {} as never, humanRequiredRequests: [] } };
}

const footerButtons = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")].map((button) => button.textContent);

/** Enabling adds nothing to fill in or review (#2940): no summary, limits, readiness or Advanced. */
function assertNoEnableForm(dialog: HTMLElement): void {
  const text = dialog.textContent ?? "";
  for (const copy of [/Ready to Enable/, /Can't Enable Yet/, /Campaign Limits/, /Advanced/, /No Limit/, /Checking Full Control Readiness/]) {
    assert.doesNotMatch(text, copy);
  }
  assertNoDomNode(dialog.querySelector('section[aria-label="Enable Full Control"]'));
  assertNoDomNode(dialog.querySelector("fieldset"));
}

test("choosing Full Control on a live campaign shows no form, and Enable Full Control is the one action", async () => {
  const preflights: unknown[] = [];
  const enables: unknown[] = [];
  const harness = await open(orchestrator(), {
    fullControlEnablePreflight: async (id, body) => { preflights.push([id, body]); return { preflight: enablePreflight(true), expectedRevision: 2 }; },
    enableFullControl: async (...args) => { enables.push(args); return fullCampaign(); },
  });
  const dialog = harness.dialog();
  assert.deepEqual(footerButtons(dialog), ["Done"]);
  await act(async () => dialog.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
  assert.match(dialog.textContent ?? "", /The Orchestrator runs this campaign end to end\./);
  assertNoEnableForm(dialog);
  assert.deepEqual(preflights, [], "nothing is checked or shown before the action");
  assert.deepEqual(footerButtons(dialog), ["Done", "Enable Full Control"]);
  const enable = dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!;
  assert.equal(enable.disabled, false);
  await act(async () => enable.click());
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(preflights, [["orch", {}]]);
  assert.deepEqual(enables, [["orch", { expectedRevision: 2, preflightDigest: "b".repeat(64) }]]);
  assert.equal(harness.changed.at(-1)!.orchestratorPolicy!.control!.mode, "full_control");
  assert.match(dialog.textContent ?? "", /Effective Mode: Full Control/);
  assert.deepEqual(footerButtons(dialog), ["Done"], "an enabled campaign has nothing left to enable");
  assert.ok([...dialog.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Revoke Full Control"));
});

test("a genuine impossibility on a live campaign is one inline error, and nothing changes", async () => {
  const enables: unknown[] = [];
  const harness = await open(orchestrator(), {
    fullControlEnablePreflight: async () => ({ preflight: enablePreflight(false), expectedRevision: 2 }),
    enableFullControl: async (...args) => { enables.push(args); return fullCampaign(); },
  });
  const dialog = harness.dialog();
  await act(async () => dialog.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
  await act(async () => dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!.click());
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(enables, []);
  assert.deepEqual(harness.changed, []);
  const alerts = [...dialog.querySelectorAll<HTMLElement>('[role="alert"]')];
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.textContent ?? "", /Couldn't Enable Full Control/);
  assert.match(alerts[0]!.textContent ?? "", /could not verify this campaign's repository; check that the runner is online/);
  assertNoEnableForm(dialog);
  assert.match(dialog.textContent ?? "", /Effective Mode: Custom/);
  await act(async () => dialog.querySelector<HTMLInputElement>('[data-control-mode="custom"]')!.click());
  assert.deepEqual(footerButtons(dialog), ["Done"], "Custom has no enable action");
  assert.equal(dialog.querySelectorAll('[role="alert"]').length, 0, "and no stale error");
});

test("a refused enable from the server reads as its own reason", async () => {
  const harness = await open(orchestrator(), {
    fullControlEnablePreflight: async () => ({ preflight: enablePreflight(true), expectedRevision: 2 }),
    enableFullControl: async () => { throw new ApiError("Full Control cannot be enabled: Campaign usage contains unpriced records.", 409); },
  });
  const dialog = harness.dialog();
  await act(async () => dialog.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
  await act(async () => dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!.click());
  await act(async () => { await Promise.resolve(); });
  const alert = dialog.querySelector<HTMLElement>('[role="alert"]')!;
  assert.match(alert.textContent ?? "", /Couldn't Enable Full ControlCampaign usage contains unpriced records\./);
  assert.deepEqual(harness.changed, []);
});

function gate(dialog: HTMLElement, label: string): HTMLElement {
  const group = dialog.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
  assert.ok(group, `${label} has its own segmented control`);
  return group;
}

function option(group: HTMLElement, name: string): HTMLElement {
  const found = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) => node.textContent === name);
  assert.ok(found, `${name} is an option`);
  return found;
}

function sectionTitles(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll(".section-title")].map((node) => node.textContent ?? "");
}

/** A Full Control root as the server projects it: only PR merge is inside the boundary, so the
 * effective owners differ from the saved Custom choices (which delegate two other gates). */
function fullControlProjection(): SessionView {
  const base = fullCampaign();
  return { ...base, parentControl: "questions_and_approvals",
    orchestratorCampaign: { ...CAMPAIGN, control: base.orchestratorPolicy!.control, policyRevision: 3,
      decisionOwners: { ...HUMAN_ONLY, pr_merge: "orchestrator" } } } as SessionView;
}

test("under Full Control the dialog shows the server's effective owners read-only, the Human Required exceptions, and what returns after Revoke", async () => {
  const harness = await open(fullControlProjection(), {});
  const dialog = harness.dialog();
  const text = dialog.textContent ?? "";
  // Nothing editable that has no effect while Full Control decides.
  assertNoDomNode(dialog.querySelector('[role="radiogroup"][aria-label="Child Session Requests"]'));
  for (const label of Object.values(WORKFLOW_DECISION_LABELS)) assertNoDomNode(dialog.querySelector(`[role="radiogroup"][aria-label="${label}"]`));
  const fact = (term: string) => [...dialog.querySelectorAll("dt")].find((node) => node.textContent === term)?.nextElementSibling?.textContent;
  assert.equal(fact("PR Merge Approval"), "Orchestrator");
  assert.equal(fact("Implementation Questions"), "HumanNot part of this campaign's authorization.",
    "a saved Custom delegation outside the boundary is shown as the Human's, with why");
  assert.equal(fact("UI Evidence Approval"), "HumanNo image reader.", "the evidence fallback reason is the server's");
  assert.equal(fact("Questions"), "Human");
  assert.equal(fact("One-Time Approvals"), "Human");
  assert.match(text, /Your Custom choice, Questions and Approvals, applies again only after you revoke Full Control\./);
  assert.match(text, /Your per-gate choices apply again only after you revoke to Custom\./);
  // Only what truly remains comes to the Human (#2940): evidence this authorization keeps human,
  // and the person's own Human Required rules. An older server's absent list still discloses those.
  assert.match(text, /UI Evidence Review: No image reader\./);
  assert.match(text, /Human Required Governance Rules: Asks from rules you marked Human Required still come to you under Full Control\./);
  assert.doesNotMatch(text, /Secrets and Sign-In|Relative Shell Commands|Git Commands|Persistent Permission Grants/);
  assert.match(text, /Requests for credentials, sign-in, wider provider access or a lasting permission grant are declined automatically and shown as blocked work in Campaign Status\. You are not asked\./);
  assert.match(text, /credentials, sign-in or wider access are declined as blocked work/);
  assert.ok([...dialog.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Revoke Full Control"));
});

test("under Full Control with no Human Required rule and delegated evidence, nothing comes to the Human", async () => {
  const view = fullControlProjection();
  const harness = await open({ ...view, orchestratorCampaign: { ...view.orchestratorCampaign!, fullControlHumanRequired: [],
    decisionOwners: { ...view.orchestratorCampaign!.decisionOwners, ui_evidence_approval: "orchestrator" as const },
    uiEvidenceReview: { status: "available" as const, effectiveOwner: "orchestrator" as const } } } as SessionView, {});
  const section = [...harness.dialog().querySelectorAll("section")]
    .find((candidate) => candidate.querySelector(".section-title")?.textContent === "Human Required")!;
  assert.match(section.textContent ?? "", /^Human RequiredNothing comes to you under Full Control\.Requests for credentials/);
  assertNoDomNode(section.querySelector("ul"));
});

test("under Full Control the video line follows the server's campaign fact, and neither video nor external evidence reaches the Human", async () => {
  const section = (dialog: Element, title: string) => [...dialog.querySelectorAll("section")]
    .find((candidate) => candidate.querySelector(".section-title")?.textContent === title)?.textContent ?? "";
  const humanRequired = (dialog: Element) => section(dialog, "Human Required");
  const uninspectable = (dialog: Element) => section(dialog, "Evidence the Orchestrator Can't Inspect");
  const withVideo = (videoEvidenceReview?: { status: "available" | "unavailable"; reason: string }) => {
    const view = fullControlProjection();
    return { ...view, orchestratorCampaign: { ...view.orchestratorCampaign!,
      decisionOwners: { ...view.orchestratorCampaign!.decisionOwners, ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator" as const },
      uiEvidenceReview: { status: "available" as const, effectiveOwner: "orchestrator" as const },
      ...(videoEvidenceReview ? { videoEvidenceReview } : {}) } } as SessionView;
  };
  const certified = "The Orchestrator hands video evidence to the certified media-only reviewer and decides from its verdict.";
  // The retention disclosure's video sentence follows the same fact, so the two never contradict.
  const disclosure = (dialog: Element) => [...dialog.querySelectorAll(".orchestrator-gate-helper")]
    .find((node) => node.textContent?.includes("evidence images are sent to its selected model/provider"))?.textContent ?? "";
  // So does Campaign Behavior's evidence notice.
  const behaviorNotice = (dialog: Element) => [...dialog.querySelectorAll(".notice")]
    .find((node) => node.textContent?.includes("reviews image evidence attached as Session artifacts"))?.textContent ?? "";
  const external = /External Evidence Review: The Orchestrator can't open evidence stored outside private Session artifacts \(links only\), so it asks for screenshots or denies the claim as unproven\./;
  let harness = await open(withVideo({ status: "available", reason: certified }), {});
  let dialog = harness.dialog();
  assert.match(disclosure(dialog), /In this campaign, video evidence attached as a Session artifact goes to the certified media-only reviewer instead/);
  assert.doesNotMatch(disclosure(dialog), /requires human review/, "a certified campaign's disclosure does not send video to a person");
  assert.match(behaviorNotice(dialog), /Video goes to this campaign's certified media-only reviewer\./);
  assert.match(behaviorNotice(dialog), /Under Full Control, externally stored evidence never goes to a person either\./);
  assert.doesNotMatch(humanRequired(dialog), /Video Evidence Review|External Evidence Review/);
  assert.doesNotMatch(uninspectable(dialog), /Video Evidence Review/, "certified video is inspectable");
  assert.match(uninspectable(dialog), external);
  assert.ok([...dialog.querySelectorAll(".orchestrator-gate-helper")].some((node) =>
    node.textContent === `Video Evidence Review: ${certified}`), "the delegation is stated where the gates are");
  await harness.unmount();

  const uncertified = "The Orchestrator can't watch video because no current live proof certifies the media-only reviewer on the Orchestrator's machine. It asks for screenshots or denies the claim as unproven.";
  harness = await open(withVideo({ status: "unavailable", reason: uncertified }), {});
  dialog = harness.dialog();
  assert.ok(uninspectable(dialog).includes(`Video Evidence Review: ${uncertified}`), "the server's reason is shown");
  assert.doesNotMatch(humanRequired(dialog), /Video Evidence Review|External Evidence Review/);
  assert.match(disclosure(dialog), /In this campaign, video evidence is never sent to a person: the Orchestrator asks for screenshots instead or denies the claim as unproven\./);
  assert.doesNotMatch(disclosure(dialog), /certified media-only reviewer|requires human review/);
  assert.match(behaviorNotice(dialog), /It asks for screenshots instead of video it can't watch, or denies the claim as unproven\./);
  assert.doesNotMatch(behaviorNotice(dialog), /normally goes to a person|Externally stored evidence goes to a person/);
  assert.ok(![...dialog.querySelectorAll(".orchestrator-gate-helper")].some((node) => node.textContent?.startsWith("Video Evidence Review")));
  await harness.unmount();

  harness = await open(withVideo(), {});
  dialog = harness.dialog();
  assert.match(uninspectable(dialog), /Video Evidence Review: The Orchestrator can't watch video yet, so it asks for screenshots or denies the claim as unproven\./,
    "an older server without the fact still never routes video to the Human under Full Control");
  assert.match(disclosure(dialog), /video evidence is never sent to a person/, "and neither does its disclosure");
  assert.match(uninspectable(dialog), external);
});

test("under Full Control without a reported projection, owners are Not Reported rather than guessed", async () => {
  const harness = await open(fullCampaign(), {});
  const fact = (term: string) => [...harness.dialog().querySelectorAll("dt")].find((node) => node.textContent === term)?.nextElementSibling?.textContent;
  assert.equal(fact("PR Merge Approval"), "Not Reported");
  assertNoDomNode(harness.dialog().querySelector('[role="radiogroup"][aria-label="PR Merge Approval"]'));
});

/** A descendant whose root's control the server does not report: its copied policy delegates two
 * gates, while the server's effective owners keep every gate but PR Merge Approval with a person. */
function unknownRootDescendant(campaign: OrchestratorCampaignProjection | null = { ...CAMPAIGN, decisionOwners: { ...HUMAN_ONLY, pr_merge: "orchestrator" } }): SessionView {
  return { ...fullCampaign(), id: "nested", parentSessionId: "root", parentControl: "questions_and_approvals", orchestratorCampaign: campaign ?? undefined } as SessionView;
}

test("a descendant whose root control is unknown shows the effective owners read-only and offers nothing editable", async () => {
  const writes: unknown[] = [];
  const harness = await open(unknownRootDescendant(), {
    setParentControl: async (...args) => { writes.push(args); return unknownRootDescendant(); },
    setParentControlPolicy: async (...args) => { writes.push(args); return unknownRootDescendant(); },
  });
  const dialog = harness.dialog();
  const text = dialog.textContent ?? "";
  assert.match(text, /Effective Mode: Current Root State Not Reported/);
  assertNoDomNode(dialog.querySelector('[role="radiogroup"]'), "no Child Session Requests rows and no gate is editable");
  assertNoDomNode(dialog.querySelector("input"), "nothing in the dialog takes input");
  assert.deepEqual(sectionTitles(dialog), ["Orchestrator Control", "Child Session Requests", "Workflow Decisions", "Campaign Behavior"]);
  assert.match(text, /The root campaign's control isn't reported\. Who answers these isn't known here, so they can't be changed until it is\./);
  assert.match(text, /These are the owners Wollipog applies, and they can't be changed here until it is\./);
  const fact = (term: string) => [...dialog.querySelectorAll("dt")].find((node) => node.textContent === term)?.nextElementSibling?.textContent;
  assert.equal(fact("PR Merge Approval"), "Orchestrator", "the server's effective owner, not the copied Human choice");
  assert.equal(fact("Implementation Questions"), "HumanSet by the root campaign.", "a copied Orchestrator choice is not shown as current");
  assert.equal(fact("UI Evidence Approval"), "HumanNo image reader.", "the evidence fallback keeps the server's reason");
  assert.deepEqual(writes, []);
  await harness.unmount();

  // No projection at all: nothing is reported, so nothing is guessed either.
  const bare = await open(unknownRootDescendant(null), {});
  const bareFact = (term: string) => [...bare.dialog().querySelectorAll("dt")].find((node) => node.textContent === term)?.nextElementSibling?.textContent;
  for (const label of Object.values(WORKFLOW_DECISION_LABELS)) assert.equal(bareFact(label), "Not Reported", label);
  assertNoDomNode(bare.dialog().querySelector('[role="radiogroup"]'));
});

test("a descendant with a reported Custom root keeps its editable gates", async () => {
  const harness = await open({ ...unknownRootDescendant(), orchestratorCampaign: { ...CAMPAIGN, control: { mode: "custom" }, policyRevision: 3 } } as SessionView, {});
  assert.ok(harness.dialog().querySelector('[role="radiogroup"][aria-label="Child Session Requests"]'));
  gate(harness.dialog(), "PR Merge Approval");
});

test("the summaries count the gates that stay with a person", () => {
  assert.equal(workflowDecisionsSummary(HUMAN_ONLY), "6 of 6 decisions stay with a person.");
  assert.equal(
    workflowDecisionsSummary({ ...HUMAN_ONLY, pr_merge: "orchestrator", implementation_question: "orchestrator" }),
    "4 of 6 decisions stay with a person.",
  );
  assert.equal(
    workflowDecisionsSummary({
      implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "human", review_round_extension: "orchestrator",
    }),
    "1 of 6 decisions stays with a person.",
  );
  assert.equal(orchestratorControlsSummary({ parentControl: "questions", parentControlPolicy: undefined }),
    "Child session requests: Questions.", "a control plane without typed gates summarizes the one choice it has");
  // Under Full Control the summaries describe the effective owners, never the inactive Custom choices.
  const full = fullControlProjection();
  assert.equal(orchestratorControlsSummary(full), "Full Control: 5 of 6 decisions stay with a person.");
  assert.equal(childSessionRequestsNote(full), "Full Control");
  assert.equal(orchestratorControlsSummary({ ...full, orchestratorCampaign: undefined }), "Full Control.");
  // Under Custom the summaries count the effective owners too: the saved choices delegate two gates,
  // but the server reports one of them routed to a person.
  const custom = orchestrator({ orchestratorCampaign: { ...CAMPAIGN, decisionOwners: { ...HUMAN_ONLY, implementation_question: "orchestrator" } } });
  assert.equal(workflowDecisionsNote(custom), "5 of 6 decisions stay with a person.");
  assert.equal(workflowDecisionsNote({ ...custom, orchestratorCampaign: undefined }), "4 of 6 decisions stay with a person.",
    "without a projection the saved choices are all there is");
  // An unknown root: the effective owners when reported, and never the descendant's copied choices.
  assert.equal(workflowDecisionsNote(unknownRootDescendant()), "5 of 6 decisions stay with a person.");
  assert.equal(childSessionRequestsNote(unknownRootDescendant()), "Not Reported");
  assert.equal(workflowDecisionsNote(unknownRootDescendant(null)), "The root campaign's control isn't reported.");
  assert.equal(orchestratorControlsSummary({ ...unknownRootDescendant(null), parentControlPolicy: undefined }),
    "Child session requests: Not Reported.");
});

test("the dialog has three titled sections, the campaign's facts and a close-only footer", async () => {
  const harness = await open(orchestrator(), {});
  const dialog = harness.dialog();
  assert.equal(dialog.querySelector(".modal-title, h2")?.textContent, "Orchestrator Controls");
  assert.deepEqual(sectionTitles(dialog), ["Orchestrator Control", "Child Session Requests", "Workflow Decisions", "Campaign Behavior"]);

  const requests = dialog.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Child Session Requests"]');
  assert.ok(requests);
  assert.match(requests.textContent ?? "", /Human.*Keep descendant requests with a person\./);
  assert.match(requests.textContent ?? "", /Questions.*Delegate non-secret descendant questions\./);
  assert.match(requests.textContent ?? "", /Questions and Approvals.*Also delegate eligible one-time approvals\./);
  assert.equal(requests.querySelector<HTMLInputElement>("input:checked")?.closest(".choice-row")?.textContent?.startsWith("Human"), true);

  for (const label of [
    "Implementation Questions", "PR Merge Approval", "Merged Branch Deletion",
    "Follow-Up Issue Publication", "UI Evidence Approval",
  ]) {
    const group = gate(dialog, label);
    assert.deepEqual([...group.querySelectorAll('[role="radio"]')].map((node) => node.textContent), ["Human", "Orchestrator"]);
  }
  assert.equal(option(gate(dialog, "Implementation Questions"), "Orchestrator").getAttribute("aria-checked"), "true");
  assert.equal(option(gate(dialog, "PR Merge Approval"), "Human").getAttribute("aria-checked"), "true");
  assert.equal(dialog.querySelectorAll("select, .ui-select").length, 0, "no gate is a Select");

  const text = dialog.textContent ?? "";
  assert.match(text, /Only a signed-in person can change these, and a change revokes approvals that haven't been used yet\./);
  assert.match(text, /Secrets, sign-in, persistent grants, governance, budgets and guardrails always stay with a person\./);
  assert.match(text, /provider may retain images in provider-local transcripts or media logs/, "UI Evidence Approval keeps its retention sentence");
  assert.match(text, /Goes to a person here: No image reader\./, "a gate routed to a person anyway says why on its row (#1321)");

  const facts = dialog.querySelector<HTMLElement>("dl.facts");
  assert.ok(facts, "Campaign Behavior is a facts list");
  const fact = (label: string) => [...facts.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling;
  assert.equal(fact("Campaign Status")?.querySelector(".status")?.textContent?.includes("Awaiting Decision"), true,
    "a campaign waiting on a person reads as a status badge");
  assert.match(fact("Campaign Status")?.textContent ?? "", /Policy Revision 3/);
  assert.match(fact("Child Harness")?.textContent ?? "", /Claude Code · Native/);
  assert.match(fact("Child Model")?.textContent ?? "", /claude-opus-5.*Session Override/);
  assert.match(fact("Children")?.textContent ?? "", /1 Waiting for Human/);
  assert.match(fact("Follow-Up Recommendations")?.textContent ?? "", /1 Duplicate Skipped/, "one duplicate is singular");
  await harness.rerender(orchestrator({ orchestratorCampaign: { ...CAMPAIGN, followUps: { unique: 2, duplicates: 2 } } }));
  assert.match(fact("Follow-Up Recommendations")?.textContent ?? "", /2 Duplicates Skipped/);
  for (const label of ["Child Effort", "Maximum Concurrent Children", "Follow-Ups", "Completion", "Integration Isolation"]) {
    assert.ok(fact(label), `${label} is a fact`);
  }

  const footer = dialog.querySelector(".modal-foot");
  assert.deepEqual([...(footer?.querySelectorAll("button") ?? [])].map((button) => button.textContent), ["Done"]);
  assertNoDomNode(footer?.querySelector(".btn.primary") ?? null, "a close-only dialog has no primary");
  await act(async () => fireDomEvent.click([...footer!.querySelectorAll<HTMLButtonElement>("button")][0]!));
  assert.equal(harness.closed(), 1, "Done closes it");
});

test("Campaign Behavior shows only when a campaign policy exists", async () => {
  const harness = await open(orchestrator({ orchestratorPolicy: undefined, orchestratorCampaign: undefined }), {});
  assert.deepEqual(sectionTitles(harness.dialog()), ["Child Session Requests", "Workflow Decisions"]);
});

test("choosing a Child Session Requests row calls setParentControl once and shows Saved", async () => {
  const calls: Array<[string, ParentControlMode]> = [];
  const harness = await open(orchestrator(), {
    setParentControl: async (id: string, mode: ParentControlMode) => {
      calls.push([id, mode]);
      return orchestrator({ parentControl: mode });
    },
  });
  const dialog = harness.dialog();
  const questions = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    .find((input) => input.closest(".choice-row")?.textContent?.startsWith("QuestionsDelegate"));
  assert.ok(questions);
  await act(async () => fireDomEvent.click(questions));
  await flush();
  assert.deepEqual(calls, [["orch", "questions"]]);
  assert.equal(harness.changed.at(-1)?.parentControl, "questions", "the reply updates the session");
  const head = [...dialog.querySelectorAll(".section-head")].find((node) => /Child Session Requests/.test(node.textContent ?? ""));
  assert.match(head?.textContent ?? "", /Saved/, "the section shows the Saved check");
  assert.equal(dialog.querySelector('[role="status"].sr-only')?.textContent, "Child Session Requests saved");
});

test("a gate changes with one click, sends the current revision once and shows Saved for about 2s", async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  await withScopedClockOverrides(domWindow, {
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextTimer++;
      if (ms === 2000) timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, async () => {
    const calls: Array<{ decisions: ParentControlDecisionPolicy; revision: number }> = [];
    const harness = await open(orchestrator(), {
      setParentControlPolicy: async (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
        calls.push({ decisions, revision });
        return orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } });
      },
    });
    const dialog = harness.dialog();
    await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
    await flush();
    assert.equal(calls.length, 1, "one click is one request");
    assert.equal(calls[0]!.revision, 3, "with the current revision");
    assert.equal(calls[0]!.decisions.pr_merge, "orchestrator");
    assert.equal(calls[0]!.decisions.implementation_question, "orchestrator", "the other gates are sent unchanged");
    const row = gate(dialog, "PR Merge Approval").closest(".orchestrator-gate");
    assert.match(row?.textContent ?? "", /Saved/);
    assert.equal(option(gate(dialog, "PR Merge Approval"), "Orchestrator").getAttribute("aria-checked"), "true");
    assert.equal(timers.size, 1, "the check is timed");
    await act(async () => { for (const callback of timers.values()) callback(); });
    assert.doesNotMatch(row?.textContent ?? "", /Saved/, "and leaves after 2s");
  });
});

test("two gates changed back to back are saved one after the other, each on the newest revision", async () => {
  const replies: Array<(view: SessionView) => void> = [];
  const calls: Array<{ decisions: ParentControlDecisionPolicy; revision: number }> = [];
  const harness = await open(orchestrator(), {
    setParentControlPolicy: (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
      calls.push({ decisions, revision });
      return new Promise<SessionView>((resolve) => replies.push(resolve));
    },
  });
  const dialog = harness.dialog();
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator")));
  await flush();
  assert.equal(calls.length, 1, "the second waits for the first");
  assert.equal(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator").getAttribute("aria-checked"), "true",
    "the waiting choice is shown at once");
  await act(async () => replies[0]!(orchestrator({ parentControlPolicy: { revision: 4, decisions: calls[0]!.decisions } })));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.revision, 4, "the second change uses the revision the first produced");
  assert.equal(calls[1]!.decisions.pr_merge, "orchestrator", "and keeps the first change");
  assert.equal(calls[1]!.decisions.merged_branch_deletion, "orchestrator");
  // The session's save queue outlives the dialog, so settle it for the tests after this one.
  await act(async () => replies[1]!(orchestrator({ parentControlPolicy: { revision: 5, decisions: calls[1]!.decisions } })));
  await flush();
});

test("a revision conflict shows the danger notice in the dialog, reloads, and puts the stored choice back", async () => {
  const stored = orchestrator({ parentControlPolicy: { revision: 5, decisions: { ...HUMAN_ONLY } } });
  let reloads = 0;
  const harness = await open(orchestrator(), {
    setParentControlPolicy: async () => {
      throw new ApiError("Parent Control policy revision is stale", 409);
    },
    session: async () => {
      reloads += 1;
      return { session: stored };
    },
  });
  const dialog = harness.dialog();
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await flush();
  const notice = dialog.querySelector<HTMLElement>(".notice.t-danger");
  assert.ok(notice, "a danger notice inside the dialog");
  assert.match(notice.textContent ?? "", new RegExp(ORCHESTRATOR_CONTROLS_CONFLICT.replace(/\./g, "\\.")));
  assert.equal(notice.getAttribute("role"), "alert");
  assert.equal(notice.parentElement?.lastElementChild, notice, "at the bottom of the body");
  assert.equal(reloads, 1, "the session reloads");
  assert.equal(harness.changed.at(-1), stored, "with the stored policy");
  await harness.rerender(stored);
  assert.equal(option(gate(dialog, "PR Merge Approval"), "Human").getAttribute("aria-checked"), "true",
    "the choice shown returns to the stored value");
  assertNoDomNode(dialog.querySelector(".setting-row-saved"), "nothing reads as saved");
});

test("under StrictMode a conflict still shows its notice and puts the stored choice back", async () => {
  const stored = orchestrator({ parentControlPolicy: { revision: 5, decisions: { ...HUMAN_ONLY } } });
  const harness = await open(orchestrator(), {
    setParentControlPolicy: async () => { throw new ApiError("Parent Control policy revision is stale", 409); },
    session: async () => ({ session: stored }),
  }, null, { strict: true });
  const dialog = harness.dialog();
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await flush();
  assert.match(dialog.querySelector(".notice.t-danger")?.textContent ?? "", /changed elsewhere/,
    "the remounted dialog still reports the failure");
  assert.equal(option(gate(dialog, "PR Merge Approval"), "Human").getAttribute("aria-checked"), "true",
    "and still drops the unsaved choice");
});

test("a gate changed three times before the first save settles shows the newest choice until its own save settles", async () => {
  const replies: Array<() => void> = [];
  const sent: WorkflowDecisionAuthority[] = [];
  let revision = 3;
  const harness = await open(orchestrator(), {
    setParentControlPolicy: (_id: string, decisions: ParentControlDecisionPolicy) => {
      sent.push(decisions.pr_merge);
      return new Promise<SessionView>((resolve) => replies.push(() => {
        revision += 1;
        resolve(orchestrator({ parentControlPolicy: { revision, decisions } }));
      }));
    },
  });
  const dialog = harness.dialog();
  const shown = () => [...gate(dialog, "PR Merge Approval").querySelectorAll('[role="radio"]')]
    .find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
  const savedOnRow = () => gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".setting-row-saved") ?? null;
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Human")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await flush();
  assert.equal(shown(), "Orchestrator");

  await act(async () => replies[0]!());
  await flush();
  assert.equal(shown(), "Orchestrator", "the first save's reply does not replace the newest choice");
  assertNoDomNode(savedOnRow(), "a replaced save does not say Saved");
  await act(async () => replies[1]!());
  await flush();
  assert.equal(shown(), "Orchestrator", "nor does the second's, which stored Human");
  assertNoDomNode(savedOnRow(), "and it does not say Saved either");
  await act(async () => replies[2]!());
  await flush();
  assert.deepEqual(sent, ["orchestrator", "human", "orchestrator"]);
  assert.equal(shown(), "Orchestrator");
  assert.ok(savedOnRow(), "the newest save says Saved");
});

test("a change made after closing and reopening waits for the closed dialog's saves, so the newest choice is stored", async () => {
  const replies: Array<{ resolve: (view: SessionView) => void; reject: (cause: unknown) => void }> = [];
  const sent: Array<[WorkflowDecisionAuthority, number]> = [];
  let stored = orchestrator({ parentControlPolicy: { revision: 4, decisions: { ...HUMAN_ONLY, implementation_question: "orchestrator" } } });
  const client: Partial<ApiClient> = {
    setParentControlPolicy: (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
      sent.push([decisions.implementation_question, revision]);
      return new Promise<SessionView>((resolve, reject) => replies.push({ resolve, reject }));
    },
    session: async () => ({ session: stored }),
  };
  const first = await open(orchestrator(), client);
  const firstDialog = first.dialog();
  await act(async () => fireDomEvent.click(option(gate(firstDialog, "Implementation Questions"), "Human")));
  await act(async () => fireDomEvent.click(option(gate(firstDialog, "Implementation Questions"), "Orchestrator")));
  await flush();
  await first.unmount();

  const second = await open(orchestrator(), client);
  const secondDialog = second.dialog();
  await act(async () => fireDomEvent.click(option(gate(secondDialog, "Implementation Questions"), "Human")));
  await flush();
  assert.equal(sent.length, 1, "the reopened dialog's change waits behind the closed dialog's");

  await act(async () => replies[0]!.reject(new ApiError("Parent Control policy revision is stale", 409)));
  await flush();
  assert.deepEqual(sent[1], ["orchestrator", 4], "the closed dialog's queued change is sent on the reloaded revision");
  await act(async () => replies[1]!.resolve(stored = orchestrator({
    parentControlPolicy: { revision: 5, decisions: { ...HUMAN_ONLY, implementation_question: "orchestrator" } },
  })));
  await flush();
  assert.deepEqual(sent[2], ["human", 5], "and the newest choice goes last, on the revision before it");
  await act(async () => replies[2]!.resolve(orchestrator({ parentControlPolicy: { revision: 6, decisions: { ...HUMAN_ONLY } } })));
  await flush();
  assert.equal(option(gate(secondDialog, "Implementation Questions"), "Human").getAttribute("aria-checked"), "true");
  assertNoDomNode(secondDialog.querySelector(".notice.t-danger"), "the closed dialog's failure is not the reopened one's");
});

test("changing a gate again clears its Saved check until the new change saves", async () => {
  const replies: Array<() => void> = [];
  const harness = await open(orchestrator(), {
    setParentControlPolicy: (_id: string, decisions: ParentControlDecisionPolicy, revision: number) =>
      new Promise<SessionView>((resolve) => replies.push(() => resolve(orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } })))),
  });
  const dialog = harness.dialog();
  const savedOnRow = () => gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".setting-row-saved") ?? null;
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await flush();
  await act(async () => replies[0]!());
  await flush();
  assert.ok(savedOnRow(), "the first change saved");
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Human")));
  await flush();
  assertNoDomNode(savedOnRow(), "an unsaved choice has no Saved check");
  await act(async () => replies[1]!());
  await flush();
  assert.ok(savedOnRow(), "until it saves");
});

test("a gate that failed and then saves retires its failure notice", async () => {
  const replies: Array<{ resolve: (view: SessionView) => void; reject: (cause: unknown) => void }> = [];
  const harness = await open(orchestrator(), {
    setParentControlPolicy: () => new Promise<SessionView>((resolve, reject) => replies.push({ resolve, reject })),
    session: async () => ({ session: orchestrator({ parentControlPolicy: { revision: 4, decisions: { ...HUMAN_ONLY } } }) }),
  });
  const dialog = harness.dialog();
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Human")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await flush();
  await act(async () => replies[0]!.reject(new ApiError("Parent Control policy revision is stale", 409)));
  await flush();
  assert.ok(dialog.querySelector(".notice.t-danger"), "the first change failed");
  await act(async () => replies[1]!.resolve(orchestrator({ parentControlPolicy: { revision: 5, decisions: { ...HUMAN_ONLY } } })));
  await flush();
  await act(async () => replies[2]!.resolve(orchestrator({
    parentControlPolicy: { revision: 6, decisions: { ...HUMAN_ONLY, pr_merge: "orchestrator" } },
  })));
  await flush();
  assertNoDomNode(dialog.querySelector(".notice.t-danger"), "the newest change saved, so the failure is gone");
  assert.ok(gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".setting-row-saved"));
});

test("a reply older than a revision the dialog has already seen does not send the next change on it", async () => {
  const replies: Array<(view: SessionView) => void> = [];
  const revisions: number[] = [];
  const harness = await open(orchestrator(), {
    setParentControlPolicy: (_id: string, _decisions: ParentControlDecisionPolicy, revision: number) => {
      revisions.push(revision);
      return new Promise<SessionView>((resolve) => replies.push(resolve));
    },
  });
  const dialog = harness.dialog();
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
  await act(async () => fireDomEvent.click(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator")));
  await flush();
  // A change elsewhere reaches the dialog first: revision 5, while its own save made revision 4.
  await harness.rerender(orchestrator({ parentControlPolicy: { revision: 5, decisions: { ...HUMAN_ONLY, pr_merge: "orchestrator" } } }));
  await act(async () => replies[0]!(orchestrator({ parentControlPolicy: { revision: 4, decisions: { ...HUMAN_ONLY, pr_merge: "orchestrator" } } })));
  await flush();
  assert.deepEqual(revisions, [3, 5], "the second change is sent on the newest revision seen");
  await act(async () => replies[1]!(orchestrator({ parentControlPolicy: { revision: 6, decisions: { ...HUMAN_ONLY } } })));
  await flush();
});

test("a reload that never answers holds the next change only until its timeout", async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  await withScopedClockOverrides(domWindow, {
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextTimer++;
      if (ms === ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS) timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, async () => {
    const sent: WorkflowDecisionAuthority[] = [];
    const first = await open(orchestrator(), {
      setParentControlPolicy: async (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
        sent.push(decisions.pr_merge);
        if (sent.length === 1) throw new ApiError("Parent Control policy revision is stale", 409);
        return orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } });
      },
      session: () => new Promise<never>(() => {}),
    });
    await act(async () => fireDomEvent.click(option(gate(first.dialog(), "PR Merge Approval"), "Orchestrator")));
    await flush();
    await first.unmount();
    const second = await open(orchestrator(), {
      setParentControlPolicy: async (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
        sent.push(decisions.pr_merge);
        return orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } });
      },
    });
    await act(async () => fireDomEvent.click(option(gate(second.dialog(), "Merged Branch Deletion"), "Orchestrator")));
    await flush();
    assert.equal(sent.length, 1, "the next change waits for the reload");
    assert.equal(timers.size, 1, "for a bounded time");
    await act(async () => { for (const callback of timers.values()) callback(); });
    await flush();
    assert.equal(sent.length, 2, "then it is sent");
  });
});

test("a write that never answers fails at the transport deadline, reloads, and lets the next change through", async () => {
  // A real client over the browser transport, with a fetch whose first policy write never answers.
  const writes: Array<{ decisions: ParentControlDecisionPolicy; expectedRevision: number }> = [];
  let reloads = 0;
  const transport = createBrowserApiTransport({
    instanceId: "stalled-write",
    origin: "http://127.0.0.1:4317",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/sessions/orch/parent-control-policy") {
        const body = JSON.parse(String(init?.body)) as { decisions: ParentControlDecisionPolicy; expectedRevision: number };
        writes.push(body);
        if (writes.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return Promise.resolve(Response.json(orchestrator({
          parentControlPolicy: { revision: body.expectedRevision + 1, decisions: body.decisions },
        })));
      }
      if (url.pathname === "/api/sessions/lookup/by-id") {
        reloads += 1;
        return Promise.resolve(Response.json({ session: orchestrator() }));
      }
      return Promise.reject(new Error(`unexpected request ${url.pathname}`));
    }) as typeof fetch,
  });
  const client = createApiClient(transport);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await open(orchestrator(), {
      setParentControlPolicy: client.setParentControlPolicy,
      session: client.session,
    });
    const dialog = harness.dialog();
    await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
    await act(async () => fireDomEvent.click(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator")));
    await flush();
    assert.equal(writes.length, 1, "the second change waits behind the stalled write");

    await act(async () => { mock.timers.tick(API_REQUEST_DEADLINE_MS - 1); });
    await flush();
    assertNoDomNode(dialog.querySelector(".notice.t-danger"), "no failure before the deadline");
    assert.equal(writes.length, 1);

    await act(async () => { mock.timers.tick(1); });
    await flush();
    const notice = dialog.querySelector<HTMLElement>(".notice.t-danger");
    assert.match(notice?.textContent ?? "", /^Your change wasn't saved\./, "the deadline surfaces as the usual failure");
    assert.equal(reloads, 1, "and the session is reloaded to reconcile what the server stored");
    const details = [...notice!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Show Details");
    await act(async () => fireDomEvent.click(details!));
    assert.match(notice?.textContent ?? "", /didn't answer within 45 seconds/);

    await flush();
    assert.equal(writes.length, 2, "then the queued change is sent");
    assert.equal(writes[1]!.decisions.merged_branch_deletion, "orchestrator");
    assert.equal(writes[1]!.decisions.pr_merge, "human", "on the reloaded policy, not the unconfirmed write");
    await flush();
  } finally {
    mock.timers.reset();
  }
});

test("a reload that answers after a newer save is not published", async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  await withScopedClockOverrides(domWindow, {
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextTimer++;
      if (ms === ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS) timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, async () => {
    let releaseReload!: () => void;
    const revisions: number[] = [];
    const harness = await open(orchestrator(), {
      setParentControlPolicy: async (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
        revisions.push(revision);
        if (revisions.length === 1) throw new ApiError("Parent Control policy revision is stale", 409);
        return orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } });
      },
      session: () => new Promise((resolve) => {
        releaseReload = () => resolve({ session: orchestrator() });
      }),
    });
    const dialog = harness.dialog();
    await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Orchestrator")));
    await act(async () => fireDomEvent.click(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator")));
    await flush();
    await act(async () => { for (const callback of timers.values()) callback(); });
    await flush();
    assert.deepEqual(revisions, [3, 3], "the second change ran after the reload timed out");
    assert.equal(harness.changed.at(-1)?.parentControlPolicy?.revision, 4);
    await act(async () => releaseReload());
    await flush();
    assert.equal(harness.changed.at(-1)?.parentControlPolicy?.revision, 4, "the late, older reload is not published");
    assert.equal(option(gate(dialog, "Merged Branch Deletion"), "Orchestrator").getAttribute("aria-checked"), "true");
  });
});

test("a dialog reopened while a change is saving shows that change, and a reversal is queued after it", async () => {
  const replies: Array<() => void> = [];
  const sent: WorkflowDecisionAuthority[] = [];
  const client: Partial<ApiClient> = {
    setParentControlPolicy: (_id: string, decisions: ParentControlDecisionPolicy, revision: number) => {
      sent.push(decisions.pr_merge);
      return new Promise<SessionView>((resolve) => replies.push(() => resolve(
        orchestrator({ parentControlPolicy: { revision: revision + 1, decisions } }),
      )));
    },
  };
  const first = await open(orchestrator(), client);
  await act(async () => fireDomEvent.click(option(gate(first.dialog(), "PR Merge Approval"), "Orchestrator")));
  await flush();
  await first.unmount();

  const second = await open(orchestrator(), client);
  const dialog = second.dialog();
  assert.equal(option(gate(dialog, "PR Merge Approval"), "Orchestrator").getAttribute("aria-checked"), "true",
    "the change still saving is what the reopened dialog shows");
  await act(async () => fireDomEvent.click(option(gate(dialog, "PR Merge Approval"), "Human")));
  await act(async () => replies[0]!());
  await flush();
  await act(async () => replies[1]!());
  await flush();
  assert.deepEqual(sent, ["orchestrator", "human"], "the reversal is sent after the change it reverses");
  assert.equal(option(gate(dialog, "PR Merge Approval"), "Human").getAttribute("aria-checked"), "true");
});

test("any other failure says the change wasn't saved, with the server's words behind Show Details", async () => {
  const harness = await open(orchestrator(), {
    setParentControl: async () => { throw new ApiError("only an authenticated human may change Parent Control", 403); },
    session: async () => ({ session: orchestrator() }),
  });
  const dialog = harness.dialog();
  const approvals = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    .find((input) => input.closest(".choice-row")?.textContent?.startsWith("Questions and Approvals"));
  await act(async () => fireDomEvent.click(approvals!));
  await flush();
  const notice = dialog.querySelector<HTMLElement>(".notice.t-danger");
  assert.match(notice?.textContent ?? "", /^Your change wasn't saved\./);
  assert.doesNotMatch(notice?.textContent ?? "", /changed elsewhere/, "only a conflict says the controls changed elsewhere");
  const details = [...notice!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Show Details");
  await act(async () => fireDomEvent.click(details!));
  assert.match(notice?.textContent ?? "", /only an authenticated human may change Parent Control/);
});

test("a person refused configuration reads the controls and cannot change them", async () => {
  let calls = 0;
  const refusal = "Your Viewer role is read-only.";
  const harness = await open(orchestrator(), {
    setParentControl: async () => { calls += 1; return orchestrator(); },
    setParentControlPolicy: async () => { calls += 1; return orchestrator(); },
  }, refusal);
  const dialog = harness.dialog();
  assert.match(dialog.textContent ?? "", /Your Viewer role is read-only\./, "the refusal is shown");
  const merge = option(gate(dialog, "PR Merge Approval"), "Orchestrator");
  assert.equal(merge.getAttribute("aria-disabled"), "true");
  await act(async () => fireDomEvent.click(merge));
  const questions = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    .find((input) => input.closest(".choice-row")?.textContent?.startsWith("QuestionsDelegate"));
  await act(async () => fireDomEvent.click(questions!));
  await flush();
  assert.equal(calls, 0, "nothing is sent");
});

test("a legacy campaign payload derives Integration Isolation from the preset before strictness", async () => {
  // A v144–v163 control plane: the execution block exists but has no `integrationIsolation`.
  const legacy = (strictProjectIsolation: boolean) => ({
    ...POLICY,
    execution: { strictProjectIsolation },
    sources: { ...POLICY.sources, execution: { strictProjectIsolation: "legacy_session" } },
  }) as unknown as OrchestratorCampaignPolicy;
  const isolation = (dialog: HTMLElement) => {
    const term = [...dialog.querySelectorAll("dt")].find((node) => node.textContent === "Integration Isolation");
    assert.ok(term, "Campaign Behavior shows the stored value");
    return { value: term.nextElementSibling?.textContent ?? "", disclosure: term.parentElement?.getAttribute("title") ?? "" };
  };
  // A NON-strict coupled preset: its stored strictness is false, but the preset still replaced the
  // whole provider surface, so it launched without integrations.
  const harness = await open(orchestrator({ orchestratorPolicy: legacy(false) }), {});
  assert.match(isolation(harness.dialog()).value, /^Enabled.*Legacy Session/);
  assert.match(isolation(harness.dialog()).disclosure, /harness-owned Orchestrator preset/);
  assert.doesNotMatch(isolation(harness.dialog()).disclosure, /are all kept|are kept/);
  // An additive legacy session is the opposite: ordinary provider mode, integrations intact.
  await harness.rerender(orchestrator({ permissionMode: "acceptEdits", orchestratorPolicy: legacy(false) }));
  assert.match(isolation(harness.dialog()).value, /^Disabled/);
  // A strict legacy session is Enabled through the boundary rather than the preset literal.
  await harness.rerender(orchestrator({ permissionMode: "acceptEdits", orchestratorPolicy: legacy(true) }));
  assert.match(isolation(harness.dialog()).value, /^Enabled/);
  assert.match(isolation(harness.dialog()).disclosure, /Removes configured MCP servers/);
});
