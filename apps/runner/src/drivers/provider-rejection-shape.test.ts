import assert from "node:assert/strict";
import { test } from "node:test";
import { providerRejectionShape, providerRejectionShapeKey } from "./provider-rejection-shape.js";

test("reduces an indexed-item rejection to a normalized, content-free shape", () => {
  assert.deepEqual(
    providerRejectionShape(
      "Invalid 'input[675].arguments': string too long. Expected a string with maximum length " +
        "1048576, but got a string with length 1426210 instead.",
    ),
    // "Expected a string with maximum length" matches three allowlisted phrases; they are retained
    // in the module's own list order, never the order the provider happened to use.
    { path: "input[N].arguments", phrases: ["string too long", "maximum length", "expected a string"], numbers: [675, 1048576, 1426210] },
  );
  assert.deepEqual(
    providerRejectionShape("Invalid 'input[3].content[0].image_url': unsupported value 'x'"),
    { path: "input[N].content[N].image_url", phrases: ["unsupported value"], numbers: [3, 0] },
  );
});

test("never retains provider prose, values, or identifiers", () => {
  const shape = providerRejectionShape(
    "Invalid 'input[9].arguments': {\"apiKey\":\"sk-secret-value\"} is not allowed; " +
      "thread_id=thr_private; user said \"delete production\"",
  )!;
  const rendered = JSON.stringify(shape);
  for (const secret of ["sk-secret", "apiKey", "thr_private", "delete production", "user said"]) {
    assert.doesNotMatch(rendered, new RegExp(secret), secret);
  }
  // Only the path, the allowlisted phrase, and the index survive.
  assert.deepEqual(shape, { path: "input[N].arguments", phrases: ["is not allowed"], numbers: [9] });
});

test("ignores every rejection that does not name an indexed request item", () => {
  for (const message of [
    "429 rate_limit_error",
    "unexpected status 401 Unauthorized",
    "context_length_exceeded: this model supports at most 200000 tokens",
    "Invalid 'instructions': string too long.",
    "connection reset by peer",
    "",
  ]) assert.equal(providerRejectionShape(message), null, message);

  for (const value of [null, undefined, 42, {}, ["input[1].arguments"]]) {
    assert.equal(providerRejectionShape(value), null, String(value));
  }
});

test("bounds what it retains from a hostile message", () => {
  const shape = providerRejectionShape(
    `Invalid 'input[1].arguments': ${Array.from({ length: 50 }, (_, i) => i * 7).join(" ")} must be`,
  )!;
  assert.ok(shape.numbers.length <= 4, "number retention is bounded");
  assert.ok(shape.phrases.length <= 6, "phrase retention is bounded");
  // A path cannot grow without limit either: segments and their length are capped by the grammar.
  const deep = providerRejectionShape(`Invalid 'input[1]${".a".repeat(40)}': must be`)!;
  assert.ok(deep.path.split(".").length <= 9, `path depth is bounded, got ${deep.path}`);
});

test("the same shape from two different messages is one piece of evidence", () => {
  const first = providerRejectionShape("Invalid 'input[675].arguments': string too long. maximum length 1048576")!;
  const second = providerRejectionShape("Invalid 'input[12].arguments': string too long. maximum length 2000")!;
  assert.equal(
    providerRejectionShapeKey("codex-app-server", first),
    providerRejectionShapeKey("codex-app-server", second),
    "sizes differ but the defect is the same",
  );
  assert.notEqual(
    providerRejectionShapeKey("codex-app-server", first),
    providerRejectionShapeKey("claude-code", first),
  );
});
