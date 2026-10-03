import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  OrchestratorCampaignProjection,
  OrchestratorCampaignPolicy,
  ParentControlDecisionPolicy,
  ParentControlMode,
  SessionView,
  WorkflowDecisionAuthority,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";
import { fireDomEvent } from "./test-dom-events.js";
import {
  ORCHESTRATOR_CONTROLS_CONFLICT,
  ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS,
  OrchestratorControlsDialog,
  orchestratorControlsSummary,
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

test("the summaries count the gates that stay with a person", () => {
  assert.equal(workflowDecisionsSummary(HUMAN_ONLY), "5 of 5 decisions stay with a person.");
  assert.equal(
    workflowDecisionsSummary({ ...HUMAN_ONLY, pr_merge: "orchestrator", implementation_question: "orchestrator" }),
    "3 of 5 decisions stay with a person.",
  );
  assert.equal(
    workflowDecisionsSummary({
      implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "human",
    }),
    "1 of 5 decisions stays with a person.",
  );
  assert.equal(orchestratorControlsSummary({ parentControl: "questions", parentControlPolicy: undefined }),
    "Child session requests: Questions.", "a control plane without typed gates summarizes the one choice it has");
});

test("the dialog has three titled sections, the campaign's facts and a close-only footer", async () => {
  const harness = await open(orchestrator(), {});
  const dialog = harness.dialog();
  assert.equal(dialog.querySelector(".modal-title, h2")?.textContent, "Orchestrator Controls");
  assert.deepEqual(sectionTitles(dialog), ["Child Session Requests", "Workflow Decisions", "Campaign Behavior"]);

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
  assert.match(fact("Child Harness")?.textContent ?? "", /claude · Claude Code · Native/);
  assert.match(fact("Child Model")?.textContent ?? "", /claude-opus-5.*Session Override/);
  assert.match(fact("Children")?.textContent ?? "", /1 Waiting for Human/);
  assert.match(fact("Follow-Up Recommendations")?.textContent ?? "", /1 Duplicates Skipped/);
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
  const head = dialog.querySelector(".section-head");
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
  assertNoDomNode(dialog.querySelector(".ui-row-saved"), "nothing reads as saved");
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
  const savedOnRow = () => gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".ui-row-saved") ?? null;
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
  const savedOnRow = () => gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".ui-row-saved") ?? null;
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
  assert.ok(gate(dialog, "PR Merge Approval").closest(".orchestrator-gate")?.querySelector(".ui-row-saved"));
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
