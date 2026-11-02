import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import type { InvokeSessionCommandMessage } from "@wollipog/protocol";
import type { SessionCommandInvocationLifecycle } from "./session-manager.js";
import { SessionCommandReceiptStore, sessionCommandInvocationPayloadDigest } from "./session-command-receipt-store.js";

// Execute the production wiring without starting a daemon, network service, or provider.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function productionFunction(name: string): string {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing production function ${name}`);
  return match[0];
}

for (const state of ["accepted", "queued", "started"] as const) {
  for (const callback of ["completed", "queued"] as const) {
    test(`recovery wiring excludes active ${state} after stale ${callback} and recovers abandoned work`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-recovery-"));
      try {
        const store = new SessionCommandReceiptStore(root, { ownerId: "runner-a", now: () => 1 });
        const envelope: InvokeSessionCommandMessage = {
          type: "invoke_session_command", requestId: "req_1", invocationId: "inv_1", submissionId: "sub_1",
          sessionId: "session_1", providerCommandId: "provider_1", catalogRevision: "catalog_1",
          expectedExecutionMode: "passthrough", argumentText: "release candidate", expiresAt: 10_000, payloadDigest: "",
        };
        envelope.payloadDigest = sessionCommandInvocationPayloadDigest(envelope);
        const first = store.claim(envelope);
        if (first.kind !== "new") return assert.fail("initial claim failed");
        first.handle.queued();
        const fault = t.mock.method(store as any, "writeAtomic", () => { throw new Error("synthetic write failure"); });
        assert.throws(() => first.handle[callback](), /synthetic write failure/u);
        fault.mock.restore();
        const retry = store.claim(envelope);
        if (retry.kind !== "reclaimed") return assert.fail("failed write did not release ownership");
        if (state === "queued") retry.handle.queued();
        if (state === "started") retry.handle.started(42);
        assert.throws(() => first.handle[callback](), /changed concurrently/u);
        const before = store.read(envelope.invocationId);
        const invoked: string[] = [];
        const admitted: string[] = [];
        let allowRecovery = false;
        const scope = {
          sessionCommandReceipts: store,
          Date: { now: () => 1 },
          log: (text: string) => assert.fail(text),
          errText: String,
          sendSessionCommandUpdate: () => {},
          sessions: {
            canRecoverSessionCommand: (message: InvokeSessionCommandMessage) => {
              admitted.push(message.invocationId);
              return allowRecovery;
            },
            invokeSessionCommand: (message: InvokeSessionCommandMessage, lifecycle: SessionCommandInvocationLifecycle) => {
              invoked.push(message.invocationId);
              lifecycle.queued();
              lifecycle.started(99);
              lifecycle.completed();
            },
          },
          recoverStaleSessionCommands: undefined as undefined | (() => void),
        };
        runInNewContext(transformSync([
          productionFunction("sessionCommandLifecycle"), productionFunction("recoverStaleSessionCommands"),
        ].join("\n"), { loader: "ts" }).code, scope);
        const recover = scope.recoverStaleSessionCommands!;
        recover();
        assert.deepEqual(admitted, [], "locally active work must not reach recovery admission");
        assert.deepEqual(invoked, []);
        assert.deepEqual(store.read(envelope.invocationId), before);

        // A failure on the current handle must still expose genuinely abandoned work.
        const abandon = t.mock.method(store as any, "writeAtomic", () => { throw new Error("abandoned write"); });
        assert.throws(() => retry.handle.completed(), /abandoned write/u);
        abandon.mock.restore();
        recover();
        if (state === "started") {
          assert.deepEqual(admitted, [], "started work settles uncertain without admission or invocation");
          assert.equal(store.read(envelope.invocationId)?.state, "uncertain");
          assert.equal(store.read(envelope.invocationId)?.userEventSeq, 42);
        } else {
          assert.deepEqual(admitted, [envelope.invocationId]);
          assert.deepEqual(store.read(envelope.invocationId), before, "denied recovery cannot claim work");
          allowRecovery = true;
          recover();
          assert.deepEqual(invoked, [envelope.invocationId], "admitted abandoned work is invoked once");
          assert.equal(store.read(envelope.invocationId)?.state, "completed");
          assert.equal(store.read(envelope.invocationId)?.userEventSeq, 99);
        }
        recover();
        assert.equal(invoked.length, state === "started" ? 0 : 1, "terminal recovery never invokes again");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
