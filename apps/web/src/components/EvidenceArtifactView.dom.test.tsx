import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { pendingRequests, type SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { saveEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { EvidenceArtifactView, type EvidenceArtifactStatus } from "./EvidenceArtifactView.js";
import { RequestDock, dockRequests } from "./requests/RequestDock.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("desktop-after")]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);
const WEBM_SHA = createHash("sha256").update(WEBM).digest("hex");
const RESOURCE_DIGEST = "b".repeat(64);

type Evidence = { evidenceId: string; uri?: string; sha256: string; artifactId?: string; mediaType?: string };

function sessionWith(evidence: Evidence[]): SessionView {
  return {
    id: "session-artifact-evidence",
    runnerId: "runner",
    title: "Artifact Evidence",
    status: "input_required",
    eventEpoch: 1,
    pendingApproval: {
      requestId: "occurrence-1",
      occurrenceId: "occurrence-1",
      kind: "workflow_decision",
      title: "UI Evidence Approval Required",
      context: { input: "{}" },
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "request-1",
        occurrenceId: "occurrence-1",
        sessionId: "session-artifact-evidence",
        controllingSessionId: "session-parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1458-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence },
        resourceDigest: RESOURCE_DIGEST,
        policyRevision: 1,
        authority: "human",
        status: "pending",
        createdAt: Date.now() - 1_000,
      },
    },
  } as SessionView;
}

const artifactItem = (overrides: Partial<Evidence> = {}): Evidence => ({
  evidenceId: "desktop-after",
  uri: "https://evidence.example/desktop-after.png?signature=secret",
  sha256: PNG_SHA,
  artifactId: "art_desktop",
  mediaType: "image/png",
  ...overrides,
});

async function mount(session: SessionView, artifactExport: ApiClient["artifactExport"]) {
  const requests: string[] = [];
  const client = {
    ...api,
    artifactExport: async (artifactId: string) => {
      requests.push(artifactId);
      return artifactExport(artifactId);
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      {/* The session's own evidence is reviewed on the request dock's card (#2179). */}
      <RequestDock session={session} requests={dockRequests(pendingRequests(session.pendingApproval))} runnerOnline />
    </ApiProvider>,
  ));
  // Fetch, digest, and the state update each settle on their own turn.
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
    .find((candidate) => candidate.textContent === name)!;
  // Tiles are named by media type (#2197): "Screenshot", or "Screenshot 1" when there are several.
  const checkbox = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Mark ${name} as Reviewed"]`);
  const tile = (evidenceId: string) => [...container.querySelectorAll<HTMLElement>(".ev-tile")]
    .find((candidate) => candidate.querySelector(".ev-id")?.textContent === evidenceId)!;
  const footNote = () => container.querySelector(".request-card-reasons")?.textContent ?? "";
  // happy-dom never decodes an image, so the browser's verdict is delivered by hand: "load" for a
  // picture it could draw, "error" for bytes it could not.
  const decode = async (verdict: "load" | "error") => {
    for (const image of container.querySelectorAll<HTMLImageElement>(".ev-media img")) {
      await act(async () => { image.dispatchEvent(new domWindow.Event(verdict) as unknown as Event); });
    }
  };
  return {
    container, requests, button, checkbox, tile, footNote, decode,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("artifact-backed evidence is shown in its tile, verified against the decision digest, and replaces the external link", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG], { type: "application/octet-stream" }));
  try {
    assert.deepEqual(view.requests, ["art_desktop"]);
    // A digest match says the file is the one the request names, not that it is a picture. Until
    // the browser has drawn it, nothing is visible and nothing can be marked reviewed.
    assert.equal(view.container.querySelector<HTMLButtonElement>(".ev-thumb")?.hidden, true);
    assertNoDomNode(view.checkbox("Screenshot"), "a verified but undrawn image is not yet shown, so it has no mark");
    assert.equal(view.container.querySelector(".ev-loading")?.textContent, "Loading…");
    assert.equal(view.footNote(), "Review 1 more to approve.");
    await view.decode("load");
    assert.equal(view.container.querySelector<HTMLButtonElement>(".ev-thumb")?.hidden, false);
    const image = view.container.querySelector<HTMLImageElement>(".ev-media img");
    assert.ok(image, "the verified artifact is rendered inside the card");
    assert.equal(image.getAttribute("alt"), "Screenshot");
    assert.match(image.getAttribute("src") ?? "", /^blob:/u, "bytes stay in memory behind an object URL");
    assertNoDomNode(view.container.querySelector('a[href^="https://evidence.example"]'),
      "an artifact-backed item never sends the reviewer to the external copy");
    assert.doesNotMatch(view.container.innerHTML, /signature=secret/u);
    assert.equal(view.container.querySelector(".ev-thumb")?.getAttribute("aria-label"), "Open Screenshot");
    assert.ok(view.container.querySelector(".ev-thumb[data-ev-viewer-target]"), "the shown tile is the viewer's target");
    assert.equal(view.tile("desktop-after").querySelector(".ev-name")?.textContent, "Screenshot");
    assert.equal(view.checkbox("Screenshot")!.disabled, false, "a shown image can be marked reviewed");
    assert.equal(view.button("Approve").disabled, true, "showing is not reviewing");
  } finally {
    await view.unmount();
  }
});

