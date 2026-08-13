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

test("tailnet setting descriptions explain enabled and externally managed states", () => {
  assert.equal(
    tailnetAccessDescription({ available: true, enabled: true, managed: true }),
    "Paired browsers can connect through this machine's Tailscale address.",
  );
  assert.equal(
    tailnetAccessDescription({ available: true, enabled: false, managed: false }),
    "Unavailable while another control plane owns port 4317.",
  );
});
