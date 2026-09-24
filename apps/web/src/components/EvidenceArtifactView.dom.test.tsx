import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { saveEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { EvidenceArtifactView, type EvidenceArtifactStatus } from "./EvidenceArtifactView.js";
import { SessionRequestPanel, sessionRequestPanelKey } from "./SessionRequestPanel.js";

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
      <SessionRequestPanel
        session={session}
        runnerOnline
        descendants={[]}
        selectedKey={sessionRequestPanelKey(session.id, session.pendingApproval!.occurrenceId!)}
        onSelectedKeyChange={() => {}}
        onSessionUpdate={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>,
  ));
  // Fetch, digest, and the state update each settle on their own turn.
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".evidence-review-actions button")]
    .find((candidate) => candidate.textContent === name)!;
  const checkbox = (evidenceId: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Mark ${evidenceId} as Reviewed"]`)!;
  // happy-dom never decodes an image, so the browser's verdict is delivered by hand: "load" for a
  // picture it could draw, "error" for bytes it could not.
  const decode = async (verdict: "load" | "error") => {
    for (const image of container.querySelectorAll<HTMLImageElement>(".evidence-artifact img")) {
      await act(async () => { image.dispatchEvent(new domWindow.Event(verdict) as unknown as Event); });
    }
  };
  return {
    container, requests, button, checkbox, decode,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("artifact-backed evidence is shown in place, verified against the decision digest, and replaces the external link", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG], { type: "application/octet-stream" }));
  try {
    assert.deepEqual(view.requests, ["art_desktop"]);
    // A digest match says the file is the one the request names, not that it is a picture. Until
    // the browser has drawn it, nothing is visible and nothing can be marked reviewed.
    assert.equal(view.container.querySelector<HTMLButtonElement>(".evidence-artifact-thumb")?.hidden, true);
    assert.equal(view.checkbox("desktop-after").disabled, true, "a verified but undrawn image is not yet shown");
    assert.match(view.container.querySelector('.evidence-artifact [role="status"]')?.textContent ?? "", /Loading evidence/u);
    await view.decode("load");
    assert.equal(view.container.querySelector<HTMLButtonElement>(".evidence-artifact-thumb")?.hidden, false);
    const image = view.container.querySelector<HTMLImageElement>(".evidence-artifact img");
    assert.ok(image, "the verified artifact is rendered inside the card");
    assert.equal(image.getAttribute("alt"), "Evidence: desktop-after");
    assert.match(image.getAttribute("src") ?? "", /^blob:/u, "bytes stay in memory behind an object URL");
    assert.equal(view.container.querySelector('a[href^="https://evidence.example"]'), null,
      "an artifact-backed item never sends the reviewer to the external copy");
    assert.doesNotMatch(view.container.innerHTML, /signature=secret/u);
    assert.equal(view.container.querySelector(".evidence-artifact-thumb")?.getAttribute("aria-label"),
      "Enlarge Evidence: desktop-after");
    assert.equal(view.checkbox("desktop-after").disabled, false, "a shown image can be marked reviewed");
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
    assert.equal(view.container.querySelector(".evidence-artifact img")?.getAttribute("alt"), "Evidence: desktop-after");
    assert.equal(view.container.querySelector(".evidence-review-item a"), null);
    assert.equal(view.checkbox("desktop-after").disabled, false);
    await act(async () => view.checkbox("desktop-after").click());
    assert.equal(view.button("Approve").disabled, false);
  } finally {
    await view.unmount();
  }
});

