import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPromptHistoryPage } from "@wollipog/protocol";
import { ComposerHistory, type ComposerHistoryPrompt } from "./composer-history.js";

const event = (seq: number, text = `prompt ${seq}`): ComposerHistoryPrompt => ({ key: `event:${seq}`, seq, text });
const page = (seqs: number[], hasMore = false): SessionPromptHistoryPage => ({
  prompts: seqs.map(seq => ({ seq, text: `prompt ${seq}` })), nextBefore: seqs[0],
  eventEpoch: 0, hasMore, cacheComplete: true,
});

test("recall crosses prompt-only pages, deduplicates event identities, and keeps repeated text", async () => {
  const history = new ComposerHistory();
  const calls: Array<number | undefined> = [];
  const read = async (before: number | undefined) => {
    calls.push(before);
    return before === undefined ? page([3, 5], true) : { ...page([1]), prompts: [{ seq: 1, text: "prompt 3" }] };
  };
  const local = [event(5)];
  assert.equal(history.previous(local, read), "prompt 5");
  assert.equal(await history.previous(local, read), "prompt 3");
  assert.equal(await history.previous(local, read), "prompt 3", "same text from a distinct message stays recallable");
  assert.equal(await history.previous(local, read), undefined, "oldest entry clamps");
  assert.equal(history.next(local), "prompt 3");
  assert.equal(history.next(local), "prompt 5");
  assert.equal(history.next(local), "");
  assert.deepEqual(calls, [undefined, 3]);
});

test("prepended transcript pages and new live messages preserve the selected identity", async () => {
  const history = new ComposerHistory();
  const read = async () => page([1, 3, 5]);
  assert.equal(history.previous([event(5)], read), "prompt 5");
  assert.equal(await history.previous([event(5)], read), "prompt 3");
  const changed = [event(1), event(3), event(5), event(7)];
  assert.equal(await history.previous(changed, read), "prompt 1");
  assert.equal(history.next(changed), "prompt 3");
  assert.equal(history.next(changed), "prompt 5");
  assert.equal(history.next(changed), "prompt 7");
  history.reset();
  assert.equal(history.previous(changed, read), "prompt 7");
});

test("late responses cannot overwrite typing, a session change, or a newer navigation", async () => {
  for (const cancel of ["reset", "down"] as const) {
    const history = new ComposerHistory();
    let release!: (value: SessionPromptHistoryPage) => void;
    const read = () => new Promise<SessionPromptHistoryPage>(resolve => { release = resolve; });
    assert.equal(history.previous([event(5)], read), "prompt 5");
    const pending = history.previous([event(5)], read);
    if (cancel === "reset") history.reset();
    else assert.equal(history.next([event(5)]), "");
    release(page([1, 5]));
    assert.equal(await pending, undefined);
  }
});

test("failed and incomplete reads retain position and remain retryable", async () => {
  const history = new ComposerHistory();
  assert.equal(history.previous([event(5)], async () => page([])), "prompt 5");
  await assert.rejects(Promise.resolve(history.previous([], async () => { throw new Error("offline"); })), /offline/);
  await assert.rejects(Promise.resolve(history.previous([], async () => ({ ...page([]), cacheComplete: false }))), /still loading/);
  assert.equal(await history.previous([], async () => page([1, 5])), "prompt 1");
});

test("queued prompt promotion removes only the exact queue identity, including an unloaded event", async () => {
  const history = new ComposerHistory();
  const queued = { key: "queue:q1", queueId: "q1", text: "prompt 5" };
  const local = [event(3), queued];
  const read = async () => ({ ...page([1, 3, 5]), prompts: [
    { seq: 1, text: "prompt 1" }, { seq: 3, text: "prompt 3" },
    { seq: 5, text: "prompt 5", submissionId: "submission-1" },
  ] });
  assert.equal(history.previous(local, read), "prompt 5");
  assert.equal(await history.previous(local, read, new Map([["submission-1", "q1"]])), "prompt 3");
  assert.equal(history.next(local), "prompt 5");
  assert.equal(history.next(local), "", "the promoted queue is not reinserted as a duplicate");
});

test("empty prompts do not stop paging or corrupt the boundary cursor", async () => {
  const history = new ComposerHistory();
  const calls: Array<number | undefined> = [];
  assert.equal(await history.previous([], async before => {
    calls.push(before);
    return before === undefined ? { ...page([3], true), prompts: [{ seq: 3, text: "" }] } : page([1]);
  }), "prompt 1");
  assert.deepEqual(calls, [undefined, 3]);
});

test("a locally delivered queued message replaces its queue identity without a history read", () => {
  const history = new ComposerHistory();
  const read = async () => page([]);
  assert.equal(history.previous([{ key: "queue:q1", queueId: "q1", text: "prompt 5" }], read), "prompt 5");
  const local = [{ ...event(5), queueId: "q1" }, event(7)];
  assert.equal(history.next(local), "prompt 7");
  assert.equal(history.next(local), "");
});
