import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveControlPlaneHttpUrl,
  publishNegotiatedSessionSnapshots,
  registrationSessionSnapshots,
  validateControlPlaneUrl,
} from "./control-plane-transport.js";
import type { SessionSnapshot } from "@wollipog/protocol";

function snapshot(seq: number, historyEpoch: number | undefined): SessionSnapshot {
  return {
    id: "s_handshake",
    workspaceId: null,
    agentId: "codex",
    title: "Handshake",
    status: "idle",
    driver: "codex",
    useWorktree: false,
    worktreePath: null,
    workspacePath: "/repo",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    seq,
    historyEpoch,
    createdAt: 1,
    updatedAt: 1,
  };
}

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
    "ws://127.0.0.1.attacker.example/runner",
    "ws://127.manager.attacker.example/runner",
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

test("register uses neutral snapshots and negotiated republish preserves exact snapshots for send-time projection", () => {
  const register = snapshot(0, undefined);
  const exact = snapshot(3, 0);
  const calls: string[] = [];
  const source = {
    registrationSessionSnapshots: () => {
      calls.push("register");
      return [register];
    },
    sessionSnapshots: (exactEventSeq: boolean) => {
      calls.push(`runtime:${exactEventSeq}`);
      assert.equal(exactEventSeq, true);
      return [exact];
    },
  };

  assert.deepEqual(registrationSessionSnapshots(source), [register]);
  const sent: SessionSnapshot[] = [];
  publishNegotiatedSessionSnapshots(source, (message) => sent.push(message.snapshot));
  assert.deepEqual(calls, ["register", "runtime:true"]);
  assert.deepEqual(sent, [exact], "the send callback receives local truth for negotiated projection");
});
