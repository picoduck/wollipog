import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  clearComposerEditCopy,
  forgetComposerEditCopiesForInstance,
  loadComposerEditCopy,
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
