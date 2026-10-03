import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  DescendantRequestView,
  ParentControlMode,
  SessionConfig,
  SessionView,
  WorkflowDecisionAuthority,
  DelegatableWorkflowDecisionCategory,
} from "@wollipog/protocol";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";
import {
  CampaignContinuationNotice,
  ComposerPlusMenu,
  DESCENDANT_REQUEST_POLL_TIMEOUT_MS,
  useDescendantRequestPolling,
} from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  FocusEvent: domWindow.FocusEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
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
});

/** Menus are portalled to <body> (the shared MenuSurface), so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

test("campaign continuation status explains missing results and exposes explicit acknowledgement", async () => {
  const acknowledged: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CampaignContinuationNotice continuation={{
      state: "missing_result",
      pendingEvents: 3,
      continuationId: "campaign_cont_one",
      commandId: "campaign_prompt_one",
      eventFromSeq: 4,
      eventThroughSeq: 6,
      attemptCount: 2,
      updatedAt: 10,
      error: "Provider result was not persisted.",
      canAcknowledgeMissingResult: true,
    }} onAcknowledge={(commandId) => acknowledged.push(commandId)} />);
  });
  try {
    const notice = page().querySelector<HTMLElement>('[aria-label="Campaign Continuation: Missing Result"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /3 Pending Events · Attempt 2/);
    assert.match(notice.textContent ?? "", /will not be replayed automatically/);
    const acknowledge = page().querySelector<HTMLButtonElement>("button");
    assert.equal(acknowledge?.textContent, "Acknowledge Missing Result");
    await act(async () => fireDomEvent.click(acknowledge!));
    assert.deepEqual(acknowledged, ["campaign_prompt_one"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a Viewer reads the campaign continuation's Acknowledge disabled with a visible reason (#1857)", async () => {
  const acknowledged: string[] = [];
  const reason = "Your Viewer role is read-only.";
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CampaignContinuationNotice continuation={{
      state: "missing_result",
      pendingEvents: 3,
      continuationId: "campaign_cont_viewer",
      commandId: "campaign_prompt_viewer",
      eventFromSeq: 4,
      eventThroughSeq: 6,
      attemptCount: 2,
      updatedAt: 10,
      canAcknowledgeMissingResult: true,
    }} actionRefusal={reason} onAcknowledge={(commandId) => acknowledged.push(commandId)} />);
  });
  try {
    const acknowledge = page().querySelector<HTMLButtonElement>("button")!;
    assert.equal(acknowledge.disabled, true);
    const described = acknowledge.getAttribute("aria-describedby");
    assert.equal(described ? domWindow.document.getElementById(described)?.textContent : null, reason);
    await act(async () => fireDomEvent.click(acknowledge));
    assert.deepEqual(acknowledged, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("campaign continuation status exposes an explicit retry after automatic retrying stops", async () => {
  const retried: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CampaignContinuationNotice continuation={{
      state: "failed",
      pendingEvents: 2,
      continuationId: "campaign_cont_failed",
      commandId: "campaign_prompt_failed",
      eventFromSeq: 7,
      eventThroughSeq: 8,
      attemptCount: 3,
      updatedAt: 10,
      error: "Runner queue remained full.",
      canRetry: true,
    }} onRetry={(commandId) => retried.push(commandId)} />);
  });
  try {
    const notice = page().querySelector<HTMLElement>('[aria-label="Campaign Continuation: Failed"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /Automatic retrying stopped/);
    const retry = page().querySelector<HTMLButtonElement>("button");
    assert.equal(retry?.textContent, "Retry Campaign Continuation");
    await act(async () => fireDomEvent.click(retry!));
    assert.deepEqual(retried, ["campaign_prompt_failed"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

type GuardrailFixture = {
  saved: Partial<SessionConfig>[];
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
  render: (session?: Partial<SessionView>, extra?: { configRefusal?: string | null; disabled?: boolean }) => Promise<void>;
};

const GUARDRAIL_SESSION = {
  costUsd: 1.25,
  costBudgetUsd: null,
  costCheckpointsUsd: null,
  costCheckpointApprovedUsd: null,
  maxToolCalls: null,
  toolCallCount: undefined,
  maxChildSessions: undefined,
  liveChildCapacity: { limit: 4, occupied: 3, remaining: 1 },
} as unknown as SessionView;

/** Renders the + menu with a save that records each request and resolves or fails on demand. */
async function mountGuardrails(save: (patch: Partial<SessionConfig>) => Promise<void> = async () => {}): Promise<GuardrailFixture> {
  const saved: Partial<SessionConfig>[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = async (session: Partial<SessionView> = {}, extra: { configRefusal?: string | null; disabled?: boolean } = {}) => {
    await act(async () => root.render(<ComposerPlusMenu
      session={{ ...GUARDRAIL_SESSION, ...session } as SessionView}
      planActive={false}
      planSupported
      onTogglePlan={() => {}}
      onSaveGuardrails={(patch) => {
        saved.push(patch);
        return save(patch);
      }}
      configRefusal={extra.configRefusal ?? null}
      disabled={extra.disabled ?? false}
      imageMimeTypes={["image/png"]}
      onAttachImages={() => {}}
    />));
  };
  await render();
  return { saved, root, container, render };
}

async function unmountGuardrails(fixture: GuardrailFixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

function menuRow(label: string): HTMLButtonElement | undefined {
  return [...page().querySelectorAll<HTMLButtonElement>("button.menu-item")]
    .find((item) => item.querySelector(".menu-text")?.textContent === label);
}

function guardrailsDialog(): HTMLElement | null {
  return [...page().querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((dialog) => dialog.querySelector(".modal-title")?.textContent === "Guardrails") ?? null;
}

async function openGuardrails(): Promise<HTMLElement> {
  if (!menuRow("Guardrails…")) {
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!));
  }
  await act(async () => fireDomEvent.click(menuRow("Guardrails…")!));
  const dialog = guardrailsDialog();
  assert.ok(dialog, "Guardrails… opens a dialog titled Guardrails");
  return dialog;
}

function fieldInput(label: string): HTMLInputElement {
  const labelElement = [...page().querySelectorAll<HTMLLabelElement>("label")].find((node) => node.textContent === label);
  const input = labelElement?.htmlFor ? page().querySelector<HTMLInputElement>(`[id="${labelElement.htmlFor}"]`) : null;
  assert.ok(input, `${label} is a labeled field`);
  return input;
}

function describedText(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => fireDomEvent.change(input, { target: { value } }));
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...page().querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  assert.ok(found, `${label} is a button`);
  return found;
}