test("artifact-only evidence can be reviewed without creating an external link", async () => {
  domWindow.localStorage.clear();
  const { uri: _externalCopy, ...item } = artifactItem();
  const view = await mount(sessionWith([item]), async () => new Blob([PNG]));
  try {
    assert.deepEqual(view.requests, ["art_desktop"]);
    await view.decode("load");
    assert.equal(view.container.querySelector(".ev-media img")?.getAttribute("alt"), "Screenshot");
    assertNoDomNode(view.container.querySelector(".ev-tile a"));
    assert.equal(view.checkbox("Screenshot")!.disabled, false);
    await act(async () => view.checkbox("Screenshot")!.click());
    assert.equal(view.button("Approve").disabled, false);
    assertNoDomNode(view.container.querySelector(".request-card-reasons"), "nothing is left to explain");
  } finally {
    await view.unmount();
  }
});

test("artifact-backed video is reviewable only after a picture frame loads", async () => {
  domWindow.localStorage.clear();
  const item = { evidenceId: "clip", artifactId: "art_clip", mediaType: "video/webm", sha256: WEBM_SHA };
  const view = await mount(sessionWith([item]), async () => new Blob([WEBM], { type: "video/webm" }));
  try {
    assert.deepEqual(view.requests, ["art_clip"]);
    const video = view.container.querySelector<HTMLVideoElement>(".ev-thumb video");
    assert.ok(video);
    assert.equal(view.container.querySelector<HTMLButtonElement>(".ev-thumb")!.hidden, true);
    assertNoDomNode(view.checkbox("Recording"), "a loading tile has no mark");
    Object.defineProperties(video, { videoWidth: { value: 320 }, videoHeight: { value: 180 } });
    await act(async () => video.dispatchEvent(new domWindow.Event("loadedmetadata") as unknown as Event));
    assert.equal(view.container.querySelector<HTMLButtonElement>(".ev-thumb")!.hidden, true,
      "metadata alone does not prove a frame was shown");
    assertNoDomNode(view.checkbox("Recording"));
    await act(async () => video.dispatchEvent(new domWindow.Event("loadeddata") as unknown as Event));
    assert.equal(view.container.querySelector<HTMLButtonElement>(".ev-thumb")!.hidden, false);
    // The tile holds the first frame, still and muted; the recording plays where the tile opens it.
    assert.equal(video.muted, true);
    assert.equal(video.hasAttribute("playsinline"), true);
    assert.equal(view.tile("clip").querySelector(".ev-facts")?.textContent, "320 × 180");
    assert.equal(view.checkbox("Recording")!.disabled, false);
    assertNoDomNode(view.container.querySelector(".ev-tile a"));
    await act(async () => view.container.querySelector<HTMLButtonElement>(".ev-thumb")!.click());
    // The dialog renders outside the card, in the document's modal layer.
    const playing = domWindow.document.querySelector('video[aria-label="Play Recording"]') as unknown as HTMLVideoElement | null;
    assert.ok(playing, "opening the tile plays the recording with its controls");
    assert.equal(playing.hasAttribute("controls"), true);
    await act(async () => view.checkbox("Recording")!.click());
    assert.equal(view.button("Approve").disabled, false);
    // Playback that fails in the dialog withdraws the review, as a failed first frame would.
    await act(async () => playing.dispatchEvent(new domWindow.Event("error") as unknown as Event));
    assertNoDomNode(domWindow.document.querySelector('video[aria-label="Play Recording"]'), "the failed player closes");
    assert.equal(view.tile("clip").querySelector(".ev-blocked-label")?.textContent, "Can't Load");
    assertNoDomNode(view.checkbox("Recording"));
    assert.equal(view.button("Approve").disabled, true);
  } finally { await view.unmount(); }
});

test("a video without a picture track cannot be marked reviewed", async () => {
  domWindow.localStorage.clear();
  const item = { evidenceId: "clip", artifactId: "art_clip", mediaType: "video/webm", sha256: WEBM_SHA };
  const view = await mount(sessionWith([item]), async () => new Blob([WEBM], { type: "video/webm" }));
  try {
    const video = view.container.querySelector<HTMLVideoElement>(".ev-thumb video");
    assert.ok(video);
    Object.defineProperties(video, { videoWidth: { value: 0 }, videoHeight: { value: 0 } });
    assert.equal(video.videoWidth, 0);
    await act(async () => video.dispatchEvent(new domWindow.Event("loadedmetadata") as unknown as Event));
    assert.equal(view.tile("clip").querySelector(".ev-blocked")?.textContent, "Can't LoadIt matches its digest but can't be drawn.");
    assertNoDomNode(view.checkbox("Recording"), "a blocked tile has no Reviewed mark");
    assert.equal(view.button("Approve").disabled, true);
  } finally { await view.unmount(); }
});

