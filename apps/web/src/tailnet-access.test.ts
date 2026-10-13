import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readTailnetAccess,
  tailnetAccessDescription,
  writeTailnetAccess,
  type TailnetDesktopRuntime,
} from "./tailnet-access.js";

test("browser dashboards hide the desktop-owned tailnet setting", async () => {
  const desktop: TailnetDesktopRuntime = {
    isTauri: () => false,
    invoke: async () => {
      throw new Error("invoke should not run");
    },
  };
  assert.equal(await readTailnetAccess(desktop), null);
  await assert.rejects(() => writeTailnetAccess(true, desktop), /desktop app/);
});

test("desktop dashboards read and update the managed sidecar setting", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const desktop: TailnetDesktopRuntime = {
    isTauri: () => true,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return { available: true, enabled: command === "set_tailnet_access", managed: true } as T;
    },
  };
  assert.deepEqual(await readTailnetAccess(desktop), { available: true, enabled: false, managed: true });
  assert.deepEqual(await writeTailnetAccess(true, desktop), { available: true, enabled: true, managed: true });
  assert.deepEqual(calls, [
    { command: "tailnet_access_status", args: undefined },
    { command: "set_tailnet_access", args: { enabled: true } },
  ]);
});

test("each read status has its own sentence, none naming a port or the control plane", () => {
  const sentences = {
    on: tailnetAccessDescription({ available: true, enabled: true, managed: true }),
    off: tailnetAccessDescription({ available: true, enabled: false, managed: true }),
    unmanaged: tailnetAccessDescription({ available: true, enabled: false, managed: false }),
    // Tailscale missing outranks every other fact: nothing else about the switch can matter.
    missing: tailnetAccessDescription({ available: false, enabled: false, managed: false }),
  };
  assert.deepEqual(sentences, {
    on: "Paired browsers can connect through this machine's Tailscale address.",
    off: "Let paired browsers reach this machine through Tailscale.",
    unmanaged: "Unavailable because another Wollipog server is using this machine's port.",
    missing: "Tailscale isn't installed or running on this machine.",
  });
  for (const sentence of Object.values(sentences)) assert.doesNotMatch(sentence, /control plane|\d{2,}/i);
});
