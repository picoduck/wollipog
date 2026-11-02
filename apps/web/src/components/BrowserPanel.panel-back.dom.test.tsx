import { fireDomEvent } from "./test-dom-events.js";
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
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { GitStatus } from "./useGitStatus.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";

/**
 * The Browser's open artifact inside the real side panel: a page on the panel's stack (#2914, #2856),
 * so its one back control at every width is the panel header's Back to Browser, beside the page's
 * title. Escape pops it as Back does, and focus returns to the artifact's row. Like every tool's
 * page it clears on a tool switch, while the tab and the address stay in panel scratch (#1202).
 */
const domWindow = new Window({ url: "http://localhost/" });
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
  ResizeObserver: domWindow.ResizeObserver, InputEvent: domWindow.InputEvent, KeyboardEvent: domWindow.KeyboardEvent,
  HTMLInputElement: domWindow.HTMLInputElement, React, IS_REACT_ACT_ENVIRONMENT: true,
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

/** Only what shows: the list waits mounted under a page, hidden. */
const shown = (element: Element | null) => !!element && !element.closest("[hidden]");
const row = (panel: Element) => panel.querySelector<HTMLButtonElement>(".browser-artifact-list .row")!;
const pageTitle = (panel: Element) => panel.querySelector<HTMLElement>(".rpanel-head .rpanel-page-title")!;
const focused = (element: Element | null) => Object.is(domWindow.document.activeElement, element);