test("a digest mismatch or an unavailable artifact shows no image and cannot count as reviewed", async () => {
  domWindow.localStorage.clear();
  // A mark saved on an earlier visit must not survive the artifact turning out to be wrong.
  saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["desktop-after"]);
  const swapped = await mount(sessionWith([artifactItem()]), async () => new Blob([Buffer.from("substituted")]));
  try {
    assertNoDomNode(swapped.container.querySelector(".ev-media img"), "mismatched bytes are never displayed");
    assert.equal(swapped.tile("desktop-after").querySelector(".ev-blocked-label")?.textContent, "Doesn't Match");
    assertNoDomNode(swapped.checkbox("Screenshot"), "the saved mark is not shown as a review");
    assert.match(swapped.container.querySelector('.notice[role="alert"]')?.textContent ?? "",
      /Deny this request and ask for a new capture\./u);
    assert.equal(swapped.footNote(), "Can't approve until every item can be reviewed.");
    assert.equal(swapped.button("Approve").disabled, true, "the saved mark cannot approve unseen evidence");
    assert.equal(swapped.button("Deny").disabled, false, "the reviewer can still reject");
  } finally {
    await swapped.unmount();
  }

  const gone = await mount(sessionWith([artifactItem()]), async () => { throw new ApiError("artifact not found", 404); });
  try {
    const blocked = gone.tile("desktop-after").querySelector(".ev-blocked");
    assert.equal(blocked?.querySelector(".ev-blocked-label")?.textContent, "Can't Load");
    assert.match(blocked?.textContent ?? "", /gone, or you don't have access/u,
      "a missing or forbidden artifact reads differently from a bad capture");
    assertNoDomNode(blocked?.querySelector("button"), "access and absence do not change on a retry");
    assertNoDomNode(gone.checkbox("Screenshot"));
    assertNoDomNode(gone.container.querySelector('a[href^="https://evidence.example"]'),
      "the card does not fall back to the external copy");
  } finally {
    await gone.unmount();
  }

  // The artifact validator checks only a file's signature, so a PNG header over junk is storable
  // and its digest matches. The browser cannot draw it, and an undrawn image was never reviewed.
  saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["desktop-after"]);
  const undrawable = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG]));
  try {
    await undrawable.decode("error");
    assert.equal(undrawable.tile("desktop-after").querySelector(".ev-blocked")?.textContent,
      "Can't LoadIt matches its digest but can't be drawn.");
    assertNoDomNode(undrawable.container.querySelector(".ev-media img"), "no broken image is left on screen");
    assertNoDomNode(undrawable.container.querySelector(".ev-blocked button"), "the same bytes will not decode on a retry");
    assertNoDomNode(undrawable.checkbox("Screenshot"));
    assert.equal(undrawable.button("Approve").disabled, true);
  } finally {
    await undrawable.unmount();
    domWindow.localStorage.clear();
  }

  // An image that was shown and marked can still fail afterwards. The mark must stop counting in
  // the same update that removes the image, not an effect later.
  const regressed = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG]));
  try {
    await regressed.decode("load");
    await act(async () => regressed.checkbox("Screenshot")!.click());
    assert.equal(regressed.button("Approve").disabled, false, "a shown and marked item enables approval");
    await regressed.decode("error");
    assertNoDomNode(regressed.container.querySelector(".ev-media img"));
    assertNoDomNode(regressed.checkbox("Screenshot"), "the earlier mark no longer reads as a review");
    assert.equal(regressed.container.querySelector(".ev-progress")?.textContent, "0 of 1 reviewed");
    assert.equal(regressed.button("Approve").disabled, true, "approval is withdrawn with the image");
  } finally {
    await regressed.unmount();
    domWindow.localStorage.clear();
  }

  let failures = 1;
  const flaky = await mount(sessionWith([artifactItem()]), async () => {
    if (failures-- > 0) throw new Error("network down");
    return new Blob([PNG]);
  });
  try {
    const retry = flaky.container.querySelector<HTMLButtonElement>(".ev-blocked button");
    assert.equal(retry?.textContent, "Retry", "a transport failure can be retried");
    assert.equal(retry?.getAttribute("aria-label"), "Retry Screenshot");
    await act(async () => retry!.click());
    for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await flaky.decode("load");
    assert.ok(flaky.container.querySelector(".ev-media img"), "the retry loads and verifies the artifact");
    assert.equal(flaky.checkbox("Screenshot")!.disabled, false);
  } finally {
    await flaky.unmount();
  }
});

