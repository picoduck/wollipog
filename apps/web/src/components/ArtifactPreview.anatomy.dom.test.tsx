import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactKind, WorkflowArtifactView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import {
  ArtifactPreviewBody,
  ArtifactPreviewDialog,
  ArtifactPreviewHeader,
  ArtifactPreviewMeta,
  DOWNLOAD_WARNING,
  useArtifactPreview,
} from "./ArtifactPreview.js";

const domWindow = new Window({ url: "http://localhost/", settings: { disableIframePageLoading: true } });
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const MIME: Record<WorkflowArtifactKind, string> = {
  html_preview: "text/html", patch: "text/x-diff", review_report: "text/markdown", screenshot: "image/png",
  test_log: "text/plain", verdict: "application/json", video: "video/webm",
};

function artifact(kind: WorkflowArtifactKind, name: string, body: string | Uint8Array, extra: Partial<WorkflowArtifactView> = {}): WorkflowArtifactView {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    artifactId: `${kind}-1`, sessionId: "session_1", kind, name, mimeType: MIME[kind],
    encoding: kind === "screenshot" || kind === "video" ? "base64" : kind === "verdict" ? "json" : "utf8",
    sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    createdBy: { kind: "human", id: "usr_8f2c41" }, createdAt: Date.now() - 60_000, ...extra,
  };
}

const viewer: ViewerIdentity = { userId: "usr_8f2c41", shared: false, names: new Map() };

/** The Browser's anatomy without the panel: the header, the meta line and the body over one load. */
function Preview({ item, onBack }: { item: WorkflowArtifactView; onBack?: () => void }) {
  const model = useArtifactPreview(item);
  return (
    <div className="art-view">
      <ArtifactPreviewHeader model={model} onBack={onBack} />
      <ArtifactPreviewMeta model={model} />
      <ArtifactPreviewBody model={model} />
    </div>
  );
}

// Registered before the shared cleanup, which empties the body: a dialog's portal must unmount first.
let mounted: { root: Root; container: HTMLDivElement } | null = null;
afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  mounted = null;
  await act(async () => root.unmount());
  container.remove();
});
installDomTestCleanup(domWindow);

async function render(ui: React.ReactNode, exportArtifact: ApiClient["artifactExport"]): Promise<HTMLDivElement> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  mounted = { root, container };
  const client = { ...api, artifactExport: exportArtifact } as ApiClient;
  await act(async () => root.render(
    <ApiProvider client={client}>
      <ViewerIdentityContext.Provider value={viewer}>{ui}</ViewerIdentityContext.Provider>
    </ApiProvider>,
  ));
  return container;
}

const exporting = (item: WorkflowArtifactView, body: string | Uint8Array): ApiClient["artifactExport"] =>
  async () => new Blob([body as BlobPart], { type: item.mimeType });

/** Waits for `predicate`. Assertions here compare booleans, never DOM nodes: a failed `assert.equal`
 * on two happy-dom elements inspects their whole object graphs for its diff and exhausts memory. */
async function settle(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}: ${document.body.innerHTML}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

const ready = (container: Element) => () => container.querySelector(".artifact-preview")?.getAttribute("aria-busy") === "false";

const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;

describe("the artifact preview's header and meta line (#2855)", () => {
  test("one 48px bar: Back to Artifacts, the title from the leading edge, then Download", async () => {
    const item = artifact("test_log", "web unit suite.log", "ok 1\n");
    let backs = 0;
    const container = await render(<Preview item={item} onBack={() => backs++} />, exporting(item, "ok 1\n"));
    await settle(ready(container), "the log");
    const bar = container.querySelector(".art-bar")!;
    assert.ok(bar.classList.contains("toolbar"));
    // Download's progress line is a visually hidden sibling, not a control.
    const controls = [...bar.querySelectorAll(":scope > button, :scope > h2")]
      .map((child) => child.getAttribute("aria-label") ?? child.textContent?.trim());
    assert.deepEqual(controls, ["Back to Artifacts", "web unit suite.log", "Download"], "back, title, Download in order");
    assert.equal(bar.querySelector("h2.art-title")?.getAttribute("title"), "web unit suite.log");
    assert.doesNotMatch(container.textContent ?? "", /‹/u, "no text-glyph back");
    await act(async () => buttonNamed(bar, "Back to Artifacts")!.click());
    assert.equal(backs, 1);
  });

  test("the meta line names kind, size, author and Verified, and never a MIME type, hash or user id", async () => {
    const item = artifact("review_report", "Review", "# Findings\n\nNone.\n");
    let deliver!: () => void;
    const container = await render(<Preview item={item} />, () => new Promise<Blob>((resolve) => {
      deliver = () => resolve(new Blob(["# Findings\n\nNone.\n"], { type: item.mimeType }));
    }));
    const meta = () => [...container.querySelectorAll(".art-meta > span")].map((span) => span.textContent);
    assert.deepEqual(meta(), ["Review report", `${item.sizeBytes} B`, "You"], "Verified waits for the check");
    await act(async () => deliver());
    await settle(ready(container), "the report");
    assert.deepEqual(meta(), ["Review report", `${item.sizeBytes} B`, "You", "Verified"]);
    assert.ok(container.querySelector(".art-verified svg"), "Verified carries the shield");
    const text = container.textContent ?? "";
    assert.doesNotMatch(text, /text\/markdown/u);
    assert.doesNotMatch(text, new RegExp(item.sha256.slice(0, 12), "u"));
    assert.doesNotMatch(text, /usr_/u);
    assert.doesNotMatch(text, /Raw downloads|not redacted/iu, "no disclaimer paragraph under the meta");
  });

  test("an agent's artifact names no session id when its session is not loaded", async () => {
    const item = artifact("test_log", "log", "x", { createdBy: { kind: "agent", id: "s_9d1e2f3a4b5c" } });
    const container = await render(<Preview item={item} />, exporting(item, "x"));
    await settle(ready(container), "the log");
    assert.match(container.querySelector(".art-meta")?.textContent ?? "", /Agent/u);
    assert.doesNotMatch(container.textContent ?? "", /s_9d1e2f3a4b5c/u);
  });
});

