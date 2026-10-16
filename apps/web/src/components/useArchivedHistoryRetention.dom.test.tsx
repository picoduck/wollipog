import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ARCHIVED_HISTORY_RETENTION_LIMITS, type ArchivedHistoryRetentionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import {
  ARCHIVED_HISTORY_RETENTION_STALE_MS,
  publishArchivedHistoryRetention,
  useArchivedHistoryRetention,
} from "./useArchivedHistoryRetention.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Node: domWindow.Node,
  React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

afterEach(() => mock.timers.reset());

function view(retentionDays: number | null): ArchivedHistoryRetentionView {
  return {
    retentionDays, source: "organization", environmentDays: null, canManage: true, prunesFrom: retentionDays === null ? null : 1,
    nextRunAt: null, eligible: { sessions: 0, events: 0 }, lastRun: null, limits: ARCHIVED_HISTORY_RETENTION_LIMITS,
  };
}

/** A server whose reads wait until the test answers them, one at a time. */
function server() {
  const reads: Array<{ resolve: (next: ArchivedHistoryRetentionView) => void; reject: (cause: Error) => void }> = [];
  const client = {
    ...api,
    archivedHistoryRetention: () => new Promise<ArchivedHistoryRetentionView>((resolve, reject) => { reads.push({ resolve, reject }); }),
  } as unknown as ApiClient;
  return { client, reads };
}

const flush = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });

async function mountReaders(client: ApiClient, count: number) {
  const seen: Array<Array<number | null | undefined>> = Array.from({ length: count }, () => []);
  function Reader({ index }: { index: number }) {
    seen[index]!.push(useArchivedHistoryRetention(true)?.retentionDays);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (mounted: number) => act(async () => root.render(
    <ApiProvider client={client}>{Array.from({ length: mounted }, (_, index) => <Reader key={index} index={index} />)}</ApiProvider>,
  ));
  return {
    render,
    latest: (index: number) => seen[index]!.at(-1),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a read that started before a published policy never replaces it", async () => {
  const { client, reads } = server();
  const ui = await mountReaders(client, 2);
  try {
    await ui.render(1);
    assert.equal(reads.length, 1, "an archived transcript reads the policy");
    // Settings › Storage saves while that read is still out.
    await act(async () => publishArchivedHistoryRetention(client, view(30)));
    assert.equal(ui.latest(0), 30);
    reads[0]!.resolve(view(90));
    await flush();
    assert.equal(ui.latest(0), 30, "the older answer is discarded");
    await ui.render(2);
    assert.equal(ui.latest(1), 30, "a reader mounted later starts from the newer policy");
  } finally {
    await ui.unmount();
  }
});

test("an open reader reads the policy again once it is stale, and retries a failed read", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.UTC(2026, 9, 16) });
  const { client, reads } = server();
  const ui = await mountReaders(client, 1);
  try {
    await ui.render(1);
    reads[0]!.reject(new Error("502 Bad Gateway"));
    await flush();
    assert.equal(ui.latest(0), undefined, "a failed read says nothing about pruning");

    await act(async () => mock.timers.tick(ARCHIVED_HISTORY_RETENTION_STALE_MS + 15_000));
    assert.equal(reads.length, 2, "the failed read is retried while the reader stays open");
    reads[1]!.resolve(view(90));
    await flush();
    assert.equal(ui.latest(0), 90);

    await act(async () => mock.timers.tick(ARCHIVED_HISTORY_RETENTION_STALE_MS / 2));
    assert.equal(reads.length, 2, "a fresh policy is not read again");
    // Another owner turns retention off.
    await act(async () => mock.timers.tick(ARCHIVED_HISTORY_RETENTION_STALE_MS));
    assert.equal(reads.length, 3, "a stale policy is read again without remounting");
    reads[2]!.resolve(view(null));
    await flush();
    assert.equal(ui.latest(0), null);
  } finally {
    await ui.unmount();
  }
});