test("a link-only item can be marked reviewed only after its link was opened in this browser", async () => {
  domWindow.localStorage.clear();
  // A mark saved before opened links were recorded does not count until the link is opened.
  saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["legacy"]);
  const session = sessionWith([
    artifactItem(),
    { evidenceId: "legacy", uri: "https://evidence.example/legacy.png", sha256: "1".repeat(64) },
    { evidenceId: "clip", uri: "https://evidence.example/clip.webm", sha256: "2".repeat(64), mediaType: "video/webm" },
  ]);
  const view = await mount(session, async () => new Blob([PNG]));
  try {
    assert.deepEqual(view.requests, ["art_desktop"], "only a renderable raster artifact is fetched");
    await view.decode("load");
    assert.equal(view.container.querySelectorAll(".ev-thumb").length, 1);
    assert.deepEqual([...view.container.querySelectorAll(".ev-name")].map((name) => name.textContent),
      ["Screenshot", "Link 1", "Link 2"]);
    assert.equal(view.container.querySelector(".request-card-title")?.textContent, "Review 3 items before approving");
    for (const [evidenceId, name] of [["legacy", "Link 1"], ["clip", "Link 2"]] as const) {
      const link = view.tile(evidenceId).querySelector<HTMLAnchorElement>("a.btn.sm");
      assert.equal(link?.textContent, "Open Link");
      assert.equal(link?.getAttribute("target"), "_blank");
      assert.equal(link?.getAttribute("rel"), "noreferrer");
      assert.equal(view.checkbox(name)!.disabled, true, `${name} waits until its link is opened`);
      assert.equal(view.checkbox(name)!.checked, false);
    }
    assert.equal(view.footNote(), "Review 3 more to approve.");
    // happy-dom does not navigate, so activating the link only records that it was opened.
    await act(async () => view.tile("legacy").querySelector<HTMLAnchorElement>("a")!.click());
    assert.equal(view.checkbox("Link 1")!.disabled, false, "an opened link can be marked reviewed");
    assert.equal(view.checkbox("Link 1")!.checked, true, "the earlier mark counts once the link was opened");
    assert.equal(view.checkbox("Link 2")!.disabled, true, "opening one link does not open the other");
    await act(async () => view.checkbox("Screenshot")!.click());
    assert.equal(view.footNote(), "Review 1 more to approve.");
    assert.equal(view.button("Approve").getAttribute("aria-describedby"),
      view.container.querySelector(".request-card-reasons > p")?.id, "Approve is described by the foot-note");
    // A secondary click only opens the context menu, which opens nothing by itself.
    await act(async () => view.tile("clip").querySelector("a")!.dispatchEvent(
      new domWindow.MouseEvent("auxclick", { bubbles: true, button: 2 }) as unknown as Event));
    assert.equal(view.checkbox("Link 2")!.disabled, true, "a right click is not an opened link");
    // A middle click opens the link.
    await act(async () => view.tile("clip").querySelector("a")!.dispatchEvent(
      new domWindow.MouseEvent("auxclick", { bubbles: true, button: 1 }) as unknown as Event));
    await act(async () => view.checkbox("Link 2")!.click());
    assert.equal(view.button("Approve").disabled, false);
  } finally {
    await view.unmount();
  }

  // The opened links are kept with the occurrence's draft, as the marks are.
  const restored = await mount(session, async () => new Blob([PNG]));
  try {
    assert.equal(restored.checkbox("Link 1")!.disabled, false);
    assert.equal(restored.checkbox("Link 2")!.disabled, false);
  } finally {
    await restored.unmount();
    domWindow.localStorage.clear();
  }
});

test("a four-screenshot request has one title, a progress line, named tiles and one digest caption", async () => {
  domWindow.localStorage.clear();
  const items = Array.from({ length: 4 }, (_, index) =>
    artifactItem({ evidenceId: `viewport-${index + 1}`, artifactId: `art_${index + 1}` }));
  const view = await mount(sessionWith(items), async () => new Blob([PNG]));
  try {
    assert.equal(view.container.querySelector(".request-card-title")?.textContent, "Review 4 screenshots before approving");
    assert.equal(view.container.querySelector(".request-card-kind")?.textContent, "UI Evidence");
    const progress = view.container.querySelector(".ev-progress");
    assert.equal(progress?.textContent, "0 of 4 reviewed");
    assert.equal(progress?.getAttribute("role"), "status");
    assert.equal(progress?.getAttribute("aria-live"), "polite");
    assert.equal(view.container.querySelectorAll(".ev-grid .ev-tile").length, 4);
    assert.deepEqual([...view.container.querySelectorAll(".ev-name")].map((name) => name.textContent),
      ["Screenshot 1", "Screenshot 2", "Screenshot 3", "Screenshot 4"]);
    assert.deepEqual([...view.container.querySelectorAll(".ev-id")].map((id) => id.textContent),
      ["viewport-1", "viewport-2", "viewport-3", "viewport-4"]);
    assertNoDomNode(view.container.querySelector(".ev-checked"), "nothing is claimed before a draw");
    await view.decode("load");
    assert.equal(view.container.querySelectorAll(".ev-checked").length, 1, "one caption, not one per item");
    assert.equal(view.container.querySelector(".ev-checked")?.textContent,
      "Shown screenshots were checked by this browser against the request's digest.");
    assert.equal(view.container.querySelector(".ev-checked")!.compareDocumentPosition(
      view.container.querySelector(".ev-grid")!), domWindow.Node.DOCUMENT_POSITION_PRECEDING, "the caption is under the grid");
    await act(async () => view.checkbox("Screenshot 1")!.click());
    await act(async () => view.checkbox("Screenshot 2")!.click());
    assert.equal(progress?.textContent, "2 of 4 reviewed");
    const approve = view.button("Approve");
    assert.equal(approve.disabled, true);
    const describedBy = approve.getAttribute("aria-describedby") ?? "";
    assert.equal(domWindow.document.getElementById(describedBy)?.textContent, "Review 2 more to approve.");
    assert.equal(view.button("Deny").disabled, false);
    // The resource key, digest and who decides wait behind one disclosure.
    const details = view.container.querySelector("details.disclosure");
    assert.equal(details?.querySelector("summary")?.textContent, "Show Details");
    assert.match(details?.textContent ?? "", /Resource Keypr-1458-ui/u);
    assert.match(details?.textContent ?? "", /Decided ByA person/u);
  } finally {
    await view.unmount();
  }
});

