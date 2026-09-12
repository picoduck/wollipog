import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnclassifiedRejectionJournal } from "./unclassified-rejection-journal.js";
import { providerRejectionShape } from "./provider-rejection-shape.js";

const shape = (message: string) => providerRejectionShape(message)!;
const OVERSIZED = "Invalid 'input[675].arguments': string too long. maximum length 1048576";
const UNSUPPORTED = "Invalid 'input[3].content[0].image_url': unsupported value";

function root() {
  return mkdtempSync(join(tmpdir(), "wollipog-rejections-"));
}

test("repeats are counted, not appended, and survive a restart", () => {
  const dir = root();
  try {
    let clock = 1000;
    const journal = new UnclassifiedRejectionJournal(dir, () => (clock += 10));
    journal.record("codex-app-server", shape(OVERSIZED));
    journal.record("codex-app-server", shape("Invalid 'input[9].arguments': string too long. maximum length 42"));
    journal.record("codex-app-server", shape(UNSUPPORTED));

    // Differing indices and sizes are the same defect, so they are one record with a count.
    const reopened = new UnclassifiedRejectionJournal(dir, () => clock);
    const records = reopened.list().sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(records.map((entry) => [entry.path, entry.count]), [
      ["input[N].arguments", 2],
      ["input[N].content[N].image_url", 1],
    ]);
    assert.ok(records[0]!.lastSeenAt > records[0]!.firstSeenAt, "repeats advance the last-seen time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unrecognized field names cannot flood the journal with distinct shapes", () => {
  const dir = root();
  try {
    const journal = new UnclassifiedRejectionJournal(dir);
    for (let index = 0; index < 200; index += 1) {
      journal.record("codex-app-server", shape(`Invalid 'input[1].secret_${index}': must be`));
    }
    // Redacting unrecognized segments bounds the shape space itself: 200 distinct attacker-chosen
    // names are one observation, not 200 rows.
    assert.deepEqual(journal.list().map((entry) => [entry.path, entry.count]), [["input[N].<field>", 200]]);
    assert.equal(journal.overflowCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention is bounded and the bound is recorded rather than hidden", () => {
  const dir = root();
  try {
    const journal = new UnclassifiedRejectionJournal(dir);
    // Distinct shapes come from real structure: recognized field names and nesting depth. The
    // path grammar caps depth, so depth alone cannot generate them indefinitely.
    const fields = [
      "arguments", "content", "name", "role", "type", "text", "id", "url", "data", "detail",
      "status", "summary", "output", "input", "tools", "metadata", "refusal", "reasoning",
      "parameters", "function", "call_id", "file_id", "instructions", "messages", "annotations",
      "tool_calls", "tool_choice", "image_url", "file_url", "file_data", "output_text",
      "input_audio", "encrypted_content",
    ];
    const shapes = fields.flatMap((field) => [
      shape(`Invalid 'input[1].${field}': must be`),
      shape(`Invalid 'input[1].content.${field}': must be`),
    ]);
    const distinct = new Set(shapes.map((entry) => entry.path)).size;
    assert.ok(distinct > 64, `the fixture must exceed the cap, got ${distinct}`);
    for (const entry of shapes) journal.record("codex-app-server", entry);

    assert.equal(journal.list().length, 64, "distinct shapes are capped");
    assert.equal(journal.overflowCount(), distinct - 64, "shapes the cap rejected are still counted");

    // An already-known shape is still counted once the journal is full.
    const known = journal.list()[0]!;
    const before = known.count;
    journal.record("codex-app-server", { path: known.path, phrases: known.phrases });
    assert.equal(journal.list().find((entry) => entry.path === known.path)!.count, before + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a journal written by an older build is sanitized on load and on disk", () => {
  const dir = root();
  const file = join(dir, "unclassified-provider-rejections.json");
  try {
    // A record from the build that still stored measured sizes. Removing the field from the type
    // does nothing to bytes already on disk; the loader is where retention is actually decided.
    writeFileSync(file, JSON.stringify({
      records: [{
        version: 1, driver: "codex-app-server", path: "input[N].arguments",
        phrases: ["string too long"], numbers: [123456789, 4111111111111111],
        count: 3, firstSeenAt: 1, lastSeenAt: 2,
      }],
      overflow: 4,
    }));

    const journal = new UnclassifiedRejectionJournal(dir);
    assert.deepEqual(journal.list(), [{
      version: 1, driver: "codex-app-server", path: "input[N].arguments",
      phrases: ["string too long"], count: 3, firstSeenAt: 1, lastSeenAt: 2,
    }], "the removed property is gone from memory");
    assert.equal(journal.overflowCount(), 4, "the sanitizing rewrite preserves the rest of the journal");
    assert.equal(new UnclassifiedRejectionJournal(dir).overflowCount(), 4, "and across a restart");

    // And gone from disk without waiting for another observation.
    const raw = readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /numbers|123456789|4111111111111111/, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or missing journal loses observations rather than raising", () => {
  const dir = root();
  try {
    writeFileSync(join(dir, "unclassified-provider-rejections.json"), "{ not json");
    const journal = new UnclassifiedRejectionJournal(dir);
    assert.deepEqual(journal.list(), []);
    assert.equal(journal.record("codex-app-server", shape(OVERSIZED)), true, "recording still works");
    assert.equal(new UnclassifiedRejectionJournal(dir).list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file on disk holds only structural evidence", () => {
  const dir = root();
  try {
    new UnclassifiedRejectionJournal(dir).record("codex-app-server", shape(
      "Invalid 'input[9].arguments': {\"apiKey\":\"sk-secret\"} is not allowed; thread_id=thr_private",
    ));
    const raw = readFileSync(join(dir, "unclassified-provider-rejections.json"), "utf8");
    for (const secret of ["sk-secret", "apiKey", "thr_private"]) {
      assert.doesNotMatch(raw, new RegExp(secret), secret);
    }
    assert.match(raw, /input\[N\]\.arguments/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
