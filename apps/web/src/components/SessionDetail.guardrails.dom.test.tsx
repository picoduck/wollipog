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
  WorkflowDecisionCategory,
} from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
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
    const notice = container.querySelector<HTMLElement>('[aria-label="Campaign Continuation: Missing Result"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /3 Pending Events · Attempt 2/);
    assert.match(notice.textContent ?? "", /will not be replayed automatically/);
    const acknowledge = container.querySelector<HTMLButtonElement>("button");
    assert.equal(acknowledge?.textContent, "Acknowledge Missing Result");
    await act(async () => fireDomEvent.click(acknowledge!));
    assert.deepEqual(acknowledged, ["campaign_prompt_one"]);
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
    const notice = container.querySelector<HTMLElement>('[aria-label="Campaign Continuation: Failed"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /Automatic retrying stopped/);
    const retry = container.querySelector<HTMLButtonElement>("button");
    assert.equal(retry?.textContent, "Retry Campaign Continuation");
    await act(async () => fireDomEvent.click(retry!));
    assert.deepEqual(retried, ["campaign_prompt_failed"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the Composer guardrails expose and persist the concurrent live-child limit", async () => {
  const applied: Partial<SessionConfig>[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ComposerPlusMenu
      session={{ costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null,
        maxChildSessions: undefined,
        liveChildCapacity: { limit: 4, occupied: 3, remaining: 1 } } as SessionView}
      planActive={false}
      planSupported={false}
      onTogglePlan={() => {}}
      onApply={(patch) => applied.push(patch)}
      disabled={false}
      imageMimeTypes={[]}
      onAttachImages={() => {}}
    />);
  });
  try {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]');
    assert.ok(trigger);
    await act(async () => fireDomEvent.click(trigger));
    const liveChildLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent === "Live Child Limit");
    const input = liveChildLabel?.htmlFor
      ? container.querySelector<HTMLInputElement>(`#${liveChildLabel.htmlFor}`)
      : null;
    assert.ok(input, "the Composer menu includes a labelled live-child control");
    assert.equal(input.value, "");
    assert.equal(input.placeholder, "4");
    assert.equal(input.max, "64");
    assert.match(container.textContent ?? "", /Live Child Limit/);
    assert.doesNotMatch(container.textContent ?? "", /Pauses when spend reaches this amount/,
      "verbose guardrail guidance stays out of the compact menu by default");
    const costHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Recurring Cost Threshold"]');
    assert.ok(costHelp, "each guardrail exposes its guidance through an info control");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    await act(async () => fireDomEvent.click(costHelp));
    assert.equal(costHelp.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /Pauses when spend reaches this amount/);
    const helpPopover = container.querySelector<HTMLElement>(".plus-budget-help-popover");
    assert.ok(helpPopover);
    assert.equal(costHelp.getAttribute("aria-controls"), helpPopover.id);
    assert.equal(costHelp.getAttribute("aria-describedby"), helpPopover.id);
    const toolHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Tool-Call Threshold"]');
    assert.ok(toolHelp);
    await act(async () => {
      fireDomEvent.pointerDown(toolHelp);
      fireDomEvent.click(toolHelp);
    });
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 1,
      "an outside pointer dismisses the previous disclosure before opening another");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    assert.equal(toolHelp.getAttribute("aria-expanded"), "true");
    await act(async () => fireDomEvent.keyDown(toolHelp, { key: "Escape" }));
    assert.equal(toolHelp.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 0);
    const childHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Live Child Limit"]');
    assert.ok(childHelp);
    await act(async () => fireDomEvent.click(childHelp));
    assert.match(container.textContent ?? "", /4 limit · 3 occupied · 1 remaining/,
      "the running session exposes its effective capacity, not only the configured override");
    await act(async () => fireDomEvent.keyDown(childHelp, { key: "Escape" }));
    await act(async () => {
      input.focus();
    });
    // Opening the menu focuses the first cost input; moving focus here may commit its empty clear.
    // Isolate this assertion to the live-child field's own blur behavior.
    applied.length = 0;
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "leaving an untouched default field does not pause child admission");
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "9" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied.at(-1), { maxChildSessions: 9 });
    applied.length = 0;
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "-5" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "an underflow typo cannot pause child admission");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the Composer exposes human-controlled Parent Control only for Orchestrator sessions", async () => {
  const selected: ParentControlMode[] = [];
  const typed: Array<[WorkflowDecisionCategory, WorkflowDecisionAuthority]> = [];
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
      uiEvidenceReview: { status: "unavailable", effectiveOwner: "human", reason: "No image reader." },
      children: { total: 3, active: 2, waitingHuman: 1, blocked: 0, verified: 0, cleanupPending: 0 },
      pendingDecisions: { human: 1, orchestrator: 0 },
      followUps: { unique: 2, duplicates: 1 },
    }, costBudgetUsd: null,
      costCheckpointsUsd: null, maxToolCalls: null } as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onApply={() => {}}
    onSetParentControl={(mode) => selected.push(mode)}
    onSetParentControlPolicy={(category, authority) => typed.push([category, authority])}
    disabled={false}
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />);
  await act(async () => render("default"));
  try {
    await act(async () => fireDomEvent.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!,
    ));
    assert.equal(container.querySelector('[aria-label^="Parent Control:"]'), null);

    await act(async () => render("orchestrator"));
    const select = container.querySelector<HTMLButtonElement>('[aria-label="Parent Control: Human"]');
    assert.ok(select);
    assert.match(container.textContent ?? "", /Campaign Behavior/);
    assert.match(container.textContent ?? "", /claude · Claude Code · Native/);
    assert.match(container.textContent ?? "", /claude-opus-5/);
    assert.match(container.textContent ?? "", /Session Override/);
    assert.match(container.textContent ?? "", /keeps its stored policy when account defaults change/);
    assert.match(container.textContent ?? "", /Waiting for HumanPolicy Revision 3/);
    assert.match(container.textContent ?? "", /0 Verified/);
    assert.match(container.textContent ?? "", /1 Duplicates Skipped/);
    assert.match(container.textContent ?? "", /UI evidence is routed to a human/);
    await act(async () => fireDomEvent.click(select));
    const questions = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Questions") && !option.textContent?.includes("Approvals"));
    assert.ok(questions);
    await act(async () => fireDomEvent.click(questions));
    assert.deepEqual(selected, ["questions"]);
    const mergeAuthority = container.querySelector<HTMLButtonElement>('[aria-label="PR Merge Approval: Human"]');
    assert.ok(mergeAuthority, "each sensitive workflow category has its own authority control");
    await act(async () => fireDomEvent.keyDown(mergeAuthority, { key: "ArrowDown" }));
    const authorityOptions = container.querySelector<HTMLElement>('[role="listbox"][aria-label="PR Merge Approval"]');
    assert.ok(authorityOptions);
    await act(async () => fireDomEvent.keyDown(authorityOptions, { key: "ArrowDown" }));
    await act(async () => fireDomEvent.keyDown(authorityOptions, { key: "Enter" }));
    assert.deepEqual(typed, [["pr_merge", "orchestrator"]]);
    for (const label of [
      "Implementation Questions", "PR Merge Approval", "Merged Branch Deletion",
      "Follow-Up Issue Publication", "UI Evidence Approval",
    ]) assert.ok(container.querySelector(`[aria-label^="${label}:"]`), `${label} is explicitly labelled`);
    assert.match(container.textContent ?? "", /Only an authenticated human can change/);
    assert.match(container.textContent ?? "", /unconsumed approvals are revoked/);
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
  const originalSetInterval = domWindow.setInterval;
  const originalClearInterval = domWindow.clearInterval;
  Object.defineProperty(domWindow, "setInterval", {
    configurable: true,
    value: ((handler: () => void) => {
      intervalRegistrations += 1;
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
  });
  Object.defineProperty(domWindow, "clearInterval", {
    configurable: true,
    value: (() => {}) as typeof domWindow.clearInterval,
  });
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

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    assert.equal(requests.length, 2, "a resolution forces an immediate replacement request");
    assert.equal(requests[0]!.signal?.aborted, true);
    await act(async () => {
      requests[1]!.resolve({ requests: [descendantRequest("new")] });
      await requests[1]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "new");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "ready");
    await act(async () => {
      requests[0]!.resolve({ requests: [descendantRequest("stale")] });
      await requests[0]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "new",
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
    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    assert.equal(requests[3]!.signal?.aborted, true);
    await act(async () => {
      requests[4]!.resolve({ requests: [descendantRequest("newer")] });
      await requests[4]!.promise;
    });
    await act(async () => {
      requests[3]!.reject(new Error("late failure"));
      await requests[3]!.promise.catch(() => {});
    });
    assert.equal(container.querySelector("span")?.textContent, "newer",
      "a superseded failure cannot clear a newer successful result");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => {
      requests[5]!.reject(new Error("offline"));
      await requests[5]!.promise.catch(() => {});
    });
    assert.equal(container.querySelector("span")?.textContent, "",
      "a current request failure clears stale request controls");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable",
      "a current request failure is not mistaken for an authoritative empty result");
    const referenceChangesAfterFirstUnavailable = requestReferenceChanges;

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => {
      requests[6]!.resolve({
        requests: [{ ...descendantRequest("old-control-plane"), eventEpoch: undefined as unknown as number }],
      });
      await requests[6]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "",
      "mixed-version rows without exact routing metadata fail closed");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable",
      "an incompatible response is not treated as an authoritative empty result");
    assert.equal(requestReferenceChanges, referenceChangesAfterFirstUnavailable,
      "an equivalent incompatible result retains the unavailable request reference");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => {
      requests[7]!.reject(new Error("still offline"));
      await requests[7]!.promise.catch(() => {});
    });
    assert.equal(requestReferenceChanges, referenceChangesAfterFirstUnavailable,
      "repeated failures retain the unavailable request reference while polling continues");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => render("parent-b", true));
    assert.equal(requests[8]!.signal?.aborted, true, "changing sessions aborts the old request");
    assert.equal(requests.length, 10);
    assert.equal(requests[9]!.sessionId, "parent-b");
    assert.equal(container.querySelector("span")?.textContent, "");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "loading",
      "switching sessions cannot reuse the prior session's authoritative state");
    const enabledRefresh = exposedRefreshAfterResolution;
    await act(async () => render("parent-b", false));
    assert.equal(requests[9]!.signal?.aborted, true, "disabling Parent Control aborts the request");
    assert.equal(container.querySelector("span")?.textContent, "");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "idle");
    await act(async () => enabledRefresh?.());
    assert.equal(requests.length, 10, "a stale resolution callback cannot restart disabled polling");
    await act(async () => render("parent-b", true));
    assert.equal(requests.length, 11);
    await act(async () => {
      requests[10]!.resolve({ requests: [descendantRequest("before-disconnect")] });
      await requests[10]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "before-disconnect");
    const referenceChangesBeforeDisconnect = requestReferenceChanges;
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 12);
    const intervalRegistrationsBeforeDisconnect = intervalRegistrations;
    await act(async () => render("parent-b", true, false));
    assert.equal(requests[11]!.signal?.aborted, true, "disconnecting aborts the active request");
    assert.equal(container.firstElementChild?.getAttribute("data-poll-status"), "unavailable");
    assert.equal(container.querySelector("span")?.textContent, "");
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
    Object.defineProperty(domWindow, "setInterval", { configurable: true, value: originalSetInterval });
    Object.defineProperty(domWindow, "clearInterval", { configurable: true, value: originalClearInterval });
  }
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
  const originalSetInterval = domWindow.setInterval;
  const originalClearInterval = domWindow.clearInterval;
  const originalSetTimeout = domWindow.setTimeout;
  const originalClearTimeout = domWindow.clearTimeout;
  Object.defineProperty(domWindow, "setInterval", {
    configurable: true,
    value: ((handler: () => void) => {
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
  });
  Object.defineProperty(domWindow, "clearInterval", {
    configurable: true,
    value: (() => {}) as typeof domWindow.clearInterval,
  });
  Object.defineProperty(domWindow, "setTimeout", {
    configurable: true,
    value: ((handler: () => void, delay = 0) => {
      assert.equal(timeouts.has(reusedTimeoutId), false, "polls have at most one active deadline");
      timeouts.set(reusedTimeoutId, { handler, delay });
      return reusedTimeoutId as unknown as ReturnType<typeof domWindow.setTimeout>;
    }) as unknown as typeof domWindow.setTimeout,
  });
  Object.defineProperty(domWindow, "clearTimeout", {
    configurable: true,
    value: ((id: number) => {
      timeouts.delete(id);
    }) as unknown as typeof domWindow.clearTimeout,
  });
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
    assert.equal(container.querySelector("span")?.textContent, "current");
    assert.equal(timeouts.size, 0, "successful settlement clears its deadline");

    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 2);
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 2, "intervals still coalesce before the deadline");

    await act(async () => fireActiveTimeout());
    assert.equal(requests[1]!.signal?.aborted, true, "the deadline aborts the hung request");
    assert.equal(container.querySelector("span")?.getAttribute("data-poll-status"), "unavailable");
    assert.equal(container.querySelector("span")?.textContent, "",
      "timed-out request controls fail closed without reporting an authoritative empty result");
    const referenceChangesAfterFirstTimeout = requestReferenceChanges;
    await act(async () => {
      requests[1]!.resolve({ requests: [descendantRequest("late-success")] });
      await requests[1]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "");
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
    assert.equal(container.querySelector("span")?.textContent, "");
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
    assert.equal(container.querySelector("span")?.textContent, "newer");
    await act(async () => intervalHandler?.());
    await act(async () => root.unmount());
    assert.equal(requests[6]!.signal?.aborted, true, "unmounting aborts the active request");
    assert.equal(timeouts.size, 0, "unmounting clears the active deadline");
  } finally {
    if (container.isConnected) await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(domWindow, "setInterval", { configurable: true, value: originalSetInterval });
    Object.defineProperty(domWindow, "clearInterval", { configurable: true, value: originalClearInterval });
    Object.defineProperty(domWindow, "setTimeout", { configurable: true, value: originalSetTimeout });
    Object.defineProperty(domWindow, "clearTimeout", { configurable: true, value: originalClearTimeout });
  }
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
    planActive={false} planSupported={false} onTogglePlan={() => {}} onApply={() => {}}
    onSetParentControl={() => {}} onSetParentControlPolicy={() => {}}
    disabled={false} imageMimeTypes={[]} onAttachImages={() => {}}
  />);
  const row = () => {
    const term = [...container.querySelectorAll("dt")].find((node) => node.textContent === "Integration Isolation");
    assert.ok(term, "the Campaign Behavior panel shows the stored value");
    return term.nextElementSibling!.textContent ?? "";
  };
  const open = async (permissionMode: string, strictProjectIsolation: boolean) => {
    await act(async () => render(permissionMode, strictProjectIsolation));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!;
    if (!container.querySelector('[aria-label="Active Campaign Behavior"]')) {
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

    // An additive legacy session is the opposite: ordinary provider mode, integrations intact.
    await open("acceptEdits", false);
    assert.match(row(), /^Disabled/);
    // A strict legacy session is Enabled through the boundary rather than the preset literal.
    await open("acceptEdits", true);
    assert.match(row(), /^Enabled/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
