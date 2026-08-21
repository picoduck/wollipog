import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveControlPlaneHttpUrl,
  validateControlPlaneUrl,
} from "./control-plane-transport.js";

test("credential transport permits secure remote and plaintext loopback control planes", () => {
  for (const url of [
    "ws://localhost:4317/runner",
    "ws://runner.localhost:4317/runner",
    "ws://127.0.0.1:4317/runner",
    "ws://127.255.255.254:4317/runner",
    "ws://[::1]:4317/runner",
    "wss://manager.example.test/runner",
  ]) {
    assert.doesNotThrow(() => validateControlPlaneUrl(url), url);
  }
});

test("credential transport refuses plaintext non-loopback hosts without the exact opt-in", () => {
  for (const url of [
    "ws://manager.example.test/runner",
    "ws://localhost.example.test/runner",
    "ws://192.168.1.4/runner",
    "ws://0.0.0.0/runner",
  ]) {
    assert.throws(
      () => validateControlPlaneUrl(url),
      /refusing insecure ws:\/\/.*--allow-insecure-transport/u,
      url,
    );
  }
  assert.throws(() => validateControlPlaneUrl("https://manager.example.test/runner"), /ws:\/\/ or wss:\/\//u);
  assert.throws(
    () => validateControlPlaneUrl("wss://user:secret@manager.example.test/runner"),
    /embedded credentials/u,
  );
});

test("explicit insecure transport acknowledgement reaches HTTP side-channel derivation", () => {
  assert.equal(
    validateControlPlaneUrl("ws://manager.example.test/runner", true).hostname,
    "manager.example.test",
  );
  assert.equal(
    deriveControlPlaneHttpUrl("ws://manager.example.test/runner", true),
    "http://manager.example.test",
  );
  assert.throws(
    () => deriveControlPlaneHttpUrl("ws://manager.example.test/runner"),
    /--allow-insecure-transport/u,
  );
});
