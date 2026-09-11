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
    { path: "input[N].arguments", phrases: ["string too long", "maximum length", "expected a string"] },
  );
  assert.deepEqual(
    providerRejectionShape("Invalid 'input[3].content[0].image_url': unsupported value 'x'"),
    { path: "input[N].content[N].image_url", phrases: ["unsupported value"] },
  );
});

test("an unrecognized field name is named as a placeholder, never reproduced", () => {
  // Restricting characters and length does not make a segment content-free: a secret made of word
  // characters would pass such a filter unchanged. Only a fixed vocabulary is safe.
  const shape = providerRejectionShape("Invalid 'input[0].sk_live_SUPERSECRET123': must be")!;
  assert.deepEqual(shape, { path: "input[N].<field>", phrases: ["must be"] });
  assert.doesNotMatch(JSON.stringify(shape), /SUPERSECRET|sk_live/);

  // Structure is still recorded: depth and the recognized segments around it survive.
  assert.equal(
    providerRejectionShape("Invalid 'input[2].content[0].hunter2': is required")!.path,
    "input[N].content[N].<field>",
  );
});

test("schema fields the driver actually sends stay named", () => {
  // `prompt-images.ts` constructs `{ type: "localImage", path }`, so a rejection naming `path` is
  // actionable evidence. Redacting it would coalesce it with unrelated unknown fields.
  assert.equal(providerRejectionShape("Invalid 'input[0].path': is not allowed")!.path, "input[N].path");
  assert.equal(providerRejectionShape("Invalid 'input[0].type': invalid value")!.path, "input[N].type");
});

test("no number from the message ever reaches the output", () => {
  // Within one opaque string there is no sound way to separate provider text from user content the
  // provider echoed back: content containing a measurement word is indistinguishable from a real
  // measurement. Keeping none is the only provable answer.
  for (const message of [
    "Invalid 'input[0].content': unsupported value 'tokens 123456789'",
    "Invalid 'input[0].content': unsupported value '4111111111111111'",
    "Invalid 'input[0].arguments': string too long. maximum length 1048576",
    "Invalid 'input[9].arguments': exceeds limit 500 and my phone is 5551234567",
  ]) {
    const rendered = JSON.stringify(providerRejectionShape(message));
    assert.doesNotMatch(rendered, /\d/, `no digits may survive: ${message} -> ${rendered}`);
  }
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
  // Only the known field name and the allowlisted phrase survive.
  assert.deepEqual(shape, { path: "input[N].arguments", phrases: ["is not allowed"] });
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
  assert.ok(shape.phrases.length <= 6, "phrase retention is bounded");
  // A path cannot grow without limit either: segments and their length are capped by the grammar.
  const deep = providerRejectionShape(`Invalid 'input[1]${".a".repeat(40)}': must be`)!;
  assert.ok(deep.path.split(".").length <= 9, `path depth is bounded, got ${deep.path}`);
  assert.doesNotMatch(deep.path, /\.a(\.|$)/, "unrecognized segments are placeholders, not copies");
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