describe("the artifact preview's Download menu (#2855)", () => {
  test("Download Original File carries the warning as its description, and Copy Checksum copies the full SHA-256", async () => {
    const item = artifact("test_log", "build.log", "built\n");
    const copied: string[] = [];
    Object.defineProperty(domWindow.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
    const container = await render(<Preview item={item} />, exporting(item, "built\n"));
    await settle(ready(container), "the log");
    assert.doesNotMatch(document.body.textContent ?? "", /Not redacted/u, "the warning is not on the preview");
    const trigger = buttonNamed(container, "Download")!;
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    await act(async () => trigger.click());
    const menu = document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent), ["Download Original File", "Copy Checksum"]);
    assert.equal(items[0]!.querySelector(".menu-desc")?.textContent, DOWNLOAD_WARNING);
    assert.equal(DOWNLOAD_WARNING, "Not redacted. It may contain secrets or personal data.");
    assert.equal(document.body.textContent?.split(DOWNLOAD_WARNING).length, 2, "the warning appears once, on its item");
    await act(async () => { (items[1] as HTMLElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(copied, [item.sha256]);
    assert.equal(copied[0]!.length, 64);
  });
});

describe("the artifact preview's states (#2855)", () => {
  test("loading is a skeleton that says it is loading and checking", async () => {
    const item = artifact("test_log", "log", "x");
    const container = await render(<Preview item={item} />, () => new Promise<Blob>(() => {}));
    const status = container.querySelector(".art-skeleton[role=status]");
    assert.equal(status?.querySelector(".art-skeleton-label")?.textContent, "Loading and checking the preview…");
    assert.ok(status?.querySelector(".skeleton-row"));
  });

  test("bytes that fail their checksum show Couldn't Verify This Artifact, the reason behind Show Details, and Retry", async () => {
    const item = artifact("test_log", "log", "expected");
    let exports = 0;
    const container = await render(<Preview item={item} />, async () => {
      exports++;
      return new Blob([exports === 1 ? "tampered" : "expected"], { type: "text/plain" });
    });
    await settle(() => !!container.querySelector('[role="alert"]'), "the verification failure");
    const alert = container.querySelector('[role="alert"]')!;
    assert.match(alert.textContent ?? "", /Couldn't Verify This Artifact/u);
    assert.doesNotMatch(alert.textContent ?? "", /digest/u);
    assertNoDomNode(container.querySelector(".art-verified"), "nothing reads Verified");
    await act(async () => buttonNamed(alert, "Show Details")!.click());
    assert.match(alert.textContent ?? "", /digest does not match/u);
    await act(async () => buttonNamed(alert, "Retry")!.click());
    await settle(ready(container), "the retried log");
    assert.equal(exports, 2);
    assert.equal(container.querySelector(".art-code pre")?.textContent, "expected");
    assertNoDomNode(container.querySelector('[role="alert"]'));
  });

  test("a type with no safe preview says so and offers Download Original File", async () => {
    const item = artifact("patch", "fix.bin", "x", { mimeType: "application/octet-stream" });
    let exports = 0;
    const container = await render(<Preview item={item} />, async () => { exports++; return new Blob(["x"]); });
    assert.match(container.querySelector(".state-title")?.textContent ?? "", /No Preview for This Type/u);
    assert.ok(buttonNamed(container.querySelector(".state")!, "Download Original File"));
    assert.equal(exports, 0, "nothing is fetched until the person asks for the file");
  });
});

describe("the artifact preview's bodies (#2855)", () => {
  test("markdown skips a leading H1 that repeats the title", async () => {
    const source = "# Browser Review\n\n## Findings\n\nNone.\n";
    const item = artifact("review_report", "Browser Review", source);
    const container = await render(<Preview item={item} />, exporting(item, source));
    await settle(ready(container), "the report");
    assertNoDomNode(container.querySelector(".art-markdown h1"), "the repeated title is gone");
    assert.equal(container.querySelector(".art-markdown h2")?.textContent, "Findings");
  });

  test("JSON reads in the diff's token classes inside a code well whose Wrap Lines toggles", async () => {
    const source = '{"verdict":"pass","count":3,"flaky":false}';
    const item = artifact("verdict", "verdict.json", source);
    const container = await render(<Preview item={item} />, exporting(item, source));
    await settle(ready(container), "the verdict");
    const well = container.querySelector(".code-well.art-code")!;
    assert.ok(well.querySelector(".diff-syntax-string"));
    assert.ok(well.querySelector(".diff-syntax-number"));
    assert.ok(well.querySelector(".diff-syntax-literal"));
    assert.equal(well.querySelector("pre")?.textContent, JSON.stringify(JSON.parse(source), null, 2) + "\n");
    const wrap = buttonNamed(well, "Wrap Lines")!;
    assert.equal(wrap.getAttribute("aria-pressed"), "true");
    assert.ok(well.classList.contains("is-wrapped"));
    await act(async () => wrap.click());
    assert.equal(wrap.getAttribute("aria-pressed"), "false");
    assert.equal(well.classList.contains("is-wrapped"), false);
  });

  test("HTML keeps its empty sandbox in a captioned well", async () => {
    const source = "<h1>Dashboard</h1><script>alert(1)</script>";
    const item = artifact("html_preview", "Dashboard preview", source);
    const container = await render(<Preview item={item} />, exporting(item, source));
    await settle(ready(container), "the HTML preview");
    const frame = container.querySelector("figure.art-well iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.match(frame.getAttribute("srcdoc") ?? "", /Content-Security-Policy/u);
    assert.equal(container.querySelector("figcaption")?.textContent, "Sandboxed: scripts, forms and links are turned off.");
    assert.ok(buttonNamed(container.querySelector(".art-bar")!, "Enlarge"), "HTML can be enlarged");
  });

  test("Enlarge opens an image in a full dialog, and Done returns focus to Enlarge", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const item = artifact("screenshot", "Settings at 390px.png", bytes);
    const priorCreate = URL.createObjectURL;
    const priorRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:enlarge";
    URL.revokeObjectURL = () => {};
    try {
      const container = await render(<Preview item={item} />, exporting(item, bytes));
      await settle(ready(container), "the screenshot");
      assert.ok(container.querySelector(".art-checker img.art-image"), "the image sits on a checkerboard well");
      const enlarge = buttonNamed(container.querySelector(".art-bar")!, "Enlarge")!;
      enlarge.focus();
      await act(async () => enlarge.click());
      const dialog = document.querySelector('[role="dialog"].art-enlarged')!;
      assert.ok(dialog, "the image opens in a dialog");
      assert.ok(dialog.closest(".modal.full"), "a full dialog (§7.1)");
      assert.equal(dialog.querySelector(".art-stage img")?.getAttribute("src"), "blob:enlarge");
      await act(async () => buttonNamed(dialog, "Done")!.click());
      assertNoDomNode(document.querySelector(".art-enlarged"));
      // The dialog restores focus on a timer of its own once it has gone.
      await settle(() => document.activeElement === enlarge, "focus back on Enlarge");
    } finally {
      URL.createObjectURL = priorCreate;
      URL.revokeObjectURL = priorRevoke;
    }
  });

  test("a log has no Enlarge", async () => {
    const item = artifact("test_log", "log", "x");
    const container = await render(<Preview item={item} />, exporting(item, "x"));
    await settle(ready(container), "the log");
    assertNoDomNode(buttonNamed(container, "Enlarge"));
  });
});

describe("Run detail's preview dialog (#2855)", () => {
  test("a large dialog titled with the artifact over its meta line, with Download and Done in the footer and no ×", async () => {
    const item = artifact("test_log", "run notes.txt", "notes");
    let closed = 0;
    await render(<ArtifactPreviewDialog artifact={item} onClose={() => closed++} />, exporting(item, "notes"));
    const dialog = document.querySelector('[role="dialog"]')!;
    await settle(ready(dialog), "the dialog's preview");
    assert.ok(dialog.closest(".modal.lg"), "size lg (§7.1)");
    assert.equal(dialog.querySelector(".modal-title")?.textContent, "run notes.txt");
    assert.match(dialog.querySelector(".modal-desc .art-meta")?.textContent ?? "", /Test log.*Verified/u);
    const foot = dialog.querySelector(".modal-foot")!;
    assert.deepEqual([...foot.querySelectorAll("button")].map((button) => button.textContent?.trim()), ["Download", "Done"]);
    assert.doesNotMatch(document.body.textContent ?? "", /×/u);
    await act(async () => buttonNamed(foot, "Done")!.click());
    assert.equal(closed, 1);
  });
});