test("artifact-backed video plays inline only after digest and browser metadata checks", async () => {
  domWindow.localStorage.clear();
  const item = { evidenceId: "clip", artifactId: "art_clip", mediaType: "video/webm", sha256: WEBM_SHA };
  const view = await mount(sessionWith([item]), async () => new Blob([WEBM], { type: "video/webm" }));
  try {
    assert.deepEqual(view.requests, ["art_clip"]);
    const video = view.container.querySelector<HTMLVideoElement>(".evidence-artifact-video");
    assert.ok(video);
    assert.equal(video.hidden, true);
    assert.equal(view.checkbox("clip").disabled, true);
    await act(async () => video.dispatchEvent(new domWindow.Event("loadedmetadata") as unknown as Event));
    assert.equal(video.hidden, false);
    assert.equal(video.hasAttribute("controls"), true);
    assert.equal(video.hasAttribute("playsinline"), true);
    assert.equal(view.checkbox("clip").disabled, false);
    assert.equal(view.container.querySelector(".evidence-review-item a"), null);
    await act(async () => view.checkbox("clip").click());
    assert.equal(view.button("Approve").disabled, false);
  } finally { await view.unmount(); }
});

test("a digest mismatch or an unavailable artifact shows no image and cannot count as reviewed", async () => {
  domWindow.localStorage.clear();
  // A mark saved on an earlier visit must not survive the artifact turning out to be wrong.
  saveEvidenceReviewDraft("local", "session-artifact-evidence", "occurrence-1", RESOURCE_DIGEST, ["desktop-after"]);
  const swapped = await mount(sessionWith([artifactItem()]), async () => new Blob([Buffer.from("substituted")]));
  try {
    assert.equal(swapped.container.querySelector(".evidence-artifact img"), null, "mismatched bytes are never displayed");
    assert.match(swapped.container.querySelector('.evidence-artifact [role="alert"]')?.textContent ?? "",
      /does not match the digest recorded in the request/u);
    assert.equal(swapped.checkbox("desktop-after").disabled, true);
    assert.equal(swapped.checkbox("desktop-after").checked, false, "the saved mark is not shown as a review");
    assert.equal(swapped.button("Approve").disabled, true, "the saved mark cannot approve unseen evidence");
    assert.equal(swapped.button("Deny").disabled, false, "the reviewer can still reject");
  } finally {
    await swapped.unmount();
  }

  const gone = await mount(sessionWith([artifactItem()]), async () => { throw new ApiError("artifact not found", 404); });
  try {
    const alert = gone.container.querySelector('.evidence-artifact [role="alert"]');
    assert.match(alert?.textContent ?? "", /no longer available, or you do not have access/u,
      "a missing or forbidden artifact reads differently from a bad capture");
    assert.equal(alert?.querySelector("button"), null, "access and absence do not change on a retry");
    assert.equal(gone.checkbox("desktop-after").disabled, true);
    assert.equal(gone.container.querySelector('a[href^="https://evidence.example"]'), null,
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
    assert.match(undrawable.container.querySelector('.evidence-artifact [role="alert"]')?.textContent ?? "",
      /matches its recorded digest but could not be displayed as an image/u);
    assert.equal(undrawable.container.querySelector(".evidence-artifact img"), null, "no broken image is left on screen");
    assert.equal(undrawable.container.querySelector('.evidence-artifact [role="alert"] button'), null,
      "the same bytes will not decode on a retry");
    assert.equal(undrawable.checkbox("desktop-after").disabled, true);
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
    await act(async () => regressed.checkbox("desktop-after").click());
    assert.equal(regressed.button("Approve").disabled, false, "a shown and marked item enables approval");
    await regressed.decode("error");
    assert.equal(regressed.container.querySelector(".evidence-artifact img"), null);
    assert.equal(regressed.checkbox("desktop-after").disabled, true);
    assert.equal(regressed.checkbox("desktop-after").checked, false, "the earlier mark no longer reads as a review");
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
    const retry = flaky.container.querySelector<HTMLButtonElement>('.evidence-artifact [role="alert"] button');
    assert.equal(retry?.textContent, "Retry", "a transport failure can be retried");
    await act(async () => retry!.click());
    for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await flaky.decode("load");
    assert.ok(flaky.container.querySelector(".evidence-artifact img"), "the retry loads and verifies the artifact");
    assert.equal(flaky.checkbox("desktop-after").disabled, false);
  } finally {
    await flaky.unmount();
  }
});

test("URI-only and non-raster evidence keep a labelled external link, and mixed decisions show both", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith([
    artifactItem(),
    { evidenceId: "legacy", uri: "https://evidence.example/legacy.png", sha256: "1".repeat(64) },
    { evidenceId: "clip", uri: "https://evidence.example/clip.webm", sha256: "2".repeat(64), mediaType: "video/webm" },
    artifactItem({ evidenceId: "vector", artifactId: "art_svg", mediaType: "image/svg+xml" }),
  ]), async () => new Blob([PNG]));
  try {
    assert.deepEqual(view.requests, ["art_desktop"], "only a renderable raster artifact is fetched");
    await view.decode("load");
    assert.equal(view.container.querySelectorAll(".evidence-artifact").length, 1);
    for (const evidenceId of ["legacy", "clip", "vector"]) {
      const link = view.container.querySelector(`a[aria-label="View External Evidence: ${evidenceId}"]`);
      assert.ok(link, `${evidenceId} keeps an external link, labelled as external`);
      assert.equal(view.checkbox(evidenceId).disabled, false, `${evidenceId} is reviewable as before`);
    }
    // Every item reviewed, and only then, enables approval.
    for (const evidenceId of ["desktop-after", "legacy", "clip"]) await act(async () => view.checkbox(evidenceId).click());
    assert.equal(view.button("Approve").disabled, true);
    await act(async () => view.checkbox("vector").click());
    assert.equal(view.button("Approve").disabled, false);
  } finally {
    await view.unmount();
  }
});

