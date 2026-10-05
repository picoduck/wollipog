import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  DescendantRequestView,
  SessionConfig,
  SessionView,
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
import { modelRefusesImagesSentence } from "./images.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
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

type CampaignContinuation = Parameters<typeof CampaignContinuationNotice>[0]["continuation"];

function continuation(overrides: Partial<CampaignContinuation>): CampaignContinuation {
  return {
    state: "pending",
    pendingEvents: 3,
    continuationId: "campaign_cont_one",
    commandId: "campaign_prompt_one",
    eventFromSeq: 4,
    eventThroughSeq: 6,
    attemptCount: 2,
    updatedAt: 10,
    ...overrides,
  };
}

async function mountContinuation(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    notice: () => container.querySelector<HTMLElement>(".notice"),
    render: (next: React.ReactElement) => act(async () => root.render(next)),
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("each campaign continuation state reads in plain words with its title, tone and body (#2157)", async () => {
  const cases: Array<{
    name: string;
    continuation: CampaignContinuation;
    tone: string;
    title: string | null;
    body: string;
  }> = [
    {
      name: "missing result",
      continuation: continuation({ state: "missing_result", canAcknowledgeMissingResult: true, error: "No result." }),
      tone: "t-warning",
      title: "Update Result Missing",
      body: "The Orchestrator accepted an update but never reported a result. It won't be sent again automatically.",
    },
    {
      name: "failed with retry",
      continuation: continuation({ state: "failed", canRetry: true, error: "Runner queue remained full." }),
      tone: "t-danger",
      title: "Couldn't Resume the Orchestrator",
      body: "Automatic retries stopped. Retry when the problem is fixed.",
    },
    {
      name: "failed, retrying automatically",
      continuation: continuation({ state: "failed", error: "Runner queue remained full." }),
      tone: "t-warning",
      title: null,
      body: "Couldn't resume the Orchestrator. Wollipog will try again.",
    },
    {
      name: "pending",
      continuation: continuation({ state: "pending" }),
      tone: "t-neutral",
      title: null,
      body: "Catching up on 3 updates before the Orchestrator continues.",
    },
    {
      name: "running",
      continuation: continuation({ state: "running", pendingEvents: 1 }),
      tone: "t-neutral",
      title: null,
      body: "The Orchestrator is working through 1 update.",
    },
    {
      name: "held",
      continuation: continuation({ state: "held" }),
      tone: "t-neutral",
      title: null,
      body: "Updates are kept until the current hold clears.",
    },
  ];
  for (const testCase of cases) {
    const view = await mountContinuation(
      <CampaignContinuationNotice continuation={testCase.continuation} onAcknowledge={() => {}} onRetry={() => {}} />,
    );
    try {
      const notice = view.notice();
      assert.ok(notice, testCase.name);
      assert.ok(notice.classList.contains(testCase.tone), `${testCase.name}: ${notice.className}`);
      assert.equal(notice.getAttribute("data-state"), testCase.continuation.state, testCase.name);
      assert.equal(notice.classList.contains("compact"), testCase.title === null,
        `${testCase.name}: a titled notice is full size and a progress line is compact`);
      assert.equal(notice.querySelector(".notice-title")?.textContent ?? null, testCase.title, testCase.name);
      if (testCase.title) assert.equal(notice.getAttribute("aria-label"), testCase.title, testCase.name);
      assert.equal(notice.querySelector(".notice-body")?.textContent, testCase.body, testCase.name);
      assert.doesNotMatch(notice.textContent ?? "", /durable|coalescing|reconciling|terminal result/iu,
        `${testCase.name}: no internal jargon`);
      // The counts and the error are details, never under the explanation.
      assertNoDomNode(notice.querySelector(".facts"), `${testCase.name}: no facts until Show Details`);
      assert.doesNotMatch(notice.textContent ?? "", /Attempt|Runner queue|No result\./u, testCase.name);
      assertNoDomNode(notice.querySelector(".notice-meta"), `${testCase.name}: no meta lines`);
    } finally {
      await view.dispose();
    }
  }
});

test("campaign continuation details list pending updates, the attempt and the error in a code well", async () => {
  const view = await mountContinuation(
    <CampaignContinuationNotice
      continuation={continuation({ state: "failed", canRetry: true, attemptCount: 5, error: "Runner queue remained full." })}
      onRetry={() => {}}
    />,
  );
  try {
    const toggle = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Show Details");
    assert.ok(toggle, "Show Details is in the action row");
    await act(async () => fireDomEvent.click(toggle));
    const facts = view.container.querySelector<HTMLElement>(".notice-details-body dl.facts");
    assert.ok(facts);
    assert.deepEqual([...facts.querySelectorAll("dt")].map((term) => term.textContent),
      ["Pending Updates", "Attempt", "Error"]);
    assert.deepEqual([...facts.querySelectorAll("dd")].map((value) => value.textContent),
      ["3", "5", "Runner queue remained full."]);
    assert.equal(facts.querySelector("dd .code-well code")?.textContent, "Runner queue remained full.");
    assert.equal(view.notice()?.querySelector(".notice-body")?.textContent,
      "Automatic retries stopped. Retry when the problem is fixed.", "the explanation stays in view");

    await view.render(<CampaignContinuationNotice continuation={continuation({ state: "pending" })} />);
    assert.deepEqual([...view.container.querySelectorAll(".facts dt")].map((term) => term.textContent),
      ["Pending Updates", "Attempt"], "without an error there is no Error fact");
  } finally {
    await view.dispose();
  }
});

test("Acknowledge and Retry Now resolve the continuation and keep their labels while busy", async () => {
  const acknowledged: string[] = [];
  const retried: string[] = [];
  const missing = continuation({ state: "missing_result", canAcknowledgeMissingResult: true });
  const failed = continuation({ state: "failed", canRetry: true, commandId: "campaign_prompt_failed" });
  const view = await mountContinuation(
    <CampaignContinuationNotice continuation={missing} onAcknowledge={(commandId) => acknowledged.push(commandId)} />,
  );
  const action = () => view.container.querySelector<HTMLButtonElement>("button:not(.notice-details-toggle)")!;
  try {
    assert.equal(action().textContent, "Acknowledge");
    await act(async () => fireDomEvent.click(action()));
    assert.deepEqual(acknowledged, ["campaign_prompt_one"]);

    await view.render(<CampaignContinuationNotice continuation={missing} acknowledgementPending
      onAcknowledge={(commandId) => acknowledged.push(commandId)} />);
    assert.equal(action().textContent, "Acknowledge", "the label stays while busy");
    assert.equal(action().getAttribute("aria-busy"), "true");
    assert.match(view.container.textContent ?? "", /Acknowledging the missing result…/u, "progress is announced");
    await act(async () => fireDomEvent.click(action()));
    assert.deepEqual(acknowledged, ["campaign_prompt_one"], "a busy button refuses a second press");

    await view.render(<CampaignContinuationNotice continuation={failed} onRetry={(commandId) => retried.push(commandId)} />);
    assert.equal(action().textContent, "Retry Now");
    await act(async () => fireDomEvent.click(action()));
    assert.deepEqual(retried, ["campaign_prompt_failed"]);
    await view.render(<CampaignContinuationNotice continuation={failed} acknowledgementPending
      onRetry={(commandId) => retried.push(commandId)} />);
    assert.equal(action().textContent, "Retry Now", "the label stays while busy");
    assert.equal(action().getAttribute("aria-busy"), "true");
    assert.match(view.container.textContent ?? "", /Retrying the Orchestrator…/u);
  } finally {
    await view.dispose();
  }
});

test("a Viewer reads the continuation's action disabled with the reason as visible text it describes (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const acknowledged: string[] = [];
  for (const shown of [
    continuation({ state: "missing_result", canAcknowledgeMissingResult: true }),
    continuation({ state: "failed", canRetry: true }),
  ]) {
    const view = await mountContinuation(
      <CampaignContinuationNotice continuation={shown} actionRefusal={reason}
        onAcknowledge={(commandId) => acknowledged.push(commandId)} onRetry={(commandId) => acknowledged.push(commandId)} />,
    );
    try {
      const button = view.container.querySelector<HTMLButtonElement>("button:not(.notice-details-toggle)")!;
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("title"), null, "the reason is never only a tooltip");
      const described = button.getAttribute("aria-describedby");
      const line = described ? domWindow.document.getElementById(described) : null;
      assert.equal(line?.textContent, reason);
      assert.ok(view.notice()?.querySelector(".notice-body")?.contains(line as never), "the reason is a visible body line");
      await act(async () => fireDomEvent.click(button));
      assert.deepEqual(acknowledged, []);
    } finally {
      await view.dispose();
    }
  }

  // A notice with nothing to act on shows no refusal.
  const view = await mountContinuation(
    <CampaignContinuationNotice continuation={continuation({ state: "pending" })} actionRefusal={reason} />,
  );
  try {
    assert.doesNotMatch(view.container.textContent ?? "", /Viewer/u);
  } finally {
    await view.dispose();
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
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!));
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
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!));
    const row = menuRow("Guardrails…");
    assert.ok(row, "the menu offers Guardrails…");
    assert.equal(row.querySelector(".menu-desc")?.textContent, "No limits set.");
    const menu = page().querySelector('.menu[aria-label="Attach and Settings"]');
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
    assertNoDomNode(page().querySelector('.menu[aria-label="Attach and Settings"]'),
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
    const plus = page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!;
    assert.equal(plus.disabled, false, "+ opens on a paused composer");
    await act(async () => fireDomEvent.click(plus));
    assert.equal(menuRow("Attach Image…")?.disabled, true);
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
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!));
    const plan = menuRow("Plan Mode");
    assert.equal(plan?.disabled, true);
    assert.equal(plan?.querySelector(".menu-desc")?.textContent, refusal);
    assert.equal(menuRow("Attach Image…")?.disabled, false, "attaching belongs to a prompt, which this person may send");
  } finally {
    await unmountGuardrails(fixture);
  }
});