test("an artifact the card cannot show is blocked as Can't Show and never falls back to its URI", async () => {
  domWindow.localStorage.clear();
  // A mark saved before this rule existed must not carry over either.
  saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["vector", "untyped"]);
  const view = await mount(sessionWith([
    artifactItem(),
    artifactItem({ evidenceId: "vector", artifactId: "art_svg", mediaType: "image/svg+xml",
      uri: "https://evidence.example/vector.svg" }),
    artifactItem({ evidenceId: "untyped", artifactId: "art_untyped", mediaType: undefined,
      uri: "https://evidence.example/untyped.bin" }),
  ]), async () => new Blob([PNG]));
  try {
    assert.deepEqual(view.requests, ["art_desktop"], "an artifact the card cannot show is not fetched");
    await view.decode("load");
    assert.equal(view.container.querySelectorAll("a[href]").length, 0, "no external link stands in for an artifact");
    const blocked = (evidenceId: string) =>
      view.tile(evidenceId).querySelector('.ev-media[data-status="unsupported"] .ev-blocked')?.textContent ?? "";
    assert.equal(blocked("vector"), "Can't Showimage/svg+xml can't be shown here.");
    assert.equal(blocked("untyped"), "Can't ShowIt declares no media type.");
    assertNoDomNode(view.tile("vector").querySelector("input"), "vector cannot be marked reviewed");
    assertNoDomNode(view.tile("untyped").querySelector("input"), "untyped cannot be marked reviewed");
    await act(async () => view.checkbox("Screenshot 1")!.click());
    assert.equal(view.container.querySelector(".ev-progress")?.textContent, "1 of 3 reviewed");
    assert.equal(view.footNote(), "Can't approve until every item can be reviewed.");
    assert.match(view.container.querySelector('.notice[role="alert"]')?.textContent ?? "",
      /Deny this request and ask for a new capture\./u);
    assert.equal(view.button("Approve").disabled, true, "approval stays blocked");
    assert.equal(view.button("Deny").disabled, false, "the reviewer can still deny");
  } finally {
    await view.unmount();
  }
});

async function withoutSubtleCrypto(run: () => Promise<void>): Promise<void> {
  const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle") ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle")!;
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: undefined });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis.crypto, "subtle", subtle);
  }
}

for (const [label, withUri] of [["artifact-only", false], ["artifact-plus-URI", true]] as const) {
  test(`without SubtleCrypto an ${label} item is neither fetched, shown, linked out, nor approvable`, async () => {
    domWindow.localStorage.clear();
    // A mark saved on an earlier visit from a secure page must not carry over to this one.
    saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["desktop-after"]);
    await withoutSubtleCrypto(async () => {
      const { uri: _externalCopy, ...artifactOnly } = artifactItem();
      const view = await mount(sessionWith([withUri ? artifactItem() : artifactOnly]), async () => new Blob([PNG]));
      try {
        assert.deepEqual(view.requests, [], "bytes nobody can check are not downloaded");
        assertNoDomNode(view.container.querySelector(".ev-media img"), "unchecked bytes are not displayed");
        const blocked = view.tile("desktop-after").querySelector(".ev-blocked");
        assert.equal(blocked?.textContent, "Not ShownNeeds HTTPS or localhost.");
        assert.equal(blocked?.getAttribute("data-tone"), "neutral");
        assertNoDomNode(view.container.querySelector(".ev-tile a"), "an artifact-backed item never falls back to its external copy");
        assertNoDomNode(view.container.querySelector("[data-ev-viewer-target]"), "a tile that is not shown is no viewer target");
        assert.doesNotMatch(view.container.innerHTML, /signature=secret/u);
        assertNoDomNode(view.container.querySelector(".ev-checked"));
        const notices = view.container.querySelectorAll('[role="note"][aria-label="HTTPS or Localhost Required"]');
        assert.equal(notices.length, 1, "the card says what is required, once");
        const notice = notices[0]!;
        assert.equal(notice.compareDocumentPosition(view.container.querySelector(".ev-grid")!),
          domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "the notice sits above the grid");
        assert.match(notice.textContent ?? "", /This page is open at http:\/\/localhost\./u);
        assert.match(notice.textContent ?? "", /reopen Wollipog over HTTPS, for example through tailscale serve, or on localhost/u);
        assertNoDomNode(view.checkbox("Screenshot"));
        assert.equal(view.container.querySelector(".ev-progress")?.textContent, "0 of 1 reviewed",
          "a saved mark on an item this page cannot show is not counted");
        assert.equal(view.footNote(), "Approve needs HTTPS or localhost. Deny works from here.");
        assertNoDomNode(view.container.querySelector('.notice[role="alert"]'), "nothing failed: this page just can't check it");
        assert.equal(view.button("Approve").disabled, true);
        assert.equal(view.button("Deny").disabled, false, "rejecting stays possible");
      } finally {
        await view.unmount();
      }
    });
  });
}

