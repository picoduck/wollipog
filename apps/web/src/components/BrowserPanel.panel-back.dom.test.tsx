import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView, WorkflowArtifactView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { GitStatus } from "./useGitStatus.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";

/**
 * The Browser's open artifact inside the real side panel (#2855): one back control at every width.
 * On a desktop panel it is the artifact header's Back to Artifacts; on a phone, whose panel header
 * already leads with a Back (#2843), that Back becomes Back to Artifacts and the header draws none.
 */
const domWindow = new Window({ url: "http://localhost/", settings: { disableIframePageLoading: true } });
installDomTestCleanup(domWindow);
let phoneViewport = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() { return query === "(max-width: 760px)" ? phoneViewport : false; },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});
const globals: Record<string, unknown> = {
  window: domWindow, document: domWindow.document, localStorage: domWindow.localStorage,
  navigator: domWindow.navigator, HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  ResizeObserver: domWindow.ResizeObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const session = { id: "session-1", runnerId: "runner-1", driver: "claude-code", status: "idle", adopted: false, eventEpoch: 1 } as SessionView;
const body = "ok 1 - the panel has one back control\n";
const log: WorkflowArtifactView = {
  artifactId: "log-1", sessionId: session.id, kind: "test_log", name: "web unit suite.log", mimeType: "text/plain",
  encoding: "utf8", sizeBytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
  createdBy: { kind: "system" }, createdAt: Date.now() - 60_000,
};
const client = {
  ...api,
  childSessions: () => Promise.reject(new ApiError("This fixture has no durable child-session registry.", 404)),
  sessionWorkflowArtifacts: async () => ({ artifacts: [log] }),
  artifactExport: async () => new Blob([body], { type: "text/plain" }),
} as ApiClient;
const connection: UiConnectionRuntime = {
  instanceId: "browser-panel-back", runtimeKey: "browser-panel-back",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};
const git: GitStatus = {
  status: null, observation: 0, observedAt: null, settled: false, busy: false, error: null, errorCode: null,
  refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
};

function Harness({ onState }: { onState: (state: RightPanelState) => void }) {
  const state = useRightPanelState();
  onState(state);
  return (
    <ApiProvider client={client}>
      <StoreProvider connection={connection}>
        <RightPanel
          state={state}
          session={session}
          runnerOnline
          runnerProtocolVersion={null}
          git={git}
          items={[]}
          decisionHistory={[]}
          decisionHistoryHasMore={false}
          onLoadOlderDecisions={() => {}}
          onOpenSourceLocation={() => {}}
          onClearSourceLocation={() => {}}
          onOpenTerminal={() => {}}
          onInsertSideChatDraft={() => {}}
        />
      </StoreProvider>
    </ApiProvider>
  );
}

async function settle(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

/** Every control in the panel whose name starts with Back. Names only: never compare nodes in an
 * assertion, whose failure would inspect two happy-dom graphs. */
const backs = (panel: Element) => [...panel.querySelectorAll("button")]
  .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "")
  .filter((name) => /^Back/u.test(name));

async function openPanel(phone: boolean) {
  phoneViewport = phone;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let state!: RightPanelState;
  await act(async () => root.render(<Harness onState={(next) => { state = next; }} />));
  await act(async () => state.show("browser"));
  const panel = container.querySelector("#right-panel")!;
  await settle(() => !!panel.querySelector(".browser-artifact-list .row"), "the artifact list");
  return {
    panel,
    get state() { return state; },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      phoneViewport = false;
    },
  };
}

async function openArtifact(panel: Element) {
  await act(async () => panel.querySelector<HTMLButtonElement>(".browser-artifact-list .row")!.click());
  await settle(() => panel.querySelector(".artifact-preview")?.getAttribute("aria-busy") === "false", "the preview");
}

describe("one back control in the panel for an open artifact (#2855)", () => {
  test("on a desktop panel it is the artifact header's Back to Artifacts; the panel header has none", async () => {
    const view = await openPanel(false);
    try {
      assert.deepEqual(backs(view.panel), [], "the list has no back control");
      await openArtifact(view.panel);
      assert.deepEqual(backs(view.panel), ["Back to Artifacts"]);
      assert.deepEqual(backs(view.panel.querySelector(".rpanel-head")!), [], "the panel header has Close, not Back");
      assert.ok(view.panel.querySelector('.art-bar button[aria-label="Back to Artifacts"]'));
    } finally {
      await view.dispose();
    }
  });

  test("on a phone the panel's Back becomes Back to Artifacts, then Back to Session again on the list", async () => {
    const view = await openPanel(true);
    try {
      (domWindow.document.activeElement as unknown as HTMLElement | null)?.blur();
      const head = view.panel.querySelector(".rpanel-head")!;
      assert.deepEqual(backs(view.panel), ["Back to Session"], "the list keeps #2843's Back");
      await openArtifact(view.panel);
      assert.deepEqual(backs(view.panel), ["Back to Artifacts"], "exactly one back control while an artifact is open");
      const back = head.querySelector<HTMLButtonElement>('button[aria-label="Back to Artifacts"]')!;
      assert.equal(back.getAttribute("title"), "Back to Artifacts");
      assert.equal(view.panel.querySelector(".art-bar")?.querySelectorAll("button[aria-label^='Back']").length, 0,
        "the artifact header draws no back of its own");
      assert.ok(Object.is(domWindow.document.activeElement, back), "the panel's Back takes focus as the row goes away");

      await act(async () => back.click());
      assert.equal(view.state.open, true, "Back to Artifacts keeps the panel open");
      const row = view.panel.querySelector<HTMLButtonElement>(".browser-artifact-list .row");
      assert.ok(row, "the list is back");
      assert.ok(Object.is(domWindow.document.activeElement, row), "focus is on the artifact's row");
      assert.deepEqual(backs(view.panel), ["Back to Session"], "the panel's Back is #2843's again");

      await act(async () => head.querySelector<HTMLButtonElement>('button[aria-label="Back to Session"]')!.click());
      assert.equal(view.state.open, false, "Back to Session still closes the panel");
    } finally {
      await view.dispose();
    }
  });
});