async function saveGuardrails() {
  await act(async () => {
    fireDomEvent.click(buttonNamed("Save Guardrails"));
    await Promise.resolve();
  });
}

test("the + menu has a Guardrails… row that summarizes the limits and holds no field (#2175)", async () => {
  const fixture = await mountGuardrails();
  try {
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!));
    const row = menuRow("Guardrails…");
    assert.ok(row, "the menu offers Guardrails…");
    assert.equal(row.querySelector(".menu-desc")?.textContent, "No limits set.");
    const menu = page().querySelector('.menu[aria-label="Session Attachments, Modes, and Guardrails"]');
    assert.ok(menu);
    assert.equal(menu.querySelectorAll("input").length, 0, "no guardrail input remains in the menu");
    assert.equal(menu.querySelectorAll('[aria-label^="About "]').length, 0, "no ⓘ buttons remain");

    await fixture.render({ costBudgetUsd: 5, maxToolCalls: 200, maxChildSessions: 4 });
    assert.equal(menuRow("Guardrails…")?.querySelector(".menu-desc")?.textContent,
      "Pauses at $5.00 spent or 200 tool calls. Up to 4 live children.");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("the Guardrails dialog shows four labeled fields with their help visible and no ⓘ (#2175)", async () => {
  const fixture = await mountGuardrails();
  try {
    await fixture.render({ costCheckpointApprovedUsd: 2, maxToolCalls: 50, toolCallCount: 12 });
    const dialog = await openGuardrails();
    assertNoDomNode(page().querySelector('.menu[aria-label="Session Attachments, Modes, and Guardrails"]'),
      "the menu closes as the dialog opens");
    const expected: Array<[string, string]> = [
      ["Recurring Cost Threshold", "Pauses when spend reaches this amount. Continue allows another equal amount. $1.25 spent so far."],
      ["Cost Checkpoints", "One-time pauses at these totals, separated by commas. Approved through $2.00."],
      ["Tool-Call Threshold", "Pauses after this many tool calls. 12 used."],
      ["Live Child Limit", "How many child sessions can run at once. Set 0 to pause new children. 3 of 4 in use."],
    ];
    for (const [label, helper] of expected) {
      const input = fieldInput(label);
      assert.ok(dialog.contains(input), `${label} is inside the dialog`);
      assert.equal(input.type, "text", `${label} keeps what was typed, so a typo is shown rather than dropped`);
      assert.equal(describedText(input), helper, `${label}'s helper is visible and describes the field`);
    }
    assert.equal(fieldInput("Live Child Limit").placeholder, "4");
    assert.equal(dialog.querySelectorAll('[aria-label^="About "]').length, 0, "no ⓘ buttons");
    assert.equal(dialog.querySelectorAll(".input-affix-text svg").length, 4, "each field carries its $ or # icon");
    assert.ok(buttonNamed("Cancel"));
    assert.ok(buttonNamed("Save Guardrails"));
    assert.match(dialog.textContent ?? "", /Empty cost and tool-call fields mean no limit\./);
  } finally {
    await unmountGuardrails(fixture);
  }
});

for (const label of ["Recurring Cost Threshold", "Cost Checkpoints", "Tool-Call Threshold"]) {
  for (const typo of ["1e", "-3", "abc"]) {
    test(`"${typo}" in ${label} blocks Save with an error in place of its helper, and fixing it clears the error`, async () => {
      const fixture = await mountGuardrails();
      try {
        await openGuardrails();
        const input = fieldInput(label);
        const helper = describedText(input);
        await typeInto(input, typo);
        await saveGuardrails();
        assert.deepEqual(fixture.saved, [], "nothing is sent");
        assert.ok(guardrailsDialog(), "the dialog stays open");
        assert.equal(input.getAttribute("aria-invalid"), "true");
        assert.equal(input.value, typo, "the typed value stays in the field");
        const error = describedText(input);
        assert.notEqual(error, helper, "the error replaces the helper");
        assert.match(error, /^Enter /, "the error says how to fix it");
        assert.ok(guardrailsDialog()!.querySelector(".field-error"), "the shared field error renders it");
        assert.equal(domWindow.document.activeElement, input, "focus moves to the invalid field");

        await typeInto(input, label === "Tool-Call Threshold" ? "300" : "3");
        assert.equal(input.hasAttribute("aria-invalid"), false, "a valid value clears the error");
        assert.equal(describedText(input), helper, "and brings the helper back");
      } finally {
        await unmountGuardrails(fixture);
      }
    });
  }
}

test("a guardrail field is checked when it loses focus after an edit, not before", async () => {
  const fixture = await mountGuardrails();
  try {
    await openGuardrails();
    const input = fieldInput("Live Child Limit");
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.equal(input.hasAttribute("aria-invalid"), false, "an untouched field shows no error");
    await typeInto(input, "65");
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(describedText(input), "Enter a whole number from 0 to 64.");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("restoring a field's opening value clears its error, even one the validator would not accept typed", async () => {
  const fixture = await mountGuardrails();
  try {
    await fixture.render({ maxToolCalls: 1e21 });
    await openGuardrails();
    const input = fieldInput("Tool-Call Threshold");
    const opening = input.value;
    assert.equal(opening, "1000000000000000000000", "the accepted limit opens as plain digits");
    await typeInto(input, "abc");
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.equal(input.getAttribute("aria-invalid"), "true");
    await typeInto(input, opening);
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.equal(input.hasAttribute("aria-invalid"), false, "the limit the server accepted is not an error");
    await typeInto(fieldInput("Live Child Limit"), "9");
    await saveGuardrails();
    assert.deepEqual(fixture.saved, [{ maxChildSessions: 9 }], "and it never blocks saving another field");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("a checkpoint at or above the recurring threshold warns and still saves", async () => {
  const fixture = await mountGuardrails();
  try {
    await openGuardrails();
    await typeInto(fieldInput("Recurring Cost Threshold"), "5");
    const checkpoints = fieldInput("Cost Checkpoints");
    await typeInto(checkpoints, "1, 6");
    assert.match(describedText(checkpoints), /This checkpoint won't pause separately, because the recurring threshold is lower\./);
    assert.ok(guardrailsDialog()!.querySelector(".field-warn"), "it is the shared field warning");
    assert.equal(checkpoints.hasAttribute("aria-invalid"), false, "a warning is not an error");
    await saveGuardrails();
    assert.deepEqual(fixture.saved, [{ costBudgetUsd: 5, costCheckpointsUsd: [1, 6] }]);
    assertNoDomNode(guardrailsDialog());
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("Save Guardrails sends all four values in one request and closes; Cancel and Escape send nothing", async () => {
  const fixture = await mountGuardrails();
  const fillAll = async () => {
    await typeInto(fieldInput("Recurring Cost Threshold"), "5");
    await typeInto(fieldInput("Cost Checkpoints"), "2.50, 1");
    await typeInto(fieldInput("Tool-Call Threshold"), "200");
    await typeInto(fieldInput("Live Child Limit"), "9");
  };
  try {
    await openGuardrails();
    await fillAll();
    await act(async () => fireDomEvent.click(buttonNamed("Cancel")));
    assertNoDomNode(guardrailsDialog());
    assert.deepEqual(fixture.saved, [], "Cancel applies nothing");

    await openGuardrails();
    await fillAll();
    await act(async () => fireDomEvent.keyDown(fieldInput("Recurring Cost Threshold"), { key: "Escape" }));
    assertNoDomNode(guardrailsDialog());
    assert.deepEqual(fixture.saved, [], "Escape applies nothing");

    await openGuardrails();
    assert.equal(fieldInput("Recurring Cost Threshold").value, "", "a cancelled edit is not kept");
    await fillAll();
    await saveGuardrails();
    assert.deepEqual(fixture.saved, [{ costBudgetUsd: 5, costCheckpointsUsd: [1, 2.5], maxToolCalls: 200, maxChildSessions: 9 }],
      "one configuration request carries every value");
    assertNoDomNode(guardrailsDialog(), "a saved dialog closes");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("emptying Recurring Cost Threshold clears it, emptying Live Child Limit keeps it, and 0 pauses children", async () => {
  const fixture = await mountGuardrails();
  try {
    await fixture.render({ costBudgetUsd: 5, maxChildSessions: 6 });
    await openGuardrails();
    assert.equal(fieldInput("Recurring Cost Threshold").value, "5");
    assert.equal(fieldInput("Live Child Limit").value, "6");
    await typeInto(fieldInput("Recurring Cost Threshold"), "");
    await typeInto(fieldInput("Live Child Limit"), "");
    await saveGuardrails();
    assert.deepEqual(fixture.saved, [{ costBudgetUsd: 0 }], "the threshold clears; the child limit is not sent");

    await openGuardrails();
    await typeInto(fieldInput("Live Child Limit"), "0");
    await saveGuardrails();
    assert.deepEqual(fixture.saved.at(-1), { maxChildSessions: 0 });
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("a failed guardrails save keeps the dialog and its values and shows a danger notice", async () => {
  let fail = true;
  const fixture = await mountGuardrails(async () => {
    if (fail) throw new Error("The control plane refused the limits.");
  });
  try {
    await openGuardrails();
    await typeInto(fieldInput("Tool-Call Threshold"), "200");
    await saveGuardrails();
    await act(async () => { await Promise.resolve(); });
    const dialog = guardrailsDialog();
    assert.ok(dialog, "the dialog stays open");
    assert.equal(fieldInput("Tool-Call Threshold").value, "200", "the values are kept");
    const notice = dialog.querySelector('[role="alert"]');
    assert.match(notice?.textContent ?? "", /Couldn't Save the Guardrails/);
    assert.match(notice?.textContent ?? "", /The control plane refused the limits\./);
    fail = false;
    await saveGuardrails();
    await act(async () => { await Promise.resolve(); });
    assertNoDomNode(guardrailsDialog(), "retrying closes it once the request succeeds");
    assert.equal(fixture.saved.length, 2);
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("a Viewer reads the guardrails read-only, with Save disabled and the refusal in the footer (#1857)", async () => {
  const refusal = "Your Viewer role is read-only.";
  const fixture = await mountGuardrails();
  try {
    // A Viewer is refused prompts too, so the composer is paused: + still opens (#2175).
    await fixture.render({ costBudgetUsd: 5 }, { configRefusal: refusal, disabled: true });
    const plus = page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!;
    assert.equal(plus.disabled, false, "+ opens on a paused composer");
    await act(async () => fireDomEvent.click(plus));
    assert.equal(menuRow("Attach Image")?.disabled, true);
    assert.equal(menuRow("Plan Mode")?.disabled, true, "Plan Mode refuses for a paused composer");
    await openGuardrails();
    for (const label of ["Recurring Cost Threshold", "Cost Checkpoints", "Tool-Call Threshold", "Live Child Limit"]) {
      assert.equal(fieldInput(label).readOnly, true, `${label} is read-only`);
    }
    assert.equal(fieldInput("Recurring Cost Threshold").value, "5", "the current limit is readable");
    const save = buttonNamed("Save Guardrails");
    assert.equal(save.disabled, true);
    assert.equal(describedText(save), refusal, "Save says why it is disabled");
    assert.ok((guardrailsDialog()!.querySelector(".modal-foot")?.textContent ?? "").includes(refusal),
      "the refusal is a visible footer line");
    await act(async () => fireDomEvent.click(save));
    assert.deepEqual(fixture.saved, []);
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("a person refused only configuration sees Plan Mode disabled with the refusal", async () => {
  const refusal = "Your role can't change this session's settings.";
  const fixture = await mountGuardrails();
  try {
    await fixture.render({}, { configRefusal: refusal });
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!));
    const plan = menuRow("Plan Mode");
    assert.equal(plan?.disabled, true);
    assert.equal(plan?.querySelector(".menu-desc")?.textContent, refusal);
    assert.equal(menuRow("Attach Image")?.disabled, false, "attaching belongs to a prompt, which this person may send");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("the Composer exposes human-controlled Parent Control only for Orchestrator sessions", async () => {
  const selected: ParentControlMode[] = [];
  const typed: Array<[DelegatableWorkflowDecisionCategory, WorkflowDecisionAuthority]> = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (permissionMode: string) => root.render(<ComposerPlusMenu
    session={{ permissionMode, parentControl: "off", parentControlPolicy: {
      revision: 3,
      decisions: {
        implementation_question: "human",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "human",
      },
    }, orchestratorPolicy: {
      version: 1,
      behavior: {
        childHarness: { agentId: "claude", driver: "claude-code", context: { kind: "native" } },
        childModel: "claude-opus-5",
        childEffort: "high",
        maximumConcurrentChildren: 6,
        followUps: "recommend_only",
        completion: "retain",
      },
      delegation: {
        parentControl: "off",
        decisions: {
          implementation_question: "human",
          pr_merge: "human",
          merged_branch_deletion: "human",
          follow_up_issue_publication: "human",
          ui_evidence_approval: "human",
        },
      },
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
    }, orchestratorCampaign: {
      status: "waiting_human",
      policyRevision: 3,
      decisionOwners: {
        implementation_question: "human",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "human",
      },
      limits: { maximumConcurrentChildren: 6, occupied: 2, remaining: 4, costBudgetUsd: null, maxToolCalls: null },
      uiEvidenceReview: { status: "unavailable", effectiveOwner: "human", reasonCode: "harness_unsupported", reason: "No image reader." },
      children: { total: 3, active: 2, waitingHuman: 1, blocked: 0, verified: 0, cleanupPending: 0 },
      pendingDecisions: { human: 1, orchestrator: 0 },
      followUps: { unique: 2, duplicates: 1 },
    }, costBudgetUsd: null,
      costCheckpointsUsd: null, maxToolCalls: null } as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onSaveGuardrails={async () => {}}
    onSetParentControl={(mode) => selected.push(mode)}
    onSetParentControlPolicy={(category, authority) => typed.push([category, authority])}
    disabled={false}
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />);
  await act(async () => render("default"));
  try {
    await act(async () => fireDomEvent.click(
      page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!,
    ));
    assertNoDomNode(page().querySelector('[aria-label^="Parent Control:"]'));

    await act(async () => render("orchestrator"));
    const select = page().querySelector<HTMLButtonElement>('[aria-label="Parent Control: Human"]');
    assert.ok(select);
    assert.match(page().textContent ?? "", /Campaign Behavior/);
    assert.match(page().textContent ?? "", /claude · Claude Code · Native/);
    assert.match(page().textContent ?? "", /claude-opus-5/);
    assert.match(page().textContent ?? "", /Session Override/);
    assert.match(page().textContent ?? "", /keeps its stored policy when account defaults change/);
    assert.match(page().textContent ?? "", /Waiting for HumanPolicy Revision 3/);
    assert.match(page().textContent ?? "", /0 Verified/);
    assert.match(page().textContent ?? "", /1 Duplicates Skipped/);
    assert.match(page().textContent ?? "", /assigned to the Orchestrator but is routed to a human\. No image reader\./,
      "the campaign explains the specific reason instead of a generic one");
    await act(async () => fireDomEvent.click(select));
    const questions = [...page().querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Questions") && !option.textContent?.includes("Approvals"));
    assert.ok(questions);
    await act(async () => fireDomEvent.click(questions));
    assert.deepEqual(selected, ["questions"]);
    const mergeAuthority = page().querySelector<HTMLButtonElement>('[aria-label="PR Merge Approval: Human"]');
    assert.ok(mergeAuthority, "each sensitive workflow category has its own authority control");
    await act(async () => fireDomEvent.keyDown(mergeAuthority, { key: "ArrowDown" }));
    const authorityOptions = page().querySelector<HTMLElement>('[role="listbox"][aria-label="PR Merge Approval"]');
    assert.ok(authorityOptions);
    await act(async () => fireDomEvent.keyDown(authorityOptions, { key: "ArrowDown" }));
    await act(async () => fireDomEvent.keyDown(authorityOptions, { key: "Enter" }));
    assert.deepEqual(typed, [["pr_merge", "orchestrator"]]);
    for (const label of [
      "Implementation Questions", "PR Merge Approval", "Merged Branch Deletion",
      "Follow-Up Issue Publication", "UI Evidence Approval",
    ]) assert.ok(page().querySelector(`[aria-label^="${label}:"]`), `${label} is explicitly labelled`);
    assert.match(page().textContent ?? "", /provider may retain images in provider-local transcripts or media logs/,
      "the session override discloses provider-local retention before delegation");
    assert.match(page().textContent ?? "", /provider-local retention is outside those audit guarantees/);
    assert.match(page().textContent ?? "", /Video evidence otherwise requires human review, including video attached as a Session artifact/);
    assert.match(page().textContent ?? "", /Only an authenticated human can change/);
    assert.match(page().textContent ?? "", /unconsumed approvals are revoked/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a person refused configuration cannot change Parent Control from the + menu (#2175)", async () => {
  const refusal = "Your Viewer role is read-only.";
  const selected: ParentControlMode[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ComposerPlusMenu
    session={{ permissionMode: "orchestrator", role: "orchestrator", parentControl: "off",
      costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null } as unknown as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onSaveGuardrails={async () => {}}
    configRefusal={refusal}
    onSetParentControl={(mode) => selected.push(mode)}
    disabled
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />));
  try {
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!));
    const select = page().querySelector<HTMLButtonElement>('[aria-label="Parent Control: Human"]');
    assert.ok(select, "the Orchestrator block still shows the current assignment");
    assert.equal(select.getAttribute("aria-disabled"), "true", "a paused composer's + menu cannot fire a refused change");
    assert.match(page().textContent ?? "", new RegExp(refusal.replace(".", "\\.")), "and says why");
    await act(async () => fireDomEvent.click(select));
    assert.deepEqual(selected, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function descendantRequest(title: string): DescendantRequestView {
  return {
    sessionId: `session-${title}`,
    sessionTitle: title,
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: 1,
    createdAt: 1,
    responseOwner: "human",
    occurrenceId: `request-${title}`,
    request: {
      requestId: `provider-${title}`,
      occurrenceId: `request-${title}`,
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "q", header: "Next", question: "What next?", options: [] }],
    },
  };
}

test("descendant polling coalesces intervals and rejects superseded responses", async () => {
  const requests: Array<Deferred<{ requests: DescendantRequestView[] }> & {
    sessionId: string;
    signal?: AbortSignal;
  }> = [];
  const client = {
    ...api,
    descendantRequests: async (sessionId: string, signal?: AbortSignal) => {
      const request = { ...deferred<{ requests: DescendantRequestView[] }>(), sessionId, signal };
      requests.push(request);
      return request.promise;
    },
  } as ApiClient;
  let intervalHandler: (() => void) | undefined;
  let intervalRegistrations = 0;
  await withScopedClockOverrides(domWindow, {
    setInterval: ((handler: () => void) => {
      intervalRegistrations += 1;
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
    clearInterval: (() => {}) as typeof domWindow.clearInterval,
  }, async () => {
  let requestReferenceChanges = 0;
  let exposedRefreshAfterResolution: (() => void) | undefined;
  function Harness({ sessionId, enabled, available }: {
    sessionId: string;
    enabled: boolean;
    available: boolean;
  }) {
    const polling = useDescendantRequestPolling({ sessionId, enabled, available });
    exposedRefreshAfterResolution = polling.refreshAfterResolution;
    const priorRequests = React.useRef(polling.requests);
    React.useEffect(() => {
      if (priorRequests.current === polling.requests) return;
      requestReferenceChanges += 1;
      priorRequests.current = polling.requests;
    }, [polling.requests]);
    return <div data-poll-status={polling.status}>
      <button onClick={polling.refreshAfterResolution}>Refresh After Resolution</button>
      <span>{polling.requests.map((request) => request.sessionTitle).join(",")}</span>
    </div>;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (sessionId: string, enabled: boolean, available = true) => root.render(
    <ApiProvider client={client}>
      <Harness sessionId={sessionId} enabled={enabled} available={available} />
    </ApiProvider>,
  );
  try {
    await act(async () => render("parent-a", true));
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "loading",
      "the first request remains visibly non-authoritative while it is pending");
    assert.equal(requests.length, 1);
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 1, "a slow request coalesces the next interval poll");

    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    assert.equal(requests.length, 2, "a resolution forces an immediate replacement request");
    assert.equal(requests[0]!.signal?.aborted, true);
    await act(async () => {
      requests[1]!.resolve({ requests: [descendantRequest("new")] });
      await requests[1]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "new");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "ready");
    await act(async () => {
      requests[0]!.resolve({ requests: [descendantRequest("stale")] });
      await requests[0]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "new",
      "a superseded response cannot overwrite the current list");

    const referenceChangesAfterNewResult = requestReferenceChanges;
    await act(async () => intervalHandler?.());
    await act(async () => {
      requests[2]!.resolve({ requests: [descendantRequest("new")] });
      await requests[2]!.promise;
    });
    assert.equal(requestReferenceChanges, referenceChangesAfterNewResult,
      "a structurally unchanged poll retains the current state reference");

    await act(async () => intervalHandler?.());
    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    assert.equal(requests[3]!.signal?.aborted, true);
    await act(async () => {
      requests[4]!.resolve({ requests: [descendantRequest("newer")] });
      await requests[4]!.promise;
    });
    await act(async () => {
      requests[3]!.reject(new Error("late failure"));
      await requests[3]!.promise.catch(() => {});
    });
    assert.equal(page().querySelector("span")?.textContent, "newer",
      "a superseded failure cannot clear a newer successful result");

    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    await act(async () => {
      requests[5]!.reject(new Error("offline"));
      await requests[5]!.promise.catch(() => {});
    });
    assert.equal(page().querySelector("span")?.textContent, "",
      "a current request failure clears stale request controls");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable",
      "a current request failure is not mistaken for an authoritative empty result");
    const referenceChangesAfterFirstUnavailable = requestReferenceChanges;

    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    await act(async () => {
      requests[6]!.resolve({
        requests: [{ ...descendantRequest("old-control-plane"), eventEpoch: undefined as unknown as number }],
      });
      await requests[6]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "",
      "mixed-version rows without exact routing metadata fail closed");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable",
      "an incompatible response is not treated as an authoritative empty result");
    assert.equal(requestReferenceChanges, referenceChangesAfterFirstUnavailable,
      "an equivalent incompatible result retains the unavailable request reference");

    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    await act(async () => {
      requests[7]!.reject(new Error("still offline"));
      await requests[7]!.promise.catch(() => {});
    });
    assert.equal(requestReferenceChanges, referenceChangesAfterFirstUnavailable,
      "repeated failures retain the unavailable request reference while polling continues");

    await act(async () => fireDomEvent.click(page().querySelector("button")!));
    await act(async () => render("parent-b", true));
    assert.equal(requests[8]!.signal?.aborted, true, "changing sessions aborts the old request");
    assert.equal(requests.length, 10);
    assert.equal(requests[9]!.sessionId, "parent-b");
    assert.equal(page().querySelector("span")?.textContent, "");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "loading",
      "switching sessions cannot reuse the prior session's authoritative state");
    const enabledRefresh = exposedRefreshAfterResolution;
    await act(async () => render("parent-b", false));
    assert.equal(requests[9]!.signal?.aborted, true, "disabling Parent Control aborts the request");
    assert.equal(page().querySelector("span")?.textContent, "");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "idle");
    await act(async () => enabledRefresh?.());
    assert.equal(requests.length, 10, "a stale resolution callback cannot restart disabled polling");
    await act(async () => render("parent-b", true));
    assert.equal(requests.length, 11);
    await act(async () => {
      requests[10]!.resolve({ requests: [descendantRequest("before-disconnect")] });
      await requests[10]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "before-disconnect");
    const referenceChangesBeforeDisconnect = requestReferenceChanges;
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 12);
    const intervalRegistrationsBeforeDisconnect = intervalRegistrations;
    await act(async () => render("parent-b", true, false));
    assert.equal(requests[11]!.signal?.aborted, true, "disconnecting aborts the active request");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable");
    assert.equal(page().querySelector("span")?.textContent, "");
    assert.equal(requestReferenceChanges, referenceChangesBeforeDisconnect + 1,
      "disconnecting clears populated request controls exactly once");
    assert.equal(intervalRegistrations, intervalRegistrationsBeforeDisconnect,
      "disconnecting does not schedule recurring offline refreshes");
    await act(async () => render("parent-b", true, true));
    assert.equal(requests.length, 13, "reconnecting retries without reopening the panel");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "loading");
    await act(async () => root.unmount());
    assert.equal(requests[12]!.signal?.aborted, true, "unmounting aborts the active request");
  } finally {
    if (container.isConnected) await act(async () => root.unmount());
    container.remove();
  }
  });
});

test("descendant polling keeps replacement deadlines when expired timer ids are reused", async () => {
  const requests: Array<Deferred<{ requests: DescendantRequestView[] }> & {
    signal?: AbortSignal;
  }> = [];
  const client = {
    ...api,
    descendantRequests: async (_sessionId: string, signal?: AbortSignal) => {
      const request = { ...deferred<{ requests: DescendantRequestView[] }>(), signal };
      requests.push(request);
      return request.promise;
    },
  } as ApiClient;
  let intervalHandler: (() => void) | undefined;
  let requestReferenceChanges = 0;
  const reusedTimeoutId = 1;
  const timeouts = new Map<number, { handler: () => void; delay: number }>();
  await withScopedClockOverrides(domWindow, {
    setInterval: ((handler: () => void) => {
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
    clearInterval: (() => {}) as typeof domWindow.clearInterval,
    setTimeout: ((handler: () => void, delay = 0) => {
      assert.equal(timeouts.has(reusedTimeoutId), false, "polls have at most one active deadline");
      timeouts.set(reusedTimeoutId, { handler, delay });
      return reusedTimeoutId as unknown as ReturnType<typeof domWindow.setTimeout>;
    }) as unknown as typeof domWindow.setTimeout,
    clearTimeout: ((id: number) => {
      timeouts.delete(id);
    }) as unknown as typeof domWindow.clearTimeout,
  }, async () => {
  const fireActiveTimeout = () => {
    const active = timeouts.get(reusedTimeoutId);
    assert.ok(active);
    timeouts.delete(reusedTimeoutId);
    active.handler();
  };
  function Harness() {
    const polling = useDescendantRequestPolling({ sessionId: "parent", enabled: true, available: true });
    const priorRequests = React.useRef(polling.requests);
    React.useEffect(() => {
      if (priorRequests.current === polling.requests) return;
      requestReferenceChanges += 1;
      priorRequests.current = polling.requests;
    }, [polling.requests]);
    return <span data-poll-status={polling.status}>
      {polling.requests.map((request) => request.sessionTitle).join(",")}
    </span>;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={client}><Harness /></ApiProvider>));
    assert.equal(requests.length, 1);
    assert.deepEqual([...timeouts.values()].map(({ delay }) => delay), [DESCENDANT_REQUEST_POLL_TIMEOUT_MS]);
    await act(async () => {
      requests[0]!.resolve({ requests: [descendantRequest("current")] });
      await requests[0]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "current");
    assert.equal(timeouts.size, 0, "successful settlement clears its deadline");

    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 2);
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 2, "intervals still coalesce before the deadline");

    await act(async () => fireActiveTimeout());
    assert.equal(requests[1]!.signal?.aborted, true, "the deadline aborts the hung request");
    assert.equal(page().querySelector("span")?.getAttribute("data-poll-status"), "unavailable");
    assert.equal(page().querySelector("span")?.textContent, "",
      "timed-out request controls fail closed without reporting an authoritative empty result");
    const referenceChangesAfterFirstTimeout = requestReferenceChanges;
    await act(async () => {
      requests[1]!.resolve({ requests: [descendantRequest("late-success")] });
      await requests[1]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "");
    assert.equal(requests.length, 2,
      "a timed-out success remains harmless before the next interval starts");

    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 3, "the next interval starts a replacement poll");
    await act(async () => fireActiveTimeout());
    assert.equal(requests[2]!.signal?.aborted, true);
    assert.equal(requestReferenceChanges, referenceChangesAfterFirstTimeout,
      "repeated timeouts retain the unavailable request reference");
    await act(async () => {
      requests[2]!.reject(new Error("late timeout failure"));
      await requests[2]!.promise.catch(() => {});
    });
    assert.equal(page().querySelector("span")?.textContent, "");
    assert.equal(requests.length, 3,
      "a timed-out failure remains harmless before the next interval starts");

    await act(async () => intervalHandler?.());
    await act(async () => fireActiveTimeout());
    assert.equal(requests[3]!.signal?.aborted, true);
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 5);
    assert.equal(timeouts.has(reusedTimeoutId), true,
      "the replacement owns a deadline that reuses the expired request's timer id");
    await act(async () => {
      requests[3]!.resolve({ requests: [descendantRequest("stale")] });
      await requests[3]!.promise;
    });
    assert.equal(timeouts.has(reusedTimeoutId), true,
      "late cleanup from the timed-out request cannot clear the replacement deadline");
    await act(async () => fireActiveTimeout());
    assert.equal(requests[4]!.signal?.aborted, true,
      "the replacement deadline remains active after the old request settles");

    await act(async () => intervalHandler?.());
    await act(async () => {
      requests[5]!.resolve({ requests: [descendantRequest("newer")] });
      await requests[5]!.promise;
    });
    assert.equal(page().querySelector("span")?.textContent, "newer");
    await act(async () => intervalHandler?.());
    await act(async () => root.unmount());
    assert.equal(requests[6]!.signal?.aborted, true, "unmounting aborts the active request");
    assert.equal(timeouts.size, 0, "unmounting clears the active deadline");
  } finally {
    if (container.isConnected) await act(async () => root.unmount());
    container.remove();
  }
  });
});

test("a legacy campaign payload derives Integration Isolation from the preset before strictness", async () => {
  const humanOnly = {
    implementation_question: "human",
    pr_merge: "human",
    merged_branch_deletion: "human",
    follow_up_issue_publication: "human",
    ui_evidence_approval: "human",
  } as const;
  // A v144–v163 control plane: the execution block exists but has no `integrationIsolation`.
  const legacyPolicy = (strictProjectIsolation: boolean) => ({
    version: 1 as const,
    behavior: {
      childHarness: null, childModel: null, childEffort: null,
      maximumConcurrentChildren: 4, followUps: "recommend_only" as const, completion: "retain" as const,
    },
    delegation: { parentControl: "off" as const, decisions: { ...humanOnly } },
    execution: { strictProjectIsolation },
    sources: {
      behavior: {
        childHarness: "legacy_session" as const, childModel: "legacy_session" as const,
        childEffort: "legacy_session" as const, maximumConcurrentChildren: "legacy_session" as const,
        followUps: "legacy_session" as const, completion: "legacy_session" as const,
      },
      delegation: {
        parentControl: "legacy_session" as const,
        decisions: Object.fromEntries(Object.keys(humanOnly).map((key) => [key, "legacy_session"])),
      },
      execution: { strictProjectIsolation: "legacy_session" as const },
    },
  });
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (permissionMode: string, strictProjectIsolation: boolean) => root.render(<ComposerPlusMenu
    session={{
      // The role is explicit, so the additive cases below reach the panel too: only
      // `usesOrchestratorPresetPermissions` distinguishes them, which is what this test is about.
      permissionMode, role: "orchestrator", driver: "claude-code", parentControl: "off",
      orchestratorPolicy: legacyPolicy(strictProjectIsolation),
      costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null,
    } as unknown as SessionView}
    planActive={false} planSupported={false} onTogglePlan={() => {}} onSaveGuardrails={async () => {}}
    onSetParentControl={() => {}} onSetParentControlPolicy={() => {}}
    disabled={false} imageMimeTypes={[]} onAttachImages={() => {}}
  />);
  const row = () => {
    const term = [...page().querySelectorAll("dt")].find((node) => node.textContent === "Integration Isolation");
    assert.ok(term, "the Campaign Behavior panel shows the stored value");
    return term.nextElementSibling!.textContent ?? "";
  };
  const open = async (permissionMode: string, strictProjectIsolation: boolean) => {
    await act(async () => render(permissionMode, strictProjectIsolation));
    const toggle = page().querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!;
    if (!page().querySelector('[aria-label="Active Campaign Behavior"]')) {
      await act(async () => fireDomEvent.click(toggle));
    }
  };
  try {
    // The case the review caught: a NON-strict coupled preset. Its stored strictness is false, but
    // the preset still replaced the whole provider surface, so it launched without integrations.
    await open("orchestrator", false);
    assert.match(row(), /^Enabled/,
      "a non-strict coupled preset removed integrations, so strictness must not be read first");
    assert.match(row(), /Legacy Session/, "and the derived value is attributed as legacy provenance");
    const disclosure = () => [...page().querySelectorAll("dt")]
      .find((node) => node.textContent === "Integration Isolation")!.parentElement!.getAttribute("title") ?? "";
    // A preset launch replaces the provider surface, so it must not borrow the additive launch's
    // "kept" list: a Claude preset keeps neither configured hooks' settings sources nor any MCP server.
    assert.match(disclosure(), /harness-owned Orchestrator preset/);
    assert.doesNotMatch(disclosure(), /are all kept|are kept/);

    // An additive legacy session is the opposite: ordinary provider mode, integrations intact.
    await open("acceptEdits", false);
    assert.match(row(), /^Disabled/);
    // A strict legacy session is Enabled through the boundary rather than the preset literal.
    await open("acceptEdits", true);
    assert.match(row(), /^Enabled/);
    // An additive-shaped session keeps the per-harness disclosure.
    assert.match(disclosure(), /Removes configured MCP servers/);
    assert.doesNotMatch(disclosure(), /harness-owned Orchestrator preset/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
