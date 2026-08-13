import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptManagedDesktopPairing,
  desktopLocalPairingFailure,
  type DesktopLocalPairingRuntime,
} from "./desktop-local-pairing.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_";

test("browser deployments never request a native pairing credential", async () => {
  let invoked = false;
  const desktop: DesktopLocalPairingRuntime = {
    isTauri: () => false,
    invoke: async () => {
      invoked = true;
      return null;
    },
  };
  assert.equal(await adoptManagedDesktopPairing(desktop, () => assert.fail("must not store")), false);
  assert.equal(invoked, false);
});

test("managed desktop pairing is adopted before clients start", async () => {
  const stored: string[] = [];
  const desktop: DesktopLocalPairingRuntime = {
    isTauri: () => true,
    invoke: async (command) => {
      assert.equal(command, "local_pairing_url");
      return `http://127.0.0.1:4317/#pair=${TOKEN}` as never;
    },
  };
  assert.equal(await adoptManagedDesktopPairing(desktop, (token) => stored.push(token)), true);
  assert.deepEqual(stored, [TOKEN]);
});

test("external control planes are not paired with a stale managed credential", async () => {
  const desktop: DesktopLocalPairingRuntime = {
    isTauri: () => true,
    invoke: async () => null as never,
  };
  assert.equal(await adoptManagedDesktopPairing(desktop, () => assert.fail("must not store")), false);
});

test("invalid native pairing output fails closed", async () => {
  const desktop: DesktopLocalPairingRuntime = {
    isTauri: () => true,
    invoke: async () => "http://127.0.0.1:4317/#pair=short" as never,
  };
  await assert.rejects(adoptManagedDesktopPairing(desktop), /invalid local pairing credential/);
  assert.match(desktopLocalPairingFailure() ?? "", /invalid local pairing credential/);
});

test("native pairing errors remain available to the recovery UI and clear after retry", async () => {
  const failing: DesktopLocalPairingRuntime = {
    isTauri: () => true,
    invoke: async () => { throw new Error("could not read the local dashboard credential"); },
  };
  await assert.rejects(adoptManagedDesktopPairing(failing), /could not read/);
  assert.equal(desktopLocalPairingFailure(), "could not read the local dashboard credential");

  const recovered: DesktopLocalPairingRuntime = {
    isTauri: () => true,
    invoke: async () => `http://127.0.0.1:4317/#pair=${TOKEN}` as never,
  };
  assert.equal(await adoptManagedDesktopPairing(recovered, () => {}), true);
  assert.equal(desktopLocalPairingFailure(), null);
});