test("without SubtleCrypto link-only evidence keeps its link while artifact evidence stays blocked", async () => {
  domWindow.localStorage.clear();
  await withoutSubtleCrypto(async () => {
    const view = await mount(sessionWith([
      artifactItem(),
      { evidenceId: "legacy", uri: "https://evidence.example/legacy.png", sha256: "1".repeat(64) },
    ]), async () => new Blob([PNG]));
    try {
      const link = view.tile("legacy").querySelector<HTMLAnchorElement>("a.btn.sm");
      assert.equal(link?.textContent, "Open Link");
      await act(async () => link!.click());
      assert.equal(view.checkbox("Link")!.disabled, false);
      assertNoDomNode(view.checkbox("Screenshot"));
      await act(async () => view.checkbox("Link")!.click());
      assert.equal(view.button("Approve").disabled, true);
      assert.equal(view.footNote(), "Approve needs HTTPS or localhost. Deny works from here.");
    } finally {
      await view.unmount();
      domWindow.localStorage.clear();
    }
  });
});

test("a failed image is reported to the card inside the error event, before any effect runs", async () => {
  // The card blocks approval from the status it is told. A passive effect also reports status, but
  // it runs after the commit, which would leave one commit where the image is gone and the card
  // still believes it was shown. `act` drains effects before returning, so the only place to see
  // the difference is inside the event itself: the report must already have happened there.
  const reports: EvidenceArtifactStatus[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = { ...api, artifactExport: async () => new Blob([PNG]) } as ApiClient;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <EvidenceArtifactView
          item={artifactItem() as never}
          name="Screenshot"
          onStatusChange={(_evidenceId, status) => { reports.push(status); }}
        />
      </ApiProvider>,
    ));
    for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const image = container.querySelector<HTMLImageElement>(".ev-media img")!;
    await act(async () => { image.dispatchEvent(new domWindow.Event("load") as unknown as Event); });
    assert.equal(reports.at(-1), "ready");

    let duringEvent: EvidenceArtifactStatus | undefined;
    await act(async () => {
      image.dispatchEvent(new domWindow.Event("error") as unknown as Event);
      // Still inside the event's own turn: no commit has happened and no effect has run.
      duringEvent = reports.at(-1);
    });
    assert.equal(duringEvent, "unavailable", "the card is told in the event, not by a later effect");
    assert.equal(reports.at(-1), "unavailable");
    assertNoDomNode(container.querySelector(".ev-media img"));

    // An error with nothing to fail is ignored by the component and must not be reported either.
    const before = reports.length;
    await act(async () => { container.querySelector(".ev-media")!.dispatchEvent(new domWindow.Event("error") as unknown as Event); });
    assert.equal(reports.length, before);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

// The Evidence Viewer (#2207). It is portalled to the document, outside the card.
const viewer = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
const viewerTitle = () => viewer()?.querySelector(".modal-title")?.textContent ?? null;
const viewerButton = (name: string) => [...viewer()?.querySelectorAll<HTMLButtonElement>(".modal-foot button") ?? []]
  .find((candidate) => candidate.textContent?.replace(/[←→]/gu, "").trim() === name)!;
const filmstrip = () => [...viewer()?.querySelectorAll<HTMLButtonElement>(".ev-strip-thumb") ?? []];
const press = async (key: string) => {
  const target = (domWindow.document.activeElement ?? viewer()) as unknown as HTMLElement;
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
};
// Focus comes back on a timer once the dialog has gone.
const settleFocus = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const screenshots = (count: number) => Array.from({ length: count }, (_, index) =>
  artifactItem({ evidenceId: `viewport-${index + 1}`, artifactId: `art_${index + 1}` }));
const openTile = async (view: Awaited<ReturnType<typeof mount>>, evidenceId: string) => {
  const thumb = view.tile(evidenceId).querySelector<HTMLButtonElement>(".ev-thumb")!;
  thumb.focus();
  await act(async () => thumb.click());
};

test("the second tile opens Screenshot 2 of 4, and the arrow keys, Previous and Next step through the items", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith(screenshots(4)), async () => new Blob([PNG]));
  try {
    await view.decode("load");
    await openTile(view, "viewport-2");
    assert.equal(viewerTitle(), "Screenshot 2 of 4");
    assert.equal(viewer()?.querySelector(".ev-viewer-id")?.textContent, "viewport-2", "the id is the secondary text");
    const image = viewer()?.querySelector<HTMLImageElement>(".ev-viewer-stage img");
    assert.equal(image?.getAttribute("alt"), "Screenshot 2");
    assert.match(image?.getAttribute("src") ?? "", /^blob:/u, "the viewer shows the tile's checked bytes");
    assert.equal(domWindow.document.activeElement, viewerButton("Mark Reviewed and Next") as unknown as Element,
      "opening from a tile focuses the viewer's primary");
    await press("ArrowRight");
    assert.equal(viewerTitle(), "Screenshot 3 of 4");
    await press("ArrowLeft");
    assert.equal(viewerTitle(), "Screenshot 2 of 4");
    await act(async () => viewerButton("Next").click());
    assert.equal(viewerTitle(), "Screenshot 3 of 4");
    await act(async () => viewerButton("Previous").click());
    viewerButton("Previous").focus();
    await act(async () => viewerButton("Previous").click());
    assert.equal(viewerTitle(), "Screenshot 1 of 4");
    assert.equal(viewerButton("Previous").disabled, true, "nothing comes before the first item");
    assert.equal(domWindow.document.activeElement, viewerButton("Mark Reviewed and Next") as unknown as Element,
      "a step that turns disabled under focus hands it to the primary");
    await press("ArrowLeft");
    assert.equal(viewerTitle(), "Screenshot 1 of 4", "← on the first item stays put");
    assert.deepEqual(filmstrip().map((thumb) => thumb.textContent),
      ["Screenshot 1", "Screenshot 2", "Screenshot 3", "Screenshot 4"]);
    assert.equal(filmstrip()[0]!.getAttribute("aria-current"), "true");
    await act(async () => filmstrip()[3]!.click());
    assert.equal(viewerTitle(), "Screenshot 4 of 4", "a thumbnail jumps to its item");
    assert.equal(viewerButton("Next").disabled, true);
    // The footer's labels are Title Case; its foot-note is a sentence.
    assert.equal(viewer()?.querySelector(".ev-viewer-note")?.textContent, "0 of 4 reviewed");
    assert.equal(viewer()?.querySelector(".modal-foot input[type=checkbox]")?.closest("label")?.textContent, "Reviewed");
  } finally {
    await view.unmount();
  }
});

