import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DescendantBlockedChildView, DescendantRequestsView, SessionHoldView } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewPath } from "../navigation.js";
import { CampaignHeldChildren, type CampaignHeldChild } from "./CampaignHeldChildren.js";
import { useDescendantRequestPolling } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
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

function worktreeHold(overrides: Partial<SessionHoldView> = {}): SessionHoldView {
  return {
    kind: "worktree_recovery",
    holdId: "recovery-1",
    since: Date.now() - 120_000,
    reason: "The selected worktree is on branch main, not feat/example.",
    recoveryAction: "Restore branch feat/example in /work/tree (for example `git -C /work/tree switch feat/example`) " +
      "and select that worktree again with select_worktree, or select or create another worktree for this session " +
      "with select_worktree or create_worktree.",
    heldResumes: [{ kind: "workflow_decision_resolution", occurrenceId: "wd_occ_42", since: Date.now() - 60_000 }],
    ...overrides,
  };
}

async function mount(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    render: (next: React.ReactElement) => act(async () => root.render(next)),
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("held children list each child's link, hold reason, recovery action, and held resumes without request controls", async () => {
  const opened: string[] = [];
  const held: CampaignHeldChild[] = [{ sessionId: "child/one", holds: [worktreeHold()] }];
  const titles: Record<string, string> = { "child/one": "Fix #12: Worktree Branch" };
  const list = (children: readonly CampaignHeldChild[], blocked: number) => (
    <CampaignHeldChildren
      heldChildren={children}
      blocked={blocked}
      childTitle={(id) => titles[id]}
      onOpenChild={(id) => opened.push(id)}
    />
  );
  const view = await mount(list(held, 1));
  try {
    const section = view.container.querySelector<HTMLElement>("section.campaign-held-children");
    assert.ok(section);
    const headingId = section.getAttribute("aria-labelledby");
    assert.equal(view.container.querySelector(`[id="${headingId}"]`)?.textContent, "Held Children",
      "the section's accessible name matches its visible Title Case label");
    const link = section.querySelector<HTMLAnchorElement>("a.campaign-held-child-link");
    assert.equal(link?.textContent, "Fix #12: Worktree Branch");
    assert.equal(link?.getAttribute("href"), viewPath({ name: "session", id: "child/one" }));
    const terms = [...section.querySelectorAll("dt")].map((node) => node.textContent);
    assert.deepEqual(terms, ["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    const text = section.textContent ?? "";
    assert.match(text, /Worktree Recovery/);
    assert.match(text, /The selected worktree is on branch main, not feat\/example\./);
    assert.equal(section.querySelector("dd code")?.textContent, "git -C /work/tree switch feat/example",
      "the quoted recovery command is rendered as code");
    assert.match(text, /wd_occ_42/);
    assert.match(text, /A hold has nothing to answer\./);
    assert.doesNotMatch(text, /not listed here/, "the summary omits unlisted blocked children when every one is held");
    assert.equal(section.querySelectorAll("button, input, select, textarea").length, 0,
      "a hold offers no answer or approve control");
    assert.equal(view.container.querySelector('[aria-label="Pending Requests"]'), null);

    await act(async () => fireDomEvent.click(link!, { ctrlKey: true }));
    assert.deepEqual(opened, [], "a modified click is left to the browser so the child can open in a new tab");
    await act(async () => fireDomEvent.click(link!, { button: 0 }));
    assert.deepEqual(opened, ["child/one"]);

    // Blocked also counts failed and stopped children, and held ones past the projection's limit;
    // the list says so rather than disagreeing.
    await view.render(list(held, 3));
    assert.match(view.container.textContent ?? "",
      /2 other blocked children are not listed here, such as failed or stopped children\./);
    await view.render(list(held, 2));
    assert.match(view.container.textContent ?? "", /1 other blocked child is not listed here/);

    // The projection drops the child once its hold clears, and the entry goes with it.
    await view.render(list([], 0));
    assert.equal(view.container.querySelector("section.campaign-held-children"), null);
  } finally {
    await view.dispose();
  }
});

test("held children render an unfamiliar hold kind generically and fall back to the session id", async () => {
  const view = await mount(
    <CampaignHeldChildren
      heldChildren={[
        { sessionId: "child-a", holds: [worktreeHold()] },
        {
          sessionId: "child-b",
          holds: [{
            // A kind this client predates (for example a runner-side hold from #1651).
            kind: "handoff_barrier" as SessionHoldView["kind"],
            holdId: "barrier-1",
            since: Date.now() - 5_000,
            reason: "A prompt is queued behind a handoff barrier.",
            recoveryAction: "Finish the handoff with `wollipog session prompt`.",
          }],
        },
      ]}
      blocked={2}
      childTitle={(id) => (id === "child-a" ? "Child A" : undefined)}
      onOpenChild={() => undefined}
    />,
  );
  try {
    const entries = [...view.container.querySelectorAll("li.campaign-held-child")];
    assert.equal(entries.length, 2);
    assert.equal(view.container.querySelector(".campaign-held-children-count")?.textContent, "2");
    const second = entries[1]!;
    assert.equal(second.querySelector("a")?.textContent, "child-b");
    assert.equal(second.querySelector("dl")?.getAttribute("data-hold-kind"), "handoff_barrier");
    assert.match(second.textContent ?? "", /Handoff Barrier/);
    assert.match(second.textContent ?? "", /A prompt is queued behind a handoff barrier\./);
    assert.equal(second.querySelector("dd code")?.textContent, "wollipog session prompt");
    assert.doesNotMatch(second.textContent ?? "", /Held Decision Resumes/,
      "a hold without held resumes does not render an empty resume list");
  } finally {
    await view.dispose();
  }
});

test("descendant polling reports held descendants apart from requests and tolerates servers that omit them", async () => {
  const blocked: DescendantBlockedChildView = {
    sessionId: "child-a",
    sessionTitle: "Child A",
    runnerId: "runner-1",
    runnerOnline: true,
    eventEpoch: 0,
    status: "input_required",
    holds: [worktreeHold()],
  };
  const responses: DescendantRequestsView[] = [{ requests: [], blockedChildren: [blocked] }, { requests: [] }];
  const client = {
    ...api,
    descendantRequests: async () => responses.shift() ?? { requests: [] },
  } as ApiClient;
  const originalSetInterval = domWindow.setInterval;
  let intervalHandler: (() => void) | undefined;
  Object.defineProperty(domWindow, "setInterval", {
    configurable: true,
    value: ((handler: () => void) => {
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
  });
  function Harness() {
    const polling = useDescendantRequestPolling({ sessionId: "parent", enabled: true, available: true });
    return <div data-status={polling.status} data-requests={polling.requests.length}>
      {polling.blockedChildren.map((child) => child.sessionTitle).join(",")}
    </div>;
  }
  const view = await mount(<ApiProvider client={client}><Harness /></ApiProvider>);
  try {
    await act(async () => { await Promise.resolve(); });
    const node = view.container.firstElementChild!;
    assert.equal(node.getAttribute("data-status"), "ready");
    assert.equal(node.getAttribute("data-requests"), "0", "a held descendant is never a request");
    assert.equal(node.textContent, "Child A");
    await act(async () => { intervalHandler?.(); await Promise.resolve(); });
    assert.equal(view.container.firstElementChild?.textContent, "",
      "an older control plane without blockedChildren clears the held descendants");
  } finally {
    await view.dispose();
    Object.defineProperty(domWindow, "setInterval", { configurable: true, value: originalSetInterval });
  }
});
