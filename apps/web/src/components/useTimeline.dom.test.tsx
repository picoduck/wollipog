import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent } from "@wollipog/protocol";
import { useTimeline } from "./useTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(Object.keys(globals).map(
  (name) => [name, (globalThis as Record<string, unknown>)[name]],
));
before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const artifact = {
  artifactId: "art_replayed", sessionId: "s", kind: "screenshot" as const, name: "proof.png",
  mimeType: "image/png", encoding: "base64" as const, sizeBytes: 20,
  sha256: "a".repeat(64), createdBy: { kind: "agent" as const, id: "s" }, createdAt: 20,
};
const retained: SessionEvent = {
  id: 501, sessionId: "s", seq: 1, ts: 20, payload: { kind: "artifact_attached", artifact },
};
const beforeMessage: SessionEvent = {
  id: 502, sessionId: "s", seq: 2, ts: 10, payload: { kind: "user_message", text: "before" },
};
const afterEvent: SessionEvent = {
  id: 503, sessionId: "s", seq: 3, ts: 30, payload: { kind: "user_message", text: "after" },
};

function Timeline({ events }: { events: SessionEvent[] }) {
  const items = useTimeline("s", events);
  return <div>{items.map((item) => <span key={item.id}>{item.kind}:{item.id};</span>)}</div>;
}

test("an open transcript moves a retained attachment into replayed context without duplicating it", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Timeline events={[retained]} />));
    assert.equal(container.textContent, "artifact_attached:1;");

    await act(async () => root.render(<Timeline events={[retained, beforeMessage]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;");

    await act(async () => root.render(<Timeline events={[retained, beforeMessage, afterEvent]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");

    const live: SessionEvent = { id: 504, sessionId: "s", seq: 4, ts: 40,
      payload: { kind: "user_message", text: "live" } };
    await act(async () => root.render(<Timeline events={[retained, beforeMessage, afterEvent, live]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;user_message:4;");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
