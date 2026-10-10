import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownContentCache } from "./markdown-content-cache.js";

test("content reuse is isolated by parser profile and invalidated by changed source", () => {
  const cache = new MarkdownContentCache<object>();
  const first = cache.render("document", "# Heading", () => ({}));
  assert.equal(cache.render("document", "# Heading", () => { throw new Error("reparsed"); }), first);
  assert.notEqual(cache.render("inline", "# Heading", () => ({})), first);
  assert.notEqual(cache.render("document", "# Heading!", () => ({})), first);
  assert.deepEqual(cache.snapshot(), { entries: 3, sourceCharacters: 53, parses: 3, hits: 1 });
});

test("LRU evicts the least recently read content at the entry limit", () => {
  const cache = new MarkdownContentCache<string>({ entries: 2, sourceCharacters: 100, entryCharacters: 50 });
  const parse = (source: string) => cache.render("document", source, () => source);
  parse("a"); parse("b"); parse("a"); parse("c");
  assert.equal(cache.render("document", "a", () => { throw new Error("recent entry evicted"); }), "a");
  let reparsed = false;
  cache.render("document", "b", () => { reparsed = true; return "b"; });
  assert.equal(reparsed, true);
  assert.equal(cache.snapshot().entries, 2);
});

test("source budget bounds retained content across evictions and profile keys", () => {
  const cache = new MarkdownContentCache<string>({ entries: 100, sourceCharacters: 30, entryCharacters: 20 });
  for (let index = 0; index < 1_000; index++) {
    const source = String(index);
    cache.render(index % 2 ? "document" : "inline", source, () => source);
    assert.ok(cache.snapshot().sourceCharacters <= 30);
    assert.ok(cache.snapshot().entries <= 3);
  }
});

test("oversized and still-streaming documents render without evicting settled content", () => {
  const cache = new MarkdownContentCache<string>({ entries: 2, sourceCharacters: 30, entryCharacters: 15 });
  cache.render("inline", "small", () => "small");
  const retained = cache.snapshot();
  cache.render("document", "oversized document", () => "large");
  cache.render("document", "tail", () => "streamed", false);
  assert.equal(cache.snapshot().entries, retained.entries);
  assert.equal(cache.snapshot().sourceCharacters, retained.sourceCharacters);
  assert.equal(cache.render("inline", "small", () => { throw new Error("evicted"); }), "small");
  assert.equal(cache.render("document", "tail", () => "settled"), "settled");
});

test("failed parses are never stored and disabled caches render normally", () => {
  const cache = new MarkdownContentCache<string>();
  assert.throws(() => cache.render("document", "bad", () => { throw new Error("parse failed"); }));
  assert.equal(cache.snapshot().entries, 0);
  assert.equal(cache.render("document", "bad", () => "retry"), "retry");
  const disabled = new MarkdownContentCache<string>({ entries: 0, sourceCharacters: 0, entryCharacters: 0 });
  assert.equal(disabled.render("inline", "valid", () => "rendered"), "rendered");
  assert.equal(disabled.snapshot().entries, 0);
});