test("without SubtleCrypto the artifact is not shown unverified and the reviewer gets the external link", async () => {
  domWindow.localStorage.clear();
  const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle") ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle")!;
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: undefined });
  try {
    const view = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG]));
    try {
      assert.equal(view.container.querySelector(".evidence-artifact img"), null, "unchecked bytes are not displayed");
      assert.match(view.container.querySelector(".evidence-artifact")?.textContent ?? "", /require HTTPS or localhost/u);
      assert.ok(view.container.querySelector('a[aria-label="View External Evidence: desktop-after"]'));
      assert.equal(view.checkbox("desktop-after").disabled, false, "review stays possible through the external copy");
    } finally {
      await view.unmount();
    }
  } finally {
    Object.defineProperty(globalThis.crypto, "subtle", subtle);
  }
});

test("an artifact-only item without SubtleCrypto cannot be approved unseen", async () => {
  domWindow.localStorage.clear();
  const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle") ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle")!;
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: undefined });
  try {
    const { uri: _externalCopy, ...item } = artifactItem();
    const view = await mount(sessionWith([item]), async () => new Blob([PNG]));
    try {
      assert.equal(view.container.querySelector(".evidence-artifact img"), null);
      assert.equal(view.container.querySelector(".evidence-artifact a"), null);
      assert.equal(view.checkbox("desktop-after").disabled, true);
      assert.equal(view.button("Approve").disabled, true);
      assert.equal(view.button("Deny").disabled, false);
    } finally {
      await view.unmount();
    }
  } finally {
    Object.defineProperty(globalThis.crypto, "subtle", subtle);
  }
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
          onStatusChange={(_evidenceId, status) => { reports.push(status); }}
        />
      </ApiProvider>,
    ));
    for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const image = container.querySelector<HTMLImageElement>(".evidence-artifact img")!;
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
    assert.equal(container.querySelector(".evidence-artifact img"), null);

    // An error with nothing to fail is ignored by the component and must not be reported either.
    const before = reports.length;
    await act(async () => { container.querySelector(".evidence-artifact")!.dispatchEvent(new domWindow.Event("error") as unknown as Event); });
    assert.equal(reports.length, before);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