test("the viewer skips every item the grid shows as blocked", async () => {
  domWindow.localStorage.clear();
  const items = [
    ...screenshots(4),
    // An image type the card cannot draw (Can't Show, named "Screenshot 5") and one that is only a
    // link: neither is a viewer target.
    artifactItem({ evidenceId: "vector", artifactId: "art_vector", mediaType: "image/svg+xml" }),
    { evidenceId: "link-only", uri: "https://evidence.example/link.png", sha256: PNG_SHA },
  ];
  const view = await mount(sessionWith(items), async (artifactId) =>
    new Blob([artifactId === "art_3" ? Buffer.from("substituted") : PNG]));
  try {
    await view.decode("load");
    assert.equal(view.tile("viewport-3").querySelector(".ev-blocked-label")?.textContent, "Doesn't Match");
    assertNoDomNode(view.tile("viewport-3").querySelector(".ev-thumb"), "a blocked tile has nothing to open");
    await openTile(view, "viewport-2");
    assert.equal(viewerTitle(), "Screenshot 2 of 5");
    await press("ArrowRight");
    assert.equal(viewerTitle(), "Screenshot 4 of 5", "→ skips the item that doesn't match");
    await act(async () => viewerButton("Previous").click());
    assert.equal(viewerTitle(), "Screenshot 2 of 5", "Previous skips it too");
    assert.deepEqual(filmstrip().map((thumb) => thumb.dataset.evidenceId), ["viewport-1", "viewport-2", "viewport-4"],
      "the filmstrip holds only viewable items");
    await act(async () => viewerButton("Next").click());
    assert.equal(viewerButton("Next").disabled, true, "the link and the unshowable file come after nothing");
  } finally {
    await view.unmount();
  }
});

test("Mark Reviewed and Next marks the item, moves on and closes on the last, returning focus to its tile", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith(screenshots(4)), async () => new Blob([PNG]));
  try {
    await view.decode("load");
    await openTile(view, "viewport-3");
    assert.equal(viewerTitle(), "Screenshot 3 of 4");
    await act(async () => viewerButton("Mark Reviewed and Next").click());
    assert.equal(viewerTitle(), "Screenshot 4 of 4");
    assert.equal(view.container.querySelector(".ev-progress")?.textContent, "1 of 4 reviewed", "the grid counts it");
    assert.equal(view.checkbox("Screenshot 3")!.checked, true, "the tile's mark is the same mark");
    assert.equal(viewer()?.querySelector(".ev-viewer-note")?.textContent, "1 of 4 reviewed");
    const marked = filmstrip().find((thumb) => thumb.dataset.evidenceId === "viewport-3")!;
    assert.ok(marked.hasAttribute("data-reviewed"), "the filmstrip shows the mark");
    assert.ok(marked.querySelector(".ev-strip-mark"));
    assert.equal(marked.textContent, "Screenshot 3, Reviewed");
    assert.equal(domWindow.document.activeElement, viewerButton("Mark Reviewed and Next") as unknown as Element,
      "focus stays on the primary to review the next item");
    await act(async () => viewerButton("Mark Reviewed and Next").click());
    assertNoDomNode(viewer(), "the last item closes the viewer");
    assert.equal(view.container.querySelector(".ev-progress")?.textContent, "2 of 4 reviewed");
    await settleFocus();
    assert.equal(domWindow.document.activeElement, view.tile("viewport-4").querySelector(".ev-thumb"),
      "focus returns to the tile of the item last shown");

    // The viewer's Reviewed checkbox clears a mark as the tile's does.
    await openTile(view, "viewport-4");
    const reviewed = viewer()!.querySelector<HTMLInputElement>(".modal-foot input[type=checkbox]")!;
    assert.equal(reviewed.checked, true);
    await act(async () => reviewed.click());
    assert.equal(view.container.querySelector(".ev-progress")?.textContent, "1 of 4 reviewed");
  } finally {
    await view.unmount();
  }
});

