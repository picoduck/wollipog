import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addRemoteInstance,
  editRemoteInstance,
  openRemoteTransport,
  readInstanceRegistry,
  type DesktopInstanceRuntime,
} from "./desktop-instances.js";

test("desktop instance wrappers pass credentials only through explicit pairing commands", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const desktop: DesktopInstanceRuntime = {
    isTauri: () => true,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return (command === "remote_transport_open"
        ? { profileId: "a", runtimeKey: "a:1", publicOrigin: "https://a.test" }
        : { profiles: [], activeInstanceId: "local" }) as T;
    },
  };
  await readInstanceRegistry(desktop);
  await addRemoteInstance({ label: "A", origin: "https://a.test", token: "pairing-secret-value" }, desktop);
  await editRemoteInstance({ profileId: "a", label: "A", origin: "https://a.test" }, desktop);
  await editRemoteInstance({
    profileId: "a",
    label: "A",
    origin: "https://new-a.test",
    token: "replacement-pairing-value",
  }, desktop);
  await openRemoteTransport("a", desktop);
  assert.deepEqual(calls.map(({ command }) => command), [
    "instance_registry",
    "add_remote_instance",
    "edit_remote_instance",
    "edit_remote_instance",
    "remote_transport_open",
  ]);
  assert.equal(calls[1]?.args?.token, "pairing-secret-value");
  assert.equal(calls[2]?.args?.token, undefined);
  assert.equal(calls[3]?.args?.token, "replacement-pairing-value");
  assert.deepEqual(calls[4]?.args, { profileId: "a" });
  assert.doesNotMatch(JSON.stringify(calls[4]), /secret|origin|https/);
});

test("browser dashboards remain single-instance and do not invoke desktop commands", async () => {
  let calls = 0;
  const browser: DesktopInstanceRuntime = {
    isTauri: () => false,
    async invoke<T>(): Promise<T> { calls += 1; throw new Error("unexpected"); },
  };
  assert.equal(await readInstanceRegistry(browser), null);
  await assert.rejects(() => openRemoteTransport("a", browser), /desktop app/);
  assert.equal(calls, 0);
});
