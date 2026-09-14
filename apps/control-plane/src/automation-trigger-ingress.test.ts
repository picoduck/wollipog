import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  AUTOMATION_TRIGGER_MAX_BODY_BYTES,
  AUTOMATION_TRIGGER_MAX_PARAMETER_BYTES,
  AUTOMATION_TRIGGER_MAX_PROMPT_BYTES,
  AUTOMATION_TRIGGER_MEDIA_TYPE,
  LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE,
  automationTriggerBodySha256,
  newAutomationTriggerSecret,
  parseAutomationTriggerBody,
  registerAutomationTriggerContentTypeParser,
  signAutomationTrigger,
  verifyAutomationTriggerSignature,
  WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE,
} from "./automation-trigger-ingress.js";

test("signed trigger ingress binds the raw body, trigger, timestamp, and nonce", () => {
  const secret = newAutomationTriggerSecret();
  assert.match(secret, /^wollipogwhsec_[A-Za-z0-9_-]{43}$/);
  const body = Buffer.from('{"eventId":"delivery-1"}');
  const timestamp = "100";
  const nonce = "nonce_1234567890";
  const signature = signAutomationTrigger(secret, "atr_1", timestamp, nonce, body);
  assert.equal(verifyAutomationTriggerSignature(secret, "atr_1", { timestamp, nonce, signature }, body, 100_000), true);
  assert.equal(verifyAutomationTriggerSignature(secret, "atr_2", { timestamp, nonce, signature }, body, 100_000), false);
  assert.equal(verifyAutomationTriggerSignature(secret, "atr_1", { timestamp, nonce, signature }, Buffer.from('{"eventId":"delivery-2"}'), 100_000), false);
  assert.equal(verifyAutomationTriggerSignature(secret, "atr_1", { timestamp, nonce, signature }, body, 500_001), false);
  assert.match(automationTriggerBodySha256(body), /^[a-f0-9]{64}$/);
});

test("the published signing contract has a stable deterministic vector and strict envelope bounds", () => {
  const body = Buffer.from('{"eventId":"delivery-1"}');
  assert.equal(automationTriggerBodySha256(body),
    "e255cceb3b8d1d9be8bf7fc330b15f076b80e8c5bf8004ac1f0bcf5c4a6ea866");
  assert.equal(signAutomationTrigger("mamwhsec_test_vector", "atr_1", "100", "nonce_1234567890", body),
    "v1=14d0fa8cf245dbadb20187f7141f70136ba1755f8750e4cf8fb9ea3ea7acff99");
  assert.equal(verifyAutomationTriggerSignature("mamwhsec_test_vector", "atr_1", {
    timestamp: "100", nonce: "nonce_1234567890",
    signature: "v1=14d0fa8cf245dbadb20187f7141f70136ba1755f8750e4cf8fb9ea3ea7acff99",
  }, body, 100_000), true);
  assert.equal(verifyAutomationTriggerSignature("mamwhsec_test_vector", "atr_1", {
    timestamp: "100", nonce: "too-short", signature: "v1=" + "0".repeat(64),
  }, body, 100_000), false);
  assert.equal(verifyAutomationTriggerSignature("mamwhsec_test_vector", "atr_1", {
    timestamp: "100", nonce: "nonce_1234567890", signature: "v1=" + "0".repeat(64),
  }, Buffer.alloc(16 * 1024 + 1, 0x61), 100_000), false);
});

test("trigger bodies are provider-neutral, strict, bounded, and retain only sender hashes", () => {
  assert.deepEqual(parseAutomationTriggerBody("webhook", Buffer.from('{"eventId":"github:123.4"}')),
    { eventId: "github:123.4" });
  const chat = parseAutomationTriggerBody("chatops",
    Buffer.from('{"eventId":"slack:1","command":"run","sender":"person@example.com"}'));
  assert.equal(chat?.eventId, "slack:1");
  assert.match(chat?.senderHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(chat).includes("person@example.com"), false);
  assert.equal(parseAutomationTriggerBody("chatops", Buffer.from('{"eventId":"x","command":"status","sender":"a"}')), null);
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from('{"eventId":"x","payload":"not retained"}')), null);
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from('{"eventId":"bad id"}')), null);
  assert.equal(parseAutomationTriggerBody("webhook",
    Buffer.from('{"eventId":"first","eventId":"last"}')), null, "duplicate members are ambiguous");
  assert.equal(parseAutomationTriggerBody("chatops",
    Buffer.from('{"eventId":"x","command":"deny","command":"run","sender":"a"}')), null);
  assert.equal(parseAutomationTriggerBody("chatops",
    Buffer.concat([Buffer.from('{"eventId":"x","command":"run","sender":"'), Buffer.from([0x80]), Buffer.from('"}')])),
  null, "malformed UTF-8 must not collapse into a replacement-character identity");
  assert.match(parseAutomationTriggerBody("chatops",
    Buffer.from('{"eventId":"x","command":"run","sender":"actor 🚀"}'))?.senderHash ?? "", /^[a-f0-9]{64}$/);
});

