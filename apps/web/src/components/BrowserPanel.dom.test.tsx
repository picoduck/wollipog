import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView, WorkflowArtifactKind, WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { BrowserPanel, PAGE_BLOCKED_AFTER_MS } from "./BrowserPanel.js";
import { labelFor } from "../artifact-kind.js";
import { clearPanelScratch } from "../right-panel-scratch.js";

/**
 * Panel scratch survives unmount on purpose (#1202), and these cases share one session id — so
 * without this each test would start holding whatever the previous one typed or chose.
 */
beforeEach(() => clearPanelScratch());

// Frames are never loaded here: each test fires `load` itself, when the page it describes would.
const domWindow = new Window({ url: "http://localhost/", settings: { disableIframePageLoading: true } });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function artifact(id: string, text: string, kind: WorkflowArtifactKind = "test_log", sizeBytes = Buffer.byteLength(text)): WorkflowArtifactView {
  return {
    artifactId: id,
    sessionId: "session_1",
    kind,
    name: `${id}.log`,
    mimeType: "text/plain",
    encoding: "utf8",
    sizeBytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    createdBy: { kind: "system" },
    createdAt: 1,
  };
}

async function waitForPreviewToSettle(container: HTMLDivElement): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (container.querySelector(".artifact-preview")?.getAttribute("aria-busy") !== "false") {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for artifact preview: ${container.innerHTML}`);
    await act(async () => {
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
  }
}

/** Mount the panel over a stubbed artifact list, and restore the API and the DOM afterwards. */
async function withPanel(
  list: (cursor?: string) => Promise<WorkflowArtifactPage>,
  run: (container: HTMLDivElement) => Promise<void>,
): Promise<void> {
  const priorList = api.sessionWorkflowArtifacts;
  api.sessionWorkflowArtifacts = async (_sessionId: string, cursor?: string) => list(cursor);
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<BrowserPanel session={{ id: "session_1" } as SessionView} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    api.sessionWorkflowArtifacts = priorList;
    container.remove();
  }
}

const buttonNamed = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll<HTMLElement>("button, a"))
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;
const tab = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]'))
    .find((candidate) => candidate.textContent?.startsWith(name))!;

async function openWebPreview(container: HTMLDivElement): Promise<void> {
  await act(async () => { tab(container, "Web Preview").click(); });
}

async function submitAddress(container: HTMLDivElement, value: string): Promise<void> {
  const input = container.querySelector("#browser-url") as HTMLInputElement;
  await act(async () => fireDomEvent.change(input, { target: { value } }));
  await act(async () => fireDomEvent.submit(container.querySelector(".browser-address") as HTMLFormElement));
}

async function fireFrameLoad(container: HTMLDivElement): Promise<void> {
  const frame = container.querySelector(".browser-web-frame") as HTMLIFrameElement;
  await act(async () => { frame.dispatchEvent(new domWindow.Event("load") as unknown as Event); });
}

test("browser panel paginates metadata and fetches exact bodies only after selection", async () => {
  const first = artifact("first", "first body");
  const second = artifact("second", "second body");
  const priorExport = api.artifactExport;
  const listed: Array<string | undefined> = [];
  const exported: string[] = [];
  api.artifactExport = async (id: string) => {
    exported.push(id);
    await new Promise((resolve) => setTimeout(resolve, 75));
    return new Blob([id === "first" ? "first body" : "second body"], { type: "text/plain" });
  };
  try {
    await withPanel(async (cursor) => {
      listed.push(cursor);
      return cursor ? { artifacts: [second] } : { artifacts: [first], nextCursor: "page-2" };
    }, async (container) => {
      assert.deepEqual(exported, [], "metadata listing never materializes artifact bodies");
      assert.equal(container.querySelectorAll(".browser-artifact-list .row").length, 1);
      assert.equal(tab(container, "Artifacts").querySelector(".count")?.textContent, "1+", "more pages wait behind Show More");

      const showMore = container.querySelector(".list-foot button") as HTMLButtonElement;
      assert.equal(showMore.textContent?.trim(), "Show More");
      await act(async () => {
        showMore.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(listed, [undefined, "page-2"]);
      assert.equal(container.querySelectorAll(".browser-artifact-list .row").length, 2);
      assertNoDomNode(container.querySelector(".list-foot"), "the last page has no Show More");
      assert.equal(tab(container, "Artifacts").querySelector(".count")?.textContent, "2");

      await act(async () => { (container.querySelector(".browser-artifact-list .row") as HTMLButtonElement).click(); });
      await waitForPreviewToSettle(container);
      assert.deepEqual(exported, ["first"]);
      assert.equal(container.querySelector("pre")?.textContent, "first body", container.innerHTML);
    });
  } finally {
    api.artifactExport = priorExport;
  }
});

test("Artifacts and Web Preview are tabs, and nothing reads Web URL", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    const tablist = container.querySelector('[role="tablist"]')!;
    assert.equal(tablist.getAttribute("aria-label"), "Browser");
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    assert.deepEqual(tabs.map((candidate) => candidate.firstChild?.textContent), ["Artifacts", "Web Preview"]);
    assert.equal(tab(container, "Artifacts").getAttribute("aria-selected"), "true");
    assertNoDomNode(container.querySelector('[role="radio"], [role="radiogroup"]'), "no segmented control");

    await act(async () => {
      tab(container, "Artifacts").focus();
      fireDomEvent.keyDown(tab(container, "Artifacts"), { key: "ArrowRight" });
    });
    assert.equal(tab(container, "Web Preview").getAttribute("aria-selected"), "true", "arrows move between the tabs");
    const panel = container.querySelector('[role="tabpanel"]')!;
    assert.equal(panel.getAttribute("aria-labelledby"), "browser-web-tab");
    assert.doesNotMatch(container.textContent ?? "", /Web URL/);
    assert.doesNotMatch(container.innerHTML, /Web URL/);
  });
});

test("artifact rows name their kind with acronyms intact and keep the size on one line", async () => {
  const html = artifact("report", "<p>hi</p>", "html_preview", 1_741);
  const verdict = artifact("verdict", "{}", "verdict");
  await withPanel(async () => ({ artifacts: [html, verdict] }), async (container) => {
    const rows = Array.from(container.querySelectorAll(".browser-artifact-list .row"));
    assert.ok(rows.every((row) => row.classList.contains("row") && row.classList.contains("row-2")), "two-line rows (§5.2)");
    assert.ok(rows.every((row) => row.querySelector(".art-kind svg")), "each row leads with its kind's icon");
    const meta = rows.map((row) => row.querySelector(".art-row-meta > span")?.textContent);
    assert.deepEqual(meta, ["HTML preview", "Verdict (JSON)"]);
    assert.ok(rows[0]!.querySelector(".art-row-meta > time"), "the time follows the kind");
    assert.equal(rows[0]!.querySelector(".art-size")?.textContent, "1.7 KB");
    assert.doesNotMatch(container.textContent ?? "", /Html Preview/);
    assertNoDomNode(container.querySelector(".browser-artifacts > p"), "the intro paragraph is gone");
  });
});

test("labelFor names every kind for a person", () => {
  assert.equal(labelFor("html_preview"), "HTML preview");
  assert.equal(labelFor("verdict"), "Verdict (JSON)");
  assert.equal(labelFor("test_log"), "Test log");
  assert.equal(labelFor("review_report"), "Review report");
  assert.equal(labelFor("future_kind" as WorkflowArtifactKind), "Future kind");
});

test("the artifact list shows three skeleton rows while it loads", async () => {
  let release: (page: WorkflowArtifactPage) => void = () => undefined;
  await withPanel(() => new Promise((resolve) => { release = resolve; }), async (container) => {
    const skeleton = container.querySelector(".browser-artifacts .skeleton")!;
    assert.ok(skeleton, container.innerHTML);
    assert.equal(skeleton.querySelectorAll(".skeleton-row").length, 3);
    assert.equal(skeleton.getAttribute("role"), "status");
    assertNoDomNode(tab(container, "Artifacts").querySelector(".count"), "no count until the list loads");
    await act(async () => { release({ artifacts: [] }); });
    assertNoDomNode(container.querySelector(".browser-artifacts .skeleton"));
  });
});

test("an empty list says what will appear and offers Web Preview", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    const state = container.querySelector(".browser-artifacts .state")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "No Artifacts Yet");
    assert.equal(state.querySelector(".state-body")?.textContent, "Reports, screenshots and logs the agent saves appear here.");
    assert.equal(tab(container, "Artifacts").querySelector(".count")?.textContent, "0");
    await act(async () => { (buttonNamed(state as HTMLElement, "Open Web Preview") as HTMLButtonElement).click(); });
    assert.equal(tab(container, "Web Preview").getAttribute("aria-selected"), "true");
  });
});

test("a failed list load is a danger notice with Retry and the raw error behind Show Details", async () => {
  let calls = 0;
  await withPanel(async () => {
    calls += 1;
    if (calls === 1) throw new Error("HTTP 503: artifact store unavailable");
    return { artifacts: [artifact("after-retry", "ok")] };
  }, async (container) => {
    const notice = container.querySelector(".browser-artifacts .state-error")!;
    assert.ok(notice, container.innerHTML);
    assert.match(notice.className, /danger/);
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.textContent ?? "", /Couldn't Load Artifacts/);
    assert.doesNotMatch(notice.textContent ?? "", /artifact store unavailable/, "the raw error waits behind Show Details");

    await act(async () => { (buttonNamed(notice as HTMLElement, "Show Details") as HTMLButtonElement).click(); });
    assert.match(notice.textContent ?? "", /HTTP 503: artifact store unavailable/);

    await act(async () => {
      (buttonNamed(notice as HTMLElement, "Retry") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(calls, 2);
    assert.equal(container.querySelectorAll(".browser-artifact-list .row").length, 1);
    assertNoDomNode(container.querySelector(".browser-artifacts .state-error"));
  });
});

test("Web Preview starts with its one security sentence and no hint or notice", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    await openWebPreview(container);
    const state = container.querySelector(".browser-web .state")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "Preview a Web Page");
    assert.equal(state.querySelector(".state-body")?.textContent,
      "Pages open in an isolated frame with no access to your session, device token or cookies.");
    assertNoDomNode(container.querySelector(".hint, .browser-security-note, .notice"));
    const form = container.querySelector(".browser-address") as HTMLFormElement;
    assert.ok(form.noValidate, "no native validation bubbles (§8.5)");
    assert.ok(form.classList.contains("toolbar"));
    assert.ok(form.parentElement?.classList.contains("rpanel-toolbar"), "the row is the panel's toolbar slot (§4.9)");
    assert.ok(container.querySelector(".rpanel-scroll > #browser-web-panel"), "the page or its state is in the one scroller");
    assert.equal(buttonNamed(form, "Open")?.getAttribute("type"), "submit");
    assertNoDomNode(buttonNamed(form, "Reload"), "nothing to reload yet");
  });
});

test("an address without a scheme is a field error under the row, not a notice", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    await openWebPreview(container);
    await submitAddress(container, "localhost:3000");
    const input = container.querySelector("#browser-url") as HTMLInputElement;
    const error = container.querySelector(".field-error")!;
    assert.ok(error, container.innerHTML);
    assert.equal(error.id, "browser-url-error");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), "browser-url-error");
    assertNoDomNode(container.querySelector(".notice"), "no notice stack");
    assertNoDomNode(container.querySelector(".browser-web-frame"));

    await act(async () => fireDomEvent.change(input, { target: { value: "http://localhost:3000" } }));
    assertNoDomNode(container.querySelector(".field-error"), "the error clears once the value would be accepted");
    assert.equal(input.getAttribute("aria-invalid"), null);
  });
});

test("a valid address shows the load bar until load, then Reload and Open in New Tab", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    await openWebPreview(container);
    await submitAddress(container, "http://localhost:3000/dashboard");

    const frame = container.querySelector(".browser-web-frame") as HTMLIFrameElement;
    assert.equal(frame.getAttribute("src"), "http://localhost:3000/dashboard");
    assert.equal(frame.getAttribute("sandbox"), "allow-forms allow-scripts", "the sandbox is unchanged");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.ok(container.querySelector(".browser-load-bar[role=progressbar]"), "loading");
    assert.ok(buttonNamed(container, "Open"), "Open stays until the page loads");
    assertNoDomNode(container.querySelector(".browser-web .state"), "the empty state is gone once a page is open");

    await fireFrameLoad(container);
    assertNoDomNode(container.querySelector(".browser-load-bar"));
    assertNoDomNode(buttonNamed(container, "Open"));
    const form = container.querySelector(".browser-address") as HTMLFormElement;
    const reload = buttonNamed(form, "Reload") as HTMLButtonElement;
    assert.ok(reload.classList.contains("icon-btn") && reload.classList.contains("sm"));
    const external = buttonNamed(form, "Open in New Tab") as HTMLAnchorElement;
    assert.ok(external.classList.contains("icon-btn") && external.classList.contains("sm"));
    assert.equal(external.getAttribute("href"), "http://localhost:3000/dashboard");
    assert.equal(external.getAttribute("target"), "_blank");
    assert.equal(external.getAttribute("rel"), "noopener noreferrer");
    // Reload, then the field: the order the row reads in.
    assert.ok(reload.compareDocumentPosition(form.querySelector("#browser-url")!) & 4);

    await act(async () => { reload.click(); });
    const reloaded = container.querySelector(".browser-web-frame") as HTMLIFrameElement;
    assert.notEqual(reloaded, frame, "Reload sets the same URL on a fresh frame");
    assert.equal(reloaded.getAttribute("src"), "http://localhost:3000/dashboard");
    assert.ok(container.querySelector(".browser-load-bar"), "and it loads again");
  });
});

test("returning to a page that loaded before starts a fresh load and can still be blocked", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    await openWebPreview(container);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await submitAddress(container, "http://localhost:3000/a");
      await fireFrameLoad(container);
      assert.ok(buttonNamed(container, "Reload"), "page A loaded");
      await submitAddress(container, "http://localhost:3000/b");
      assert.ok(container.querySelector(".browser-load-bar"), "page B is loading");

      await submitAddress(container, "http://localhost:3000/a");
      assert.ok(container.querySelector(".browser-load-bar"), "A's fresh frame loads again rather than reusing its old load");
      assertNoDomNode(buttonNamed(container, "Reload"));
      await act(async () => { mock.timers.tick(PAGE_BLOCKED_AFTER_MS); });
      assert.ok(container.querySelector(".browser-web-view .notice"), "and it can still be blocked");
    } finally {
      mock.timers.reset();
    }
  });
});

test("a page that never fires load within 8 seconds shows Page Blocked with Open in New Tab", async () => {
  await withPanel(async () => ({ artifacts: [] }), async (container) => {
    await openWebPreview(container);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await submitAddress(container, "https://example.com/refuses-framing");
      await act(async () => { mock.timers.tick(PAGE_BLOCKED_AFTER_MS - 1); });
      assertNoDomNode(container.querySelector(".notice"), "still loading just before the deadline");
      assert.ok(container.querySelector(".browser-load-bar"));

      await act(async () => { mock.timers.tick(1); });
      const notice = container.querySelector(".browser-web-view .notice")!;
      assert.ok(notice, container.innerHTML);
      assert.match(notice.className, /warning/);
      assert.equal(notice.textContent?.includes("This page can't be shown inside Wollipog."), true);
      const external = buttonNamed(notice as HTMLElement, "Open in New Tab") as HTMLAnchorElement;
      assert.equal(external.getAttribute("href"), "https://example.com/refuses-framing");
      assert.equal(external.getAttribute("rel"), "noopener noreferrer");
      assertNoDomNode(container.querySelector(".browser-load-bar"));
      assert.ok((container.querySelector(".browser-web-frame") as HTMLIFrameElement).hidden, "no blank white rectangle");

      // A page that does load after all replaces the notice.
      await fireFrameLoad(container);
      assertNoDomNode(container.querySelector(".browser-web-view .notice"));
      assert.equal((container.querySelector(".browser-web-frame") as HTMLIFrameElement).hidden, false);
    } finally {
      mock.timers.reset();
    }
  });
});

/**
 * The panel's page stack, its header Back and the page title are RightPanel's, covered with the real
 * panel in BrowserPanel.panel-back.dom.test.tsx (#2914). Alone, the Browser keeps a stack of its own.
 */
describe("an open artifact in the Browser is a page (#2855, #2914)", () => {
  test("its bar is the toolbar slot's row, with Download and no back or title of its own, over the hidden list", async () => {
    const first = artifact("first", "first body");
    const second = artifact("second", "second body");
    const priorExport = api.artifactExport;
    const exported: string[] = [];
    api.artifactExport = async (id: string) => {
      exported.push(id);
      return new Blob([id === "first" ? "first body" : "second body"], { type: "text/plain" });
    };
    try {
      await withPanel(async () => ({ artifacts: [first, second] }), async (container) => {
        const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".browser-artifact-list .row")];
        assert.deepEqual(rows().map((row) => row.dataset.panelPageKey), ["first", "second"], "each row carries its page key, the artifact's id");
        await act(async () => { rows()[1]!.click(); });
        await waitForPreviewToSettle(container);
        assert.deepEqual(exported, ["second"]);
        const bar = container.querySelector(".rpanel-toolbar > .toolbar.art-bar");
        assert.ok(bar, "the bar sits in the toolbar slot, above the one scroller");
        assert.deepEqual([...bar.querySelectorAll(":scope > button")].map((button) => button.textContent?.trim()), ["Download"]);
        assertNoDomNode(bar.querySelector("h2"), "the title is the panel header's");
        const backs = [...container.querySelectorAll("button")].filter((button) =>
          /^Back/u.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
        assert.equal(backs.length, 0, "the panel header's Back is the only back control");
        assert.doesNotMatch(container.textContent ?? "", /‹/u);
        assertNoDomNode(container.querySelector('[role="tablist"]'), "the tabs give way to the page");
        assert.equal(rows().length, 2, "the list stays mounted under the page");
        assert.ok(rows()[1]!.closest("[hidden]"), "hidden");
        assert.equal(container.querySelectorAll(".rpanel-scroll").length, 1, "the list and the page share the one scroller");
        assert.match(container.querySelector(".rpanel-scroll .art-meta")?.textContent ?? "", /Test log/u, "the meta line scrolls with the body");
        assert.equal(container.querySelector("pre")?.textContent, "second body");
      });
    } finally {
      api.artifactExport = priorExport;
    }
  });

  test("a page whose artifact the next session's list doesn't carry gives way to that list", async () => {
    const first = artifact("first", "first body");
    const other = artifact("other", "other body");
    const priorList = api.sessionWorkflowArtifacts;
    const priorExport = api.artifactExport;
    api.sessionWorkflowArtifacts = async (sessionId: string) => ({ artifacts: sessionId === "session_1" ? [first] : [other] });
    api.artifactExport = async () => new Blob(["first body"], { type: "text/plain" });
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    try {
      await act(async () => root.render(<BrowserPanel session={{ id: "session_1" } as SessionView} />));
      await settle();
      await act(async () => { container.querySelector<HTMLButtonElement>(".browser-artifact-list .row")!.click(); });
      await waitForPreviewToSettle(container);
      await act(async () => root.render(<BrowserPanel session={{ id: "session_2" } as SessionView} />));
      await settle();
      await settle();
      assertNoDomNode(container.querySelector(".art-bar"), "no preview of another session's artifact");
      const rows = [...container.querySelectorAll<HTMLButtonElement>(".browser-artifact-list .row")];
      assert.deepEqual(rows.map((row) => row.dataset.panelPageKey), ["other"]);
      assert.ok(!rows[0]!.closest("[hidden]"), "the list shows");
      // Opening the new session's artifact still works: the stale page is gone, not stacked under it.
      await act(async () => rows[0]!.click());
      assert.ok(container.querySelector(".art-bar"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      api.sessionWorkflowArtifacts = priorList;
      api.artifactExport = priorExport;
    }
  });
});
