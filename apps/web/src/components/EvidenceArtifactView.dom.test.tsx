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
const RESOURCE_DIGEST = "b".repeat(64);

type Evidence = { evidenceId: string; uri: string; sha256: string; artifactId?: string; mediaType?: string };

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
  return {
    container, requests, button, checkbox,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("artifact-backed evidence is shown in place, verified against the decision digest, and replaces the external link", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith([artifactItem()]), async () => new Blob([PNG], { type: "application/octet-stream" }));
  try {
    assert.deepEqual(view.requests, ["art_desktop"]);
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
    assert.ok(flaky.container.querySelector(".evidence-artifact img"), "the retry loads and verifies the artifact");
    assert.equal(flaky.checkbox("desktop-after").disabled, false);
  } finally {
    await flaky.unmount();
  }
});

test("URI-only, video, and non-raster evidence keep a labelled external link, and mixed decisions show both", async () => {
  domWindow.localStorage.clear();
  const view = await mount(sessionWith([
    artifactItem(),
    { evidenceId: "legacy", uri: "https://evidence.example/legacy.png", sha256: "1".repeat(64) },
    artifactItem({ evidenceId: "clip", artifactId: "art_clip", mediaType: "video/webm" }),
    artifactItem({ evidenceId: "vector", artifactId: "art_svg", mediaType: "image/svg+xml" }),
  ]), async () => new Blob([PNG]));
  try {
    assert.deepEqual(view.requests, ["art_desktop"], "only a renderable raster artifact is fetched");
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
