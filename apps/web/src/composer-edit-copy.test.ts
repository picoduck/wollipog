import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  clearComposerEditCopy,
  composerEditCopySending,
  finishComposerEditCopySend,
  forgetComposerEditCopiesForInstance,
  loadComposerEditCopy,
  markComposerEditCopySending,
  parseComposerEditCopy,
  saveComposerEditCopy,
  type ComposerEditCopy,
} from "./composer-edit-copy.js";

/** A localStorage that can be told to refuse writes, as a full quota does. */
class MemoryStorage {
  values = new Map<string, string>();
  refuse = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.refuse) throw new Error("QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

let storage: MemoryStorage;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const COPY: ComposerEditCopy = {
  id: "copy-1",
  turn: 3,
  previous: { text: "my own draft", images: [{ mimeType: "image/png", data: "bWluZQ==" }] },
};

test("a copy outlives the page's memory in storage, as across a reload", () => {
  saveComposerEditCopy("s1", COPY, "instance-a");
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), COPY);
  forgetComposerEditCopiesForInstance("instance-a");
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), COPY, "the stored copy comes back after a reload");
  assert.equal(loadComposerEditCopy("s1", "instance-b"), null, "another instance never sees it");
  assert.equal(loadComposerEditCopy("s2", "instance-a"), null, "nor another session");

  clearComposerEditCopy("s1", "instance-a");
  assert.equal(loadComposerEditCopy("s1", "instance-a"), null);
  forgetComposerEditCopiesForInstance("instance-a");
  assert.equal(loadComposerEditCopy("s1", "instance-a"), null, "clearing removes the stored copy too");
});

test("when storage refuses a copy, this page keeps it and an older stored copy cannot come back", () => {
  saveComposerEditCopy("s1", COPY, "instance-a");
  storage.refuse = true;
  const newer: ComposerEditCopy = { id: "copy-2", previous: null };
  saveComposerEditCopy("s1", newer, "instance-a");
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), newer, "the page's memory holds the newer copy");
  forgetComposerEditCopiesForInstance("instance-a");
  assert.equal(loadComposerEditCopy("s1", "instance-a"), null, "the refused save removed the older stored copy");
});

test("a send settles only the copy it sent: accepted ends it, a failure keeps it, a newer copy is untouched", () => {
  saveComposerEditCopy("s1", COPY, "instance-a");
  markComposerEditCopySending("s1", "instance-a", COPY.id);
  assert.equal(composerEditCopySending("s1", "instance-a", COPY.id), true);
  assert.equal(composerEditCopySending("s1", "instance-b", COPY.id), false);
  finishComposerEditCopySend("s1", "instance-a", COPY.id, false);
  assert.equal(composerEditCopySending("s1", "instance-a", COPY.id), false);
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), COPY, "a send that did not land keeps the edit");

  markComposerEditCopySending("s1", "instance-a", COPY.id);
  const newer: ComposerEditCopy = { id: "copy-2", previous: { text: "written during the send", images: [] } };
  saveComposerEditCopy("s1", newer, "instance-a");
  finishComposerEditCopySend("s1", "instance-a", COPY.id, true);
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), newer, "an accepted older send leaves a newer copy");

  markComposerEditCopySending("s1", "instance-a", newer.id);
  finishComposerEditCopySend("s1", "instance-a", newer.id, true);
  assert.equal(loadComposerEditCopy("s1", "instance-a"), null, "an accepted send of the current copy ends the edit");
  forgetComposerEditCopiesForInstance("instance-a");
  assert.equal(loadComposerEditCopy("s1", "instance-a"), null, "in storage too");
});

test("an accepted send in one tab leaves a newer copy another tab stored", () => {
  // This tab loads copy A and sends it.
  saveComposerEditCopy("s1", COPY, "instance-a");
  markComposerEditCopySending("s1", "instance-a", COPY.id);
  // Meanwhile another tab of the same session stores copy B over a draft of its own.
  const otherTab: ComposerEditCopy = { id: "copy-b", previous: { text: "the other tab's draft", images: [] } };
  const [key] = [...storage.values.keys()].filter((candidate) => storage.values.get(candidate)!.includes(COPY.id));
  assert.ok(key);
  storage.setItem(key, JSON.stringify(otherTab));

  finishComposerEditCopySend("s1", "instance-a", COPY.id, true);
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), otherTab, "this tab now reads the other tab's copy");
  forgetComposerEditCopiesForInstance("instance-a");
  assert.deepEqual(loadComposerEditCopy("s1", "instance-a"), otherTab, "and it survives a reload");
});

test("a stored copy that is not well formed is ignored", () => {
  assert.deepEqual(parseComposerEditCopy({ id: "x", previous: null }), { id: "x", previous: null });
  assert.deepEqual(parseComposerEditCopy({ id: "x", turn: 2, previous: { text: "a", images: [] } }),
    { id: "x", turn: 2, previous: { text: "a", images: [] } });
  for (const value of [
    null, "x", {}, { id: "", previous: null }, { id: "x" }, { id: "x", turn: 1.5, previous: null },
    { id: "x", previous: { text: 1, images: [] } }, { id: "x", previous: { text: "a", images: [{ nope: true }] } },
  ]) {
    assert.equal(parseComposerEditCopy(value), null, JSON.stringify(value));
  }
  saveComposerEditCopy("s9", COPY, "instance-a");
  const stored = [...storage.values.keys()].filter((key) => storage.values.get(key)!.includes("copy-1"));
  assert.equal(stored.length, 1, "the copy is stored under one key");
  storage.setItem(stored[0]!, "{not json");
  forgetComposerEditCopiesForInstance("instance-a");
  assert.equal(loadComposerEditCopy("s9", "instance-a"), null);
});
