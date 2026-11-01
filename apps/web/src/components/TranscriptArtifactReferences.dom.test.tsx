import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  IntersectionObserver: undefined,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 3]);
const shot = (id: string, sessionId = "session_1"): WorkflowArtifactView => ({
  artifactId: id, sessionId, kind: "screenshot", name: `${id.slice(4, 8)}.png`, mimeType: "image/png", encoding: "base64",
  sizeBytes: PNG.byteLength, sha256: createHash("sha256").update(PNG).digest("hex"),
  createdBy: { kind: "agent", id: sessionId }, createdAt: 1,
});

const A = "art_aaaaaaaaaaaa";
const B = "art_bbbbbbbbbbbb";
const C = "art_cccccccccccc";
const D = "art_dddddddddddd";
const E = "art_eeeeeeeeeeee";

let root: Root | null = null;
let container: HTMLElement | null = null;
const listed: Array<string | undefined> = [];
const exported: string[] = [];
const priorList = api.sessionWorkflowArtifacts;
const priorExport = api.artifactExport;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  listed.length = 0;
  exported.length = 0;
  api.sessionWorkflowArtifacts = priorList;
  api.artifactExport = priorExport;
  domWindow.document.body.replaceChildren();
});

/** The session's list, two pages; C is another session's and never listed here. */
const PAGES: Record<string, WorkflowArtifactPage> = {
  first: { artifacts: [shot(A), shot(D)], nextCursor: "2" },
  "2": { artifacts: [shot(B), shot(E)] },
};

async function render(items: TimelineItem[], session: string | null = "session_1") {
  const artifactSessionId = session ?? undefined;
  api.sessionWorkflowArtifacts = async (_session, cursor) => {
    listed.push(cursor);
    return PAGES[cursor ?? "first"]!;
  };
  api.artifactExport = async (id) => {
    exported.push(id);
    return new Blob([PNG], { type: "image/png" });
  };
  container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  root = createRoot(container);
  await act(async () => {
    root!.render(<EventTimeline items={items} historyKey="session_1:0" artifactSessionId={artifactSessionId} />);
  });
  for (let pass = 0; pass < 4; pass++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

let nextId = 1;
const prompt = (text: string): TimelineItem => ({ kind: "user_message", id: nextId++, text, createdAt: nextId });
const reply = (text: string): TimelineItem => ({ kind: "agent_message", id: nextId++, text, createdAt: nextId });
const attached = (artifact: WorkflowArtifactView): TimelineItem =>
  ({ kind: "artifact_attached", id: nextId++, artifact, createdAt: nextId });

const reply$ = () => [...container!.querySelectorAll<HTMLElement>(".tl-agent-msg")].at(-1)!;
const chips = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>(".art-ref")];
const dialog = () => domWindow.document.querySelector("[role='dialog']") as unknown as HTMLElement | null;

test("cited ids of the session's artifacts become chips; others, and fenced code, stay as written", async () => {
  nextId = 1;
  await render([
    prompt("Capture it."),
    attached(shot(A)),
    prompt("Which captures did you take?"),
    reply([
      `The first was \`${A}\`, the second ${B}.`,
      `Not mine: ${C}.`,
      "```json",
      `{ "artifactId": "${D}" }`,
      "```",
    ].join("\n")),
  ]);
  const message = reply$();
  assert.deepEqual(chips(message).map((chip) => chip.textContent), ["aaaa.png", "bbbb.png"]);
  assert.match(message.textContent ?? "", new RegExp(`Not mine: ${C}\\.`), "an id no session artifact matches stays text");
  assert.match(message.querySelector("pre")?.textContent ?? "", new RegExp(D), "fenced code is unchanged");
  assert.ok(!chips(message).some((chip) => chip.dataset.artifactId === D));
  assert.deepEqual(listed, [undefined, "2"], "the list was read only as far as the cited ids needed");
});

test("a chip opens the viewer on its artifact, stepping through the reply's cited artifacts", async () => {
  nextId = 1;
  await render([prompt("Show me."), reply(`See ${A} and ${B}.`)]);
  const [first] = chips(reply$());
  await act(async () => { first!.click(); });
  assert.ok(dialog(), "the viewer opened");
  assert.equal(dialog()!.querySelector(".art-gallery-position")?.textContent, "1 of 2");
  const next = [...dialog()!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!;
  await act(async () => { next.click(); });
  assert.equal(dialog()!.querySelector(".art-gallery-position")?.textContent, "2 of 2");
});

test("a cited artifact the turn did not attach previews under the reply; one it attached is not shown twice", async () => {
  nextId = 1;
  await render([prompt("Capture it."), attached(shot(A)), reply(`Attached ${A}; the earlier one was ${B}.`)]);
  const previews = [...reply$().querySelectorAll<HTMLElement>(".tl-artifact-refs .tl-artifact")];
  assert.deepEqual(previews.map((card) => card.dataset.artifactId), [B], "only the artifact the turn did not attach");
  assert.equal(container!.querySelectorAll(`.tl-artifact[data-artifact-id='${A}']`).length, 1, "the attachment shows once");
});

test("cited artifacts share the turn's preview limit, and the rest are one counted View All", async () => {
  nextId = 1;
  await render([
    prompt("Capture all of them."),
    attached(shot("art_111111111111")),
    attached(shot("art_222222222222")),
    reply(`Compare with ${A}, ${B} and ${D}.`),
  ]);
  const refs = reply$().querySelector(".tl-artifact-refs")!;
  assert.equal(refs.querySelectorAll(".tl-artifact:not(.tl-artifact-more)").length, 1, "two attachments leave one preview");
  const viewAll = [...refs.querySelectorAll("button")].find((button) => /View All 3 Artifacts/.test(button.textContent ?? ""));
  assert.ok(viewAll, refs.textContent ?? "");
  // Only drawn previews load bytes; resolving a reference never does.
  assert.ok(!exported.includes(B) && !exported.includes(D), `exported ${exported.join(", ")}`);
});

test("without a session, as in a public shared transcript, ids stay text and nothing is looked up", async () => {
  nextId = 1;
  await render([prompt("Show me."), reply(`See ${A}.`)], null);
  assert.equal(chips(reply$()).length, 0);
  assert.match(reply$().textContent ?? "", new RegExp(`See ${A}\\.`));
  assert.deepEqual(listed, []);
});