test("closing the viewer after stepping returns focus to the tile of the item last shown", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith(screenshots(4)), async () => new Blob([PNG]));
  try {
    await view.decode("load");
    await openTile(view, "viewport-1");
    await press("ArrowRight");
    await press("ArrowRight");
    assert.equal(viewerTitle(), "Screenshot 3 of 4");
    await press("Escape");
    assertNoDomNode(viewer());
    await settleFocus();
    assert.equal(domWindow.document.activeElement, view.tile("viewport-3").querySelector(".ev-thumb"));
  } finally {
    await view.unmount();
  }
});

test("marks made in the viewer survive a reload", async () => {
  domWindow.localStorage.clear();
  const first = await mount(sessionWith(screenshots(4)), async () => new Blob([PNG]));
  try {
    await first.decode("load");
    await openTile(first, "viewport-1");
    await act(async () => viewerButton("Mark Reviewed and Next").click());
    await act(async () => viewerButton("Mark Reviewed and Next").click());
    assert.equal(viewerTitle(), "Screenshot 3 of 4");
  } finally {
    await first.unmount();
  }
  const reloaded = await mount(sessionWith(screenshots(4)), async () => new Blob([PNG]));
  try {
    await reloaded.decode("load");
    assert.equal(reloaded.container.querySelector(".ev-progress")?.textContent, "2 of 4 reviewed");
    assert.equal(reloaded.checkbox("Screenshot 1")!.checked, true);
    assert.equal(reloaded.checkbox("Screenshot 2")!.checked, true);
    assert.equal(reloaded.checkbox("Screenshot 3")!.checked, false);
    await openTile(reloaded, "viewport-2");
    assert.deepEqual(filmstrip().map((thumb) => thumb.hasAttribute("data-reviewed")), [true, true, false, false]);
  } finally {
    await reloaded.unmount();
    domWindow.localStorage.clear();
  }
});

test("stepping onto an item still loading keeps focus in the viewer, and closing there returns it to that tile", async () => {
  domWindow.localStorage.clear();
  // Screenshot 2's download is held, so the viewer moves onto an item it cannot show yet.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const view = await mount(sessionWith(screenshots(3)), async (artifactId) => {
    if (artifactId === "art_2") await held;
    return new Blob([PNG]);
  });
  try {
    await view.decode("load");
    await openTile(view, "viewport-1");
    const primary = viewerButton("Mark Reviewed and Next");
    assert.equal(domWindow.document.activeElement, primary as unknown as Element);
    await act(async () => primary.click());
    assert.equal(viewerTitle(), "Screenshot 2 of 3");
    assert.equal(viewer()?.querySelector(".ev-viewer-stage .ev-loading")?.textContent, "Loading…");
    assert.equal(primary.getAttribute("aria-disabled"), "true", "an item not shown yet cannot be marked");
    assert.equal(primary.disabled, false, "but the primary keeps focus rather than dropping it out of the dialog");
    assert.equal(domWindow.document.activeElement, primary as unknown as Element);
    await act(async () => primary.click());
    assert.equal(viewerTitle(), "Screenshot 2 of 3", "activating the unavailable primary does nothing");
    assert.equal(view.container.querySelector(".ev-progress")?.textContent, "1 of 3 reviewed");
    await press("ArrowLeft");
    assert.equal(viewerTitle(), "Screenshot 1 of 3", "the arrow keys still reach the viewer");
    await press("ArrowRight");
    await press("Escape");
    assertNoDomNode(viewer());
    await settleFocus();
    assert.equal(domWindow.document.activeElement, view.tile("viewport-2"),
      "focus returns to the loading item's own tile, not to the tile the viewer was opened from");
    release();
    for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  } finally {
    release();
    await view.unmount();
  }
});

test("an item that fails while the viewer shows it leaves the viewer, and its tile says why", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith(screenshots(2)), async () => new Blob([PNG]));
  try {
    await view.decode("load");
    await openTile(view, "viewport-2");
    const image = viewer()!.querySelector<HTMLImageElement>(".ev-viewer-stage img")!;
    await act(async () => { image.dispatchEvent(new domWindow.Event("error") as unknown as Event); });
    assertNoDomNode(viewer(), "bytes that cannot be drawn are never left on screen as evidence");
    assert.equal(view.tile("viewport-2").querySelector(".ev-blocked-label")?.textContent, "Can't Load");
    assertNoDomNode(view.checkbox("Screenshot 2"));
  } finally {
    await view.unmount();
  }
});
