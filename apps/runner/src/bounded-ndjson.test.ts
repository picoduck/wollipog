import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedNdjsonBuffer } from "./bounded-ndjson.js";

test("oversized newline-free records stay bounded and resynchronize after their newline", () => {
  const lines: string[] = [];
  let overflows = 0;
  const parser = new BoundedNdjsonBuffer((line) => lines.push(line), () => { overflows += 1; }, 8);

  parser.push("12345678");
  parser.push("9");
  parser.push("still hostile");
  assert.equal(overflows, 1, "one oversized record emits one bounded diagnostic");
  assert.equal((parser as unknown as { buffer: string }).buffer.length, 0);

  parser.push("\n{\"ok\":1}\n");
  assert.deepEqual(lines, ['{\"ok\":1}']);
});

test("limit is measured in UTF-8 bytes and exact-limit records remain valid", () => {
  const lines: string[] = [];
  let overflows = 0;
  const parser = new BoundedNdjsonBuffer((line) => lines.push(line), () => { overflows += 1; }, 4);

  parser.push("éé\n");
  parser.push("ééé\nnext");
  assert.deepEqual(lines, ["éé"]);
  assert.equal(overflows, 1);
  assert.equal(parser.takeTrailing(), "next");
});