test("configured trigger bodies accept only explicitly allowlisted prompt, parameters, and selectors", () => {
  const policy = {
    allowPrompt: true,
    parameterNames: ["issue", "run_id"],
    missingReferences: "reject" as const,
    sessionSelectors: ["branch", "pull_request"] as const,
  };
  assert.deepEqual(parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
    eventId: "github:1099",
    prompt: "Work the labeled issue",
    parameters: { issue: "1099", run_id: "ci-42" },
    target: { branch: "fix/issue-1099" },
  })), policy), {
    eventId: "github:1099",
    prompt: "Work the labeled issue",
    parameters: { issue: "1099", run_id: "ci-42" },
    target: { selector: "branch", value: "fix/issue-1099" },
  });
  assert.equal(parseAutomationTriggerBody("webhook",
    Buffer.from('{"eventId":"x","prompt":"not allowed"}')), null,
  "legacy triggers retain the exact event-id-only contract");
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
    eventId: "x", parameters: { secret: "no" },
  })), policy), null);
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
    eventId: "x", target: { sessionId: "s_1" },
  })), policy), null);
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
    eventId: "x", prompt: "x".repeat(AUTOMATION_TRIGGER_MAX_PROMPT_BYTES + 1),
  })), policy), null);
  assert.equal(parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
    eventId: "x", parameters: { issue: "x".repeat(AUTOMATION_TRIGGER_MAX_PARAMETER_BYTES + 1) },
  })), policy), null);
  assert.equal(parseAutomationTriggerBody("webhook",
    Buffer.from('{"eventId":"x","parameters":{"issue":"1","issue":"2"}}'), policy), null,
  "duplicate nested members are ambiguous too");
});

test("allowlisted parameter parsing round-trips generated short Unicode string maps", () => {
  const names = ["a", "Issue_1", "z9"];
  const values = ["", "plain", "line\nbreak", "rocket 🚀", "\\quoted\""];
  const policy = { allowPrompt: false, parameterNames: names, missingReferences: "use_stored" as const };
  let sequence = 0;
  for (const name of names) {
    for (const value of values) {
      const eventId = `generated-${sequence++}`;
      const parsed = parseAutomationTriggerBody("webhook", Buffer.from(JSON.stringify({
        eventId, parameters: { [name]: value },
      })), policy);
      assert.deepEqual(parsed, { eventId, parameters: { [name]: value } });
    }
  }
});

test("trigger body parser rejects malformed JSON-subset syntax and strings", () => {
  for (const [name, kind, body] of [
    ["unterminated input", "webhook", '{"eventId":"x"'],
    ["missing colon", "webhook", '{"eventId" "x"}'],
    ["trailing comma", "webhook", '{"eventId":"x",}'],
    ["trailing content", "webhook", '{"eventId":"x"}x'],
    ["raw control character in a string", "webhook", '{"eventId":"x\n"}'],
    ["lone surrogate", "chatops", String.raw`{"eventId":"x","command":"run","sender":"\ud800"}`],
  ] as const) {
    assert.equal(parseAutomationTriggerBody(kind, Buffer.from(body)), null, name);
  }
});

test("the registered raw-body parser enforces the published HTTP size ceiling", async () => {
  assert.equal(AUTOMATION_TRIGGER_MEDIA_TYPE, WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE,
    "the post-release producer must publish the Wollipog identity");
  const app = Fastify();
  registerAutomationTriggerContentTypeParser(app);
  app.post("/hook", { bodyLimit: AUTOMATION_TRIGGER_MAX_BODY_BYTES }, async (request, reply) => (
    Buffer.isBuffer(request.body) ? reply.code(204).send() : reply.code(415).send()
  ));
  const accepted = await app.inject({
    method: "POST", url: "/hook", headers: { "content-type": AUTOMATION_TRIGGER_MEDIA_TYPE },
    payload: Buffer.from('{"eventId":"x"}'),
  });
  assert.equal(accepted.statusCode, 204);
  const legacy = await app.inject({
    method: "POST", url: "/hook", headers: { "content-type": LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE },
    payload: Buffer.from('{"eventId":"x"}'),
  });
  assert.equal(legacy.statusCode, 204);
  const oversized = await app.inject({
    method: "POST", url: "/hook", headers: { "content-type": AUTOMATION_TRIGGER_MEDIA_TYPE },
    payload: Buffer.alloc(AUTOMATION_TRIGGER_MAX_BODY_BYTES + 1, 0x61),
  });
  assert.equal(oversized.statusCode, 413);
  await app.close();
});
