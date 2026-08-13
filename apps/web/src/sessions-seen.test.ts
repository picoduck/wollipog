import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SEEN_CAP, isUnread, loadSeen, markSeen, markUnread, parseSeen, saveSeen } from "./sessions-seen.js";

const backing = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
};

beforeEach(() => backing.clear());

test("parseSeen: garbage and non-object JSON fall back to empty", () => {
  for (const raw of [null, "", "not json", "[1,2]", "42", "null"]) {
    assert.deepEqual(parseSeen(raw), {}, `raw=${JSON.stringify(raw)}`);
  }
});

test("parseSeen: keeps only finite-number entries", () => {
  assert.deepEqual(parseSeen('{"a":100,"b":"x","c":null,"d":200.5}'), { a: 100, d: 200.5 });
});

test("markSeen: records the timestamp and never moves it backwards", () => {
  const m1 = markSeen({}, "s1", 100);
  assert.equal(m1.s1, 100);
  const m2 = markSeen(m1, "s1", 50);
  assert.equal(m2.s1, 100, "an older ts must not regress the seen marker");
  const m3 = markSeen(m2, "s1", 300);
  assert.equal(m3.s1, 300);
});

test("markSeen: prunes the oldest entries beyond the cap", () => {
  let map = {} as Record<string, number>;
  for (let i = 0; i < SEEN_CAP; i++) map = markSeen(map, `s${i}`, i + 1);
  map = markSeen(map, "fresh", 10_000);
  assert.equal(Object.keys(map).length, SEEN_CAP);
  assert.ok(!("s0" in map), "the oldest entry is evicted");
  assert.equal(map.fresh, 10_000);
});

test("isUnread: only sessions seen before with newer activity are unread", () => {
  const map = { s1: 100 };
  assert.equal(isUnread(map, "s1", 200), true, "new events since last view");
  assert.equal(isUnread(map, "s1", 100), false, "no new events");
  assert.equal(isUnread(map, "s1", null), false, "no events at all");
  assert.equal(isUnread(map, "never-opened", 500), false, "never-opened sessions don't dot-flood");
});

test("markUnread: moves the selected marker just behind its latest activity", () => {
  const original = { selected: 500, untouched: 200 };
  const next = markUnread(original, "selected", 400);
  assert.deepEqual(next, { selected: 399, untouched: 200 });
  assert.equal(isUnread(next, "selected", 400), true);
  assert.deepEqual(original, { selected: 500, untouched: 200 }, "the input remains immutable");
});

test("markUnread: creates a marker for never-opened sessions and ignores absent activity", () => {
  assert.deepEqual(markUnread({}, "new", 1_000), { new: 999 });
  const original = { existing: 10 };
  assert.equal(markUnread(original, "new", null), original);
  assert.equal(markUnread(original, "new", Number.NaN), original);
});

test("seen timestamps with identical session ids remain instance scoped", () => {
  saveSeen({ same: 10 }, "local");
  saveSeen({ same: 20 }, "remote-alpha");
  saveSeen({ same: 30 }, "remote-beta");
  assert.deepEqual(loadSeen("local"), { same: 10 });
  assert.deepEqual(loadSeen("remote-alpha"), { same: 20 });
  assert.deepEqual(loadSeen("remote-beta"), { same: 30 });
});

test("legacy seen state copies forward to Local and is never visible remotely", () => {
  backing.set("mam.sessions.seen", '{"legacy":42}');
  assert.deepEqual(loadSeen("remote-alpha"), {});
  assert.deepEqual(loadSeen("local"), { legacy: 42 });
  assert.equal(backing.has("mam.sessions.seen"), true, "copy-forward retains rollback data");
  assert.ok([...backing.keys()].some((key) => key.startsWith("wollipog.instance.v1:")));
});
