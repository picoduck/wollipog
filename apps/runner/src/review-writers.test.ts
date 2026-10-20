import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReviewWriterRegistry } from "./review-writers.js";

test("each provider or TUI writer keeps its own durable proof obligation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-review-writers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new ReviewWriterRegistry(directory);
  const provider = registry.acquire("s_writer", "provider");
  const tui = registry.acquire("s_writer", "agent_tui");
  assert.equal(readdirSync(directory).length, 2);
  assert.deepEqual(registry.sessions(), ["s_writer"]);
  assert.equal(registry.retire(provider, false), false);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions("provider"), ["s_writer"]);
  assert.equal(registry.retire(provider, true), true);
  assert.deepEqual(registry.sessions("provider"), []);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions(), ["s_writer"]);
  assert.equal(registry.retire(tui, true), true);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions(), []);
});