test("the + menu offers one Orchestrator Controls row, only on an Orchestrator session (#2192)", async () => {
  const opened: Array<HTMLElement | null> = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (permissionMode: string) => root.render(<ComposerPlusMenu
    session={{ permissionMode, parentControl: "questions", parentControlPolicy: {
      revision: 3,
      decisions: {
        implementation_question: "orchestrator",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "orchestrator",
        ui_evidence_approval: "human",
      },
    }, costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null } as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onSaveGuardrails={async () => {}}
    onOpenOrchestratorControls={(returnFocus) => opened.push(returnFocus)}
    disabled={false}
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />);
  const row = () => [...page().querySelectorAll<HTMLButtonElement>(".menu-item")]
    .find((item) => item.querySelector(".menu-text")?.textContent === "Orchestrator Controls…");
  await act(async () => render("default"));
  try {
    const trigger = page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!;
    await act(async () => fireDomEvent.click(trigger));
    assert.equal(row(), undefined, "a session that is not an Orchestrator has no such row");

    await act(async () => render("orchestrator"));
    const controls = row();
    assert.ok(controls, "an Orchestrator session has the row");
    assert.equal(controls.querySelector(".menu-desc")?.textContent, "3 of 5 decisions stay with a person.",
      "its second line summarizes the gates");
    const menu = controls.closest<HTMLElement>(".menu")!;
    assertNoDomNode(menu.querySelector("dl, .ui-select, [role='listbox'], [aria-label^='Parent Control']"),
      "no campaign facts or selects stay in the menu");
    assert.doesNotMatch(menu.textContent ?? "", /Campaign Behavior|unconsumed approvals|provider may retain images/,
      "and no paragraph");
    await act(async () => fireDomEvent.click(controls));
    assert.deepEqual(opened, [trigger], "the row opens Orchestrator Controls, which returns focus to +");
    assert.equal(row(), undefined, "and the menu closes");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a paused composer's + menu still opens Orchestrator Controls for a person refused configuration (#2175, #2192)", async () => {
  // The row only opens the dialog, whose controls refuse with the reason (OrchestratorControlsDialog
  // DOM tests), so it stays available like Guardrails…, which opens read-only.
  const refusal = "Your Viewer role is read-only.";
  const opened: Array<HTMLElement | null> = [];
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
    onOpenOrchestratorControls={(returnFocus) => opened.push(returnFocus)}
    disabled
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />));
  try {
    await act(async () => fireDomEvent.click(page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!));
    const row = [...page().querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((item) => item.querySelector(".menu-text")?.textContent === "Orchestrator Controls…");
    assert.ok(row, "the paused menu keeps the row");
    assert.equal(row.disabled, false, "and it opens the dialog");
    assert.equal(row.getAttribute("aria-disabled"), null);
    assert.equal(row.querySelector(".menu-desc")?.textContent, "Child session requests: Human.",
      "a control plane without typed gates summarizes the one choice it has");
    await act(async () => fireDomEvent.click(row));
    assert.equal(opened.length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** Renders the + menu with every row on offer, recording what each row did (#2203). */
async function mountPlusMenu(props: Partial<React.ComponentProps<typeof ComposerPlusMenu>> = {}) {
  const calls: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = async (next: Partial<React.ComponentProps<typeof ComposerPlusMenu>> = {}) => {
    await act(async () => root.render(<ComposerPlusMenu
      session={{ ...GUARDRAIL_SESSION, permissionMode: "orchestrator", role: "orchestrator", parentControl: "off" } as unknown as SessionView}
      planActive={false}
      planSupported
      onTogglePlan={() => calls.push("plan")}
      onSaveGuardrails={async () => {}}
      onOpenOrchestratorControls={() => calls.push("orchestrator")}
      onReferenceFile={() => calls.push("reference")}
      disabled={false}
      imageMimeTypes={["image/png", "image/jpeg", "image/gif", "image/webp"]}
      onAttachImages={() => {}}
      {...props}
      {...next}
    />));
  };
  await render();
  const trigger = () => page().querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]')!;
  const menu = () => page().querySelector<HTMLElement>('[role="menu"][aria-label="Attach and Settings"]');
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { calls, render, trigger, menu, unmount };
}

test("the + button is Attach and Settings and opens a plain menu of five rows (#2203)", async () => {
  const fixture = await mountPlusMenu();
  try {
    const trigger = fixture.trigger();
    assert.ok(trigger, "+ is named Attach and Settings");
    assert.equal(trigger.title, "Attach and Settings", "its tooltip is the same name");
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    await act(async () => fireDomEvent.click(trigger));
    const menu = fixture.menu();
    assert.ok(menu, "+ opens an element with role=menu");
    assert.equal(trigger.getAttribute("aria-controls"), menu.id);
    assert.equal(menu.querySelector(".menu-head")?.textContent, "Attach and Settings", "the phone sheet's title");
    assertNoDomNode(menu.querySelector("input, select, textarea, .menu-label"), "no field, select or section label");
    const rows = [...menu.querySelectorAll<HTMLElement>("button")];
    assert.deepEqual(rows.map((row) => row.getAttribute("role")),
      ["menuitem", "menuitem", "menuitemcheckbox", "menuitem", "menuitem"], "only menu items");
    assert.deepEqual(rows.map((row) => row.querySelector(".menu-text")?.textContent),
      ["Attach Image…", "Reference a File…", "Plan Mode", "Guardrails…", "Orchestrator Controls…"]);
    assert.ok(rows.every((row) => row.querySelector(".menu-icon svg")), "every row has a leading icon");
    assert.equal(menu.querySelectorAll('[role="separator"]').length, 2,
      "separators group adding to the message, the mode and the session's limits");
    assert.equal(rows[0]!.querySelector(".menu-desc")?.textContent, "PNG, JPEG, GIF or WebP, up to 6 images.");
    assert.equal(rows[2]!.querySelector(".menu-desc")?.textContent,
      "Research and propose a plan without editing files. Or type /plan.");
    for (const row of rows) {
      assert.doesNotMatch(row.querySelector(".menu-desc")?.textContent ?? "", /·|\s\+\s/u, "no meta strings");
    }
  } finally {
    await fixture.unmount();
  }
});

test("the + menu leaves out Reference a File…, Plan Mode and Orchestrator Controls… when they don't apply (#2203)", async () => {
  const fixture = await mountPlusMenu({
    onReferenceFile: undefined,
    planSupported: false,
    session: { ...GUARDRAIL_SESSION, permissionMode: "default" } as SessionView,
  });
  try {
    await act(async () => fireDomEvent.click(fixture.trigger()));
    const labels = [...fixture.menu()!.querySelectorAll(".menu-text")].map((node) => node.textContent);
    assert.deepEqual(labels, ["Attach Image…", "Guardrails…"]);
    assert.equal(fixture.menu()!.querySelectorAll('[role="separator"]').length, 1);
  } finally {
    await fixture.unmount();
  }
});

test("with a model that can't read images, Attach Image… is disabled with the drop target's sentence (#2203)", async () => {
  const sentence = modelRefusesImagesSentence("Tiny Model");
  const fixture = await mountPlusMenu({ imageMimeTypes: [], imagesRefusedReason: sentence });
  try {
    await act(async () => fireDomEvent.click(fixture.trigger()));
    const attach = [...fixture.menu()!.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((row) => row.querySelector(".menu-text")?.textContent === "Attach Image…")!;
    assert.equal(attach.disabled, true);
    assert.equal(attach.querySelector(".menu-desc")?.textContent,
      "Tiny Model can't read images. Choose another model in Model Settings to attach them.");
  } finally {
    await fixture.unmount();
  }
});

test("Plan Mode shows a trailing check when on and toggles in one activation (#2203)", async () => {
  const fixture = await mountPlusMenu();
  try {
    await act(async () => fireDomEvent.click(fixture.trigger()));
    const plan = () => fixture.menu()?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]') ?? null;
    assert.equal(plan()!.getAttribute("aria-checked"), "false");
    assertNoDomNode(plan()!.querySelector(".menu-check"), "no check while off");
    await act(async () => fireDomEvent.click(plan()!));
    assert.deepEqual(fixture.calls, ["plan"], "one activation toggles Plan Mode");
    assertNoDomNode(fixture.menu(), "and closes the menu");

    await fixture.render({ planActive: true });
    await act(async () => fireDomEvent.click(fixture.trigger()));
    assert.equal(plan()!.getAttribute("aria-checked"), "true");
    assert.ok(plan()!.querySelector(".menu-trail .menu-check"), "a trailing check while on");
  } finally {
    await fixture.unmount();
  }
});

test("Reference a File… hands the composer the @ trigger without returning focus to + (#2203)", async () => {
  const fixture = await mountPlusMenu();
  try {
    await act(async () => fireDomEvent.click(fixture.trigger()));
    const row = [...fixture.menu()!.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((item) => item.querySelector(".menu-text")?.textContent === "Reference a File…")!;
    assert.equal(row.querySelector(".menu-desc")?.textContent, "Attach a workspace file or folder. Or type @.");
    await act(async () => {
      fireDomEvent.click(row);
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assert.deepEqual(fixture.calls, ["reference"]);
    assertNoDomNode(fixture.menu());
    assert.notEqual(domWindow.document.activeElement, fixture.trigger(), "the composer keeps the focus it was given");

    await fixture.render({ disabled: true, disabledReason: "The session is stopped." });
    await act(async () => fireDomEvent.click(fixture.trigger()));
    const paused = [...fixture.menu()!.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((item) => item.querySelector(".menu-text")?.textContent === "Reference a File…")!;
    assert.equal(paused.disabled, true, "a paused composer refuses it");
    assert.equal(paused.querySelector(".menu-desc")?.textContent, "The session is stopped.");
  } finally {
    await fixture.unmount();
  }
});

test("a focused row that leaves or refuses while the menu is open hands focus to the next enabled item (#2203)", async () => {
  const fixture = await mountPlusMenu({ imageMimeTypes: [] });
  try {
    const trigger = fixture.trigger();
    await act(async () => { trigger.focus(); });
    await act(async () => {
      trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
    const focusedLabel = () => (domWindow.document.activeElement as unknown as HTMLElement | null)
      ?.querySelector(".menu-text")?.textContent;
    assert.equal(focusedLabel(), "Reference a File…");

    // The runner reconnects without workspace references.
    await fixture.render({ onReferenceFile: undefined });
    assert.ok(fixture.menu(), "the menu stays open");
    assert.equal(focusedLabel(), "Plan Mode", "focus moves to the first remaining enabled item, not <body>");

    // The composer pauses: Plan Mode refuses, and Guardrails… stays available.
    await fixture.render({ onReferenceFile: undefined, disabled: true });
    assert.equal(focusedLabel(), "Guardrails…");
  } finally {
    await fixture.unmount();
  }
});

for (const key of ["Enter", " ", "ArrowDown"]) {
  test(`${key === " " ? "Space" : key} on + focuses the first enabled item, even with Plan Mode on, and Escape returns to + (#2203)`, async () => {
    const fixture = await mountPlusMenu({ planActive: true, imageMimeTypes: [] });
    try {
      const trigger = fixture.trigger();
      await act(async () => { trigger.focus(); });
      await act(async () => {
        trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as never);
        // A native button turns Enter and Space into a click.
        if (key !== "ArrowDown") fireDomEvent.click(trigger);
      });
      const active = domWindow.document.activeElement as unknown as HTMLElement;
      assert.equal(active.querySelector(".menu-text")?.textContent, "Reference a File…",
        "Attach Image… is disabled, so the first enabled item is Reference a File…");
      await act(async () => {
        active.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
        await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
      });
      assertNoDomNode(fixture.menu());
      assert.equal(domWindow.document.activeElement, trigger);
    } finally {
      await fixture.unmount();
    }
  });
}

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