async function pressEscape() {
  const target = domWindow.document.activeElement ?? domWindow.document.body;
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

describe("an open artifact is a page with the panel header's Back as its one back control (#2914)", () => {
  for (const phone of [false, true]) {
    test(`on a ${phone ? "phone" : "desktop panel"}, Back to Browser and the title lead the header, and the bar has neither`, async () => {
      const view = await openPanel(phone);
      try {
        const head = view.panel.querySelector(".rpanel-head")!;
        assert.deepEqual(backs(view.panel), phone ? ["Back to Session"] : [], "the list keeps the panel's own Back");
        await openArtifact(view.panel);
        assert.deepEqual(backs(view.panel), ["Back to Browser"], "exactly one back control while an artifact is open");
        assert.deepEqual(backs(head), ["Back to Browser"], "and it is the panel header's");
        assert.equal(head.querySelector('button[aria-label="Back to Browser"]')?.getAttribute("title"), "Back to Browser");
        assert.equal(pageTitle(view.panel).hidden, false);
        assert.equal(pageTitle(view.panel).textContent, log.name, "the page's title is in the header");
        assert.ok(focused(pageTitle(view.panel)), "the title takes focus as the page opens");
        assertNoDomNode(head.querySelector(".rpanel-switcher"), "the title takes the switcher's place");
        const bar = view.panel.querySelector(".rpanel-toolbar > .art-bar")!;
        assert.deepEqual([...bar.querySelectorAll(":scope > button")].map((button) => button.textContent?.trim()), ["Download"],
          "the bar keeps Download (and Enlarge, for media) and draws no back");
        assert.equal([...view.panel.querySelectorAll(".rpanel-body *")].filter((node) => shown(node) && node.textContent === log.name).length, 0,
          "the title is shown once");
        assertNoDomNode(view.panel.querySelector('[role="tablist"][aria-label="Browser"]'), "the tabs give way to the page");
        assert.ok(row(view.panel), "the list stays mounted under the page");
        assert.equal(shown(row(view.panel)), false, "hidden");
      } finally {
        await view.dispose();
      }
    });

    test(`on a ${phone ? "phone" : "desktop panel"}, Back and Escape each return to the list with focus on the artifact's row`, async () => {
      const view = await openPanel(phone);
      try {
        assert.equal(row(view.panel).dataset.panelPageKey, log.artifactId, "the row carries its page's key");
        for (const close of ["Back", "Escape"] as const) {
          await act(async () => row(view.panel).focus());
          await openArtifact(view.panel);
          if (close === "Back") {
            await act(async () => view.panel.querySelector<HTMLButtonElement>('.rpanel-head button[aria-label="Back to Browser"]')!.click());
          } else {
            await pressEscape();
          }
          assert.equal(view.state.open, true, `${close} keeps the panel open`);
          assert.ok(shown(row(view.panel)), `${close} shows the list again`);
          assert.ok(focused(row(view.panel)), `${close} returns focus to the artifact's row`);
          assert.equal(pageTitle(view.panel).hidden, true);
          assert.deepEqual(backs(view.panel), phone ? ["Back to Session"] : [], `after ${close} the panel's Back is its own again`);
        }
        if (phone) {
          await act(async () => view.panel.querySelector<HTMLButtonElement>('.rpanel-head button[aria-label="Back to Session"]')!.click());
          assert.equal(view.state.open, false, "Back to Session still closes the panel");
        }
      } finally {
        await view.dispose();
      }
    });
  }

  test("switching tools and back reopens the Browser on its list, with the tab and the address kept", async () => {
    const view = await openPanel(false);
    try {
      const tab = (name: string) => [...view.panel.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Browser"] [role="tab"]')]
        .find((candidate) => candidate.textContent?.startsWith(name))!;
      await act(async () => tab("Web Preview").click());
      const address = view.panel.querySelector<HTMLInputElement>("#browser-url")!;
      await act(async () => fireDomEvent.change(address, { target: { value: "http://preview.test/dashboard" } }));
      await act(async () => fireDomEvent.submit(view.panel.querySelector(".browser-address")!));
      assert.equal(view.panel.querySelector(".browser-web-frame")?.getAttribute("src"), "http://preview.test/dashboard");
      await act(async () => tab("Artifacts").click());
      await openArtifact(view.panel);

      await act(async () => view.state.show("decisions"));
      await act(async () => view.state.show("browser"));
      await settle(() => !!view.panel.querySelector(".browser-artifact-list .row"), "the artifact list");
      assert.equal(pageTitle(view.panel).hidden, true, "no page is pushed");
      assert.deepEqual(backs(view.panel), []);
      assert.ok(shown(row(view.panel)), "the Browser shows its list");
      assertNoDomNode(view.panel.querySelector(".art-bar"), "and no preview");
      assert.equal(tab("Artifacts").getAttribute("aria-selected"), "true", "the tab is kept");
      await act(async () => tab("Web Preview").click());
      assert.equal(view.panel.querySelector<HTMLInputElement>("#browser-url")!.value, "http://preview.test/dashboard", "the address is kept");
      assert.equal(view.panel.querySelector(".browser-web-frame")?.getAttribute("src"), "http://preview.test/dashboard", "the open page is kept");

      await act(async () => tab("Artifacts").click());
      await openArtifact(view.panel);
      await act(async () => view.state.close());
      await act(async () => view.state.show("browser"));
      await settle(() => !!domWindow.document.querySelector("#right-panel .browser-artifact-list .row"), "the reopened list");
      const reopened = domWindow.document.querySelector("#right-panel") as unknown as Element;
      assert.equal(pageTitle(reopened).hidden, true, "closing the panel clears the page too");
      assert.ok(shown(row(reopened)));
    } finally {
      await view.dispose();
    }
  });
});

describe("About Browser is the header's, and the Artifacts tab's notice is one compact line (#3039)", () => {
  const about = (panel: Element) => panel.querySelector<HTMLButtonElement>('.rpanel-head .rpanel-actions button[aria-label="About Browser"]');
  const note = (panel: Element) => panel.querySelector<HTMLElement>('[role="note"][aria-label="Private Artifact Uploads"]');
  const headNames = (panel: Element) => [...panel.querySelectorAll(".rpanel-head button")].map((button) => button.getAttribute("aria-label") ?? "");
  const tab = (panel: Element, name: string) => [...panel.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Browser"] [role="tab"]')]
    .find((candidate) => candidate.textContent?.startsWith(name))!;
  const popover = () => domWindow.document.querySelector('[role="dialog"][aria-label="About Browser"]') as unknown as HTMLElement | null;

  test("About Browser sits in the action slot before Expand Panel, on both tabs and while an artifact's page is pushed", async () => {
    const view = await openPanel(false);
    try {
      const names = headNames(view.panel);
      assert.ok(names.includes("About Browser") && names.indexOf("About Browser") < names.indexOf("Expand Panel"), names.join(", "));
      assert.equal(about(view.panel)?.getAttribute("title"), "About Browser");
      assert.equal(about(view.panel)?.getAttribute("aria-haspopup"), "dialog");
      await act(async () => tab(view.panel, "Web Preview").click());
      assert.ok(about(view.panel), "on Web Preview");
      await act(async () => tab(view.panel, "Artifacts").click());
      await openArtifact(view.panel);
      assert.ok(about(view.panel), "while an artifact's page is pushed");
      assert.equal(view.panel.querySelectorAll('button[aria-label="About Browser"]').length, 1, "once");
    } finally {
      await view.dispose();
    }
  });

  test("its popover holds the full explanation, which the notice never repeats, and stays once the notice is dismissed", async () => {
    const view = await openPanel(false);
    try {
      const notice = note(view.panel)!;
      assert.ok(notice, "the notice shows until it is dismissed");
      assert.ok(notice.closest("#browser-artifacts-panel"), "on the Artifacts tab");
      assert.equal(notice.querySelector(".notice-body")?.textContent?.trim(), "Artifacts can be stored privately.");
      await act(async () => about(view.panel)!.click());
      assert.ok(popover(), "About Browser opens its popover");
      const text = popover()!.textContent ?? "";
      for (const fact of ["privately on this control plane", "view them remotely", "Uploads are manual by default",
        "Settings › Behavior", "Dismissing the notice in Artifacts doesn't change it"]) {
        assert.ok(text.includes(fact), `the popover says: ${fact}`);
      }
      const noticeText = notice.textContent ?? "";
      for (const sentence of text.split(/(?<=\.)\s+/u).map((part) => part.trim()).filter(Boolean)) {
        assert.ok(!noticeText.includes(sentence), `the notice doesn't repeat: ${sentence}`);
      }
      await pressEscape();
      assertNoDomNode(popover(), "Escape closes it");
      assert.equal(view.state.open, true, "and only it");

      await act(async () => notice.querySelector<HTMLButtonElement>('button[aria-label="Dismiss Artifact Upload Notice"]')!.click());
      assertNoDomNode(note(view.panel), "Dismiss hides the notice");
      await act(async () => about(view.panel)!.click());
      assert.ok(popover(), "About Browser stays after dismissal");
    } finally {
      await view.dispose();
    }
  });
});
