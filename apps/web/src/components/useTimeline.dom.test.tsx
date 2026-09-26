import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent } from "@wollipog/protocol";
import { ApiProvider } from "../api-context.js";
import { ApiError } from "../api.js";
import { TransportRequestError } from "../api-transport.js";
import type { ApiClient } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { useTimeline } from "./useTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  IS_REACT_ACT_ENVIRONMENT: true, React,
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
const retainedClient = {
  getRetainedAttachmentEventPage: async (_id: string, _after: number, eventEpoch: number) => ({
    events: [retained], eventEpoch, nextAfter: 1, hasMore: false,
  }),
} as unknown as ApiClient;

function Timeline({ events, eventEpoch = 1, onItems }: {
  events: SessionEvent[]; eventEpoch?: number; onItems?: (items: TimelineItem[]) => void;
}) {
  const items = useTimeline("s", events, eventEpoch);
  onItems?.(items);
  return <div>{items.map((item) => <span key={item.id}>{item.kind}:{item.id};</span>)}</div>;
}

function ReplayTimeline(props: Parameters<typeof Timeline>[0]) {
  return <ApiProvider client={retainedClient}><Timeline {...props} /></ApiProvider>;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for retained attachment retry");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
}

test("an open transcript moves a retained attachment into replayed context without duplicating it", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ReplayTimeline events={[retained]} />));
    assert.equal(container.textContent, "artifact_attached:1;");

    await act(async () => root.render(<ReplayTimeline events={[retained, beforeMessage]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;");

    await act(async () => root.render(<ReplayTimeline events={[retained, beforeMessage, afterEvent]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");

    const live: SessionEvent = { id: 504, sessionId: "s", seq: 4, ts: 40,
      payload: { kind: "user_message", text: "live" } };
    await act(async () => root.render(<ReplayTimeline events={[retained, beforeMessage, afterEvent, live]} />));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;user_message:4;");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("replay appends preserve existing runner row objects while the attachment moves", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let latest: TimelineItem[] = [];
  const replay: SessionEvent[] = Array.from({ length: 20 }, (_, offset) => ({
    id: 600 + offset, sessionId: "s", seq: 3 + offset, ts: 11 + offset,
    payload: { kind: "user_message", text: `replayed ${offset}` },
  }));
  try {
    await act(async () => root.render(<ReplayTimeline events={[retained, beforeMessage]} onItems={(items) => { latest = items; }} />));
    const firstRunnerRow = latest.find((item) => item.id === 2);
    assert.ok(firstRunnerRow);
    for (let index = 0; index < 20; index++) {
      await act(async () => root.render(<ReplayTimeline events={[retained, beforeMessage, ...replay.slice(0, index + 1)]}
        onItems={(items) => { latest = items; }} />));
      assert.equal(latest.find((item) => item.id === 2), firstRunnerRow);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a bounded fresh tail includes a retained attachment outside the ordinary event window", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={retainedClient}>
      <Timeline events={[beforeMessage, afterEvent]} />
    </ApiProvider>));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");
    await act(async () => root.render(<ApiProvider client={retainedClient}>
      <Timeline events={[retained, beforeMessage, afterEvent]} />
    </ApiProvider>));
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;",
      "later paging in the original event must not duplicate its supplemental row");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a live attachment added before hydration keeps its sequence position", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const live: SessionEvent = { ...retained, id: 504, seq: 2, ts: 5,
    payload: { kind: "artifact_attached", artifact: { ...artifact, artifactId: "art_live" } } };
  const runner: SessionEvent = { ...beforeMessage, seq: 3, ts: 10 };
  try {
    await act(async () => root.render(<ReplayTimeline events={[retained, live, runner]} />));
    assert.equal(container.textContent, "artifact_attached:2;user_message:3;artifact_attached:1;");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a transient network failure retries the same retained page without duplicating its row", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(container);
  const cursors: number[] = [];
  const client = {
    getRetainedAttachmentEventPage: async (_id: string, after: number, eventEpoch: number) => {
      cursors.push(after);
      if (cursors.length === 1) throw new TypeError("network unavailable");
      return { events: [retained], eventEpoch, nextAfter: 1, hasMore: false };
    },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(<ApiProvider client={client}>
      <Timeline events={[beforeMessage, afterEvent]} />
    </ApiProvider>));
    assert.equal(container.textContent, "user_message:2;user_message:3;");
    await waitFor(() => cursors.length === 2 && container.textContent?.includes("artifact_attached:1;") === true);
    assert.deepEqual(cursors, [0, 0]);
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a 5xx on a later retained page retries its cursor and preserves earlier rows", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(container);
  const cursors: number[] = [];
  const client = {
    getRetainedAttachmentEventPage: async (_id: string, after: number, eventEpoch: number) => {
      cursors.push(after);
      if (after === 1 && cursors.length === 2) throw new ApiError("temporary", 503);
      return after === 0
        ? { events: [retained], eventEpoch, nextAfter: 1, hasMore: true }
        : { events: [], eventEpoch, nextAfter: 1, hasMore: false };
    },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(<ApiProvider client={client}>
      <Timeline events={[beforeMessage, afterEvent]} />
    </ApiProvider>));
    await waitFor(() => cursors.length === 3 && container.textContent?.includes("artifact_attached:1;") === true);
    assert.deepEqual(cursors, [0, 1, 1]);
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");
  } finally {
    await act(async () => root.unmount());
  }
});

test("permanent retained-page errors do not retry", async () => {
  for (const status of [401, 403, 404, 409]) {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    const root = createRoot(container);
    let calls = 0;
    const client = {
      getRetainedAttachmentEventPage: async () => { calls++; throw new ApiError("permanent", status); },
    } as unknown as ApiClient;
    try {
      await act(async () => root.render(<ApiProvider client={client}>
        <Timeline events={[beforeMessage, afterEvent]} />
      </ApiProvider>));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      assert.equal(calls, 1, `HTTP ${status} must not retry`);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test("a native transport request failure retries while a generic error stops", async () => {
  for (const error of [new TransportRequestError("connection reset"), new Error("invalid response")]) {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    const root = createRoot(container);
    let calls = 0;
    const client = {
      getRetainedAttachmentEventPage: async (_id: string, _after: number, eventEpoch: number) => {
        calls++;
        if (calls === 1) throw error;
        return { events: [retained], eventEpoch, nextAfter: 1, hasMore: false };
      },
    } as unknown as ApiClient;
    try {
      await act(async () => root.render(<ApiProvider client={client}>
        <Timeline events={[beforeMessage, afterEvent]} />
      </ApiProvider>));
      if (error instanceof TransportRequestError) {
        await waitFor(() => calls === 2 && container.textContent?.includes("artifact_attached:1;") === true);
        assert.equal(calls, 2);
      } else {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
        assert.equal(calls, 1);
      }
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test("unmount cancels a pending retained-page retry", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(container);
  let calls = 0;
  let signal: AbortSignal | undefined;
  const client = {
    getRetainedAttachmentEventPage: async (_id: string, _after: number, _epoch: number,
      _limit: number, requestSignal: AbortSignal) => {
      calls++;
      signal = requestSignal;
      throw new TypeError("network unavailable");
    },
  } as unknown as ApiClient;
  await act(async () => root.render(<ApiProvider client={client}>
    <Timeline events={[beforeMessage, afterEvent]} />
  </ApiProvider>));
  await act(async () => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("retained-page retries stop after their bounded backoff budget", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(container);
  let calls = 0;
  const client = {
    getRetainedAttachmentEventPage: async () => { calls++; throw new ApiError("temporary", 500); },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(<ApiProvider client={client}>
      <Timeline events={[beforeMessage, afterEvent]} />
    </ApiProvider>));
    await waitFor(() => calls === 4);
    assert.equal(calls, 4, "the initial request and three retries exhaust the budget");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 4, "exhaustion must not start another retry loop");
  } finally {
    await act(async () => root.unmount());
  }
});

test("an epoch change cancels an old retry and fetches the new epoch", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(container);
  const epochs: number[] = [];
  const signals: AbortSignal[] = [];
  const client = {
    getRetainedAttachmentEventPage: async (_id: string, _after: number, eventEpoch: number,
      _limit: number, signal: AbortSignal) => {
      epochs.push(eventEpoch);
      signals.push(signal);
      if (eventEpoch === 1) throw new TypeError("network unavailable");
      return { events: [retained], eventEpoch, nextAfter: 1, hasMore: false };
    },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(<ApiProvider client={client}>
      <Timeline events={[beforeMessage, afterEvent]} eventEpoch={1} />
    </ApiProvider>));
    await act(async () => root.render(<ApiProvider client={client}>
      <Timeline events={[beforeMessage, afterEvent]} eventEpoch={2} />
    </ApiProvider>));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(epochs, [1, 2]);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(container.textContent, "user_message:2;artifact_attached:1;user_message:3;");
  } finally {
    await act(async () => root.unmount());
  }
});
