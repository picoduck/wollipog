import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createApiClient } from "./api.js";
import { InstanceProvider } from "./InstanceProvider.js";
import { useInstances, type InstanceManager } from "./instances-context.js";
import { instanceViewPath } from "./instance-navigation.js";
import type { InstanceRuntime } from "./instance-runtime.js";
import type { InstanceRegistrySnapshot } from "./desktop-instances.js";

const domWindow = new Window({ url: "https://tauri.localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  PopStateEvent: domWindow.PopStateEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const profiles = [
  { id: "local", serverInstanceId: "local", kind: "local" as const, label: "This Machine", origin: "http://127.0.0.1:4317", createdAt: "" },
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", serverInstanceId: "11111111-1111-4111-8111-111111111111", kind: "remote" as const, label: "Remote A", origin: "https://a.test", createdAt: "2026-01-01T00:00:00Z" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", serverInstanceId: "22222222-2222-4222-8222-222222222222", kind: "remote" as const, label: "Remote B", origin: "https://b.test", createdAt: "2026-01-01T00:00:00Z" },
];

function registry(activeInstanceId = "local"): InstanceRegistrySnapshot {
  return { profiles, activeInstanceId };
}

function runtime(instanceId: string, closes: string[]): InstanceRuntime {
  const transport = {
    instanceId,
    publicOrigin: `https://${instanceId}.test`,
    async request() { return new Response("{}"); },
    close() {},
  };
  return {
    instanceId,
    publicOrigin: transport.publicOrigin,
    api: createApiClient(transport),
    ui: {
      instanceId,
      runtimeKey: `${instanceId}:1`,
      createSocket() { throw new Error("not mounted in this provider test"); },
      close() {},
    },
    close() { closes.push(instanceId); },
  };
}

test("desktop provider switches generations and closes a stale remote completion", async () => {
  let manager!: InstanceManager;
  const closes: string[] = [];
  const pending = new Map<string, (value: InstanceRuntime) => void>();
  const desktop = {
    isTauri: () => true,
    async invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return registry() as T;
      if (command === "set_active_instance") {
        return registry((args as Record<string, string>).profileId) as T;
      }
      throw new Error(`unexpected ${command}`);
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  const remoteFactory = (profileId: string) => new Promise<InstanceRuntime>((resolve) => pending.set(profileId, resolve));
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}:{manager.activeProfile.label}</span>;
  }

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", closes)}
        createRemoteRuntime={remoteFactory}
      >
        <Probe />
      </InstanceProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.equal(manager.phase, "ready");
  assert.equal(manager.activeProfile.id, "local");

  await act(async () => { void manager.switchInstance(profiles[1]!.id); await Promise.resolve(); });
  assert.equal(manager.phase, "opening");
  assert.ok(closes.includes("local"));
  await act(async () => { void manager.switchInstance("local"); await Promise.resolve(); await Promise.resolve(); });
  assert.equal(manager.phase, "ready");

  await act(async () => {
    pending.get(profiles[1]!.id)!(runtime(profiles[1]!.id, closes));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.activeProfile.id, "local");
  assert.ok(closes.includes(profiles[1]!.id), "late remote runtime is closed instead of published");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("typed native open errors map to stable recovery states", () => {
  // Importing through the provider keeps the UI contract checked without parsing copy at call sites.
  return import("./InstanceProvider.js").then(({ remoteOpenFailureStatus }) => {
    assert.equal(remoteOpenFailureStatus({ code: "authentication-required", message: "Denied" }).availability, "authentication-required");
    assert.equal(remoteOpenFailureStatus({ code: "missing-credential", message: "Missing" }).availability, "missing-credential");
    assert.equal(remoteOpenFailureStatus({ code: "identity-changed", message: "Changed" }).availability, "incompatible");
    assert.equal(remoteOpenFailureStatus({ code: "offline", message: "Down" }).availability, "offline");
  });
});

test("default remote factory does not restart and close the active runtime after provider updates", async () => {
  let manager!: InstanceManager;
  let registryReads = 0;
  const closes: string[] = [];
  const desktop = {
    isTauri: () => true,
    async invoke<T>(command: string): Promise<T> {
      if (command === "instance_registry") {
        registryReads += 1;
        return registry() as T;
      }
      throw new Error(`unexpected ${command}`);
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}:{manager.statusByProfile.local?.availability}</span>;
  }
  domWindow.history.replaceState(null, "", "/");
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider desktop={desktop} createLocalRuntime={() => runtime("local", closes)}>
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "ready");
  await act(async () => { manager.reportActiveStatus({ availability: "online" }); });
  await act(async () => { manager.reportActiveStatus({ availability: "saved" }); });
  await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
  assert.equal(registryReads, 1);
  assert.deepEqual(closes, []);

  await act(async () => { root.unmount(); });
  assert.deepEqual(closes, ["local"]);
  container.remove();
});

test("a profile deleted by another app window becomes a recoverable missing route", async () => {
  let manager!: InstanceManager;
  let persistedRegistry = registry("local");
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(persistedRegistry as T);
      if (command === "set_active_instance") {
        persistedRegistry = { profiles: [profiles[0]!, profiles[2]!], activeInstanceId: "local" };
        return Promise.reject({ code: "missing-profile", message: "Gone" });
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}</span>;
  }
  domWindow.history.replaceState(null, "", "/");
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider desktop={desktop} createRemoteRuntime={async (profileId) => runtime(profileId, [])}>
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "ready");
  await act(async () => {
    await manager.switchInstance(profiles[1]!.id);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "missing");
  assert.equal(manager.activeProfile.id, profiles[1]!.id);
  assert.equal(manager.registry.profiles.some((profile) => profile.id === profiles[1]!.id), false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("retry persists a failed scoped-route selection before opening its runtime", async () => {
  let manager!: InstanceManager;
  let persisted = "local";
  let selectionAttempts = 0;
  let remoteOpens = 0;
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(registry(persisted) as T);
      if (command === "set_active_instance") {
        selectionAttempts += 1;
        if (selectionAttempts === 1) return Promise.reject(new Error("settings write failed"));
        persisted = (args as Record<string, string>).profileId!;
        return Promise.resolve(registry(persisted) as T);
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}:{manager.activeProfile.id}</span>;
  }
  domWindow.history.replaceState(null, "", instanceViewPath(profiles[1]!.id, { name: "board" }));
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createRemoteRuntime={async (profileId) => {
          remoteOpens += 1;
          return runtime(profileId, []);
        }}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "failed");
  assert.equal(manager.activeProfile.id, profiles[1]!.id, "the recovery shell retains the requested profile");
  assert.equal(remoteOpens, 0);

  await act(async () => { await manager.retryActive(); });
  assert.equal(selectionAttempts, 2);
  assert.equal(persisted, profiles[1]!.id);
  assert.equal(remoteOpens, 1);
  assert.equal(manager.phase, "ready");

  await act(async () => { root.unmount(); });
  container.remove();
  domWindow.history.replaceState(null, "", "/");
});

test("duplicate Retry clicks share one in-flight selection and remote open", async () => {
  let manager!: InstanceManager;
  let selectionAttempts = 0;
  let remoteOpens = 0;
  let finishRetry!: () => void;
  const retrySelection = new Promise<InstanceRegistrySnapshot>((resolve) => {
    finishRetry = () => resolve(registry(profiles[1]!.id));
  });
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(registry("local") as T);
      if (command === "set_active_instance") {
        selectionAttempts += 1;
        if (selectionAttempts === 1) return Promise.reject(new Error("settings write failed"));
        return retrySelection as Promise<T>;
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <button type="button" onClick={() => void manager.retryActive()}>Retry</button>;
  }
  domWindow.history.replaceState(null, "", instanceViewPath(profiles[1]!.id, { name: "board" }));
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createRemoteRuntime={async (profileId) => {
          remoteOpens += 1;
          return runtime(profileId, []);
        }}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "failed");
  assert.equal(selectionAttempts, 1);

  const retry = container.querySelector("button")!;
  await act(async () => {
    retry.click();
    retry.click();
    await Promise.resolve();
  });
  assert.equal(selectionAttempts, 2, "both clicks share one durable selection write");
  assert.equal(remoteOpens, 0, "the runtime waits for the in-flight selection");

  await act(async () => {
    finishRetry();
    await retrySelection;
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(selectionAttempts, 2);
  assert.equal(remoteOpens, 1);
  assert.equal(manager.phase, "ready");

  await act(async () => { await manager.retryActive(); });
  assert.equal(selectionAttempts, 3, "a settled guard releases a later retry");
  assert.equal(remoteOpens, 2);
  assert.equal(manager.phase, "ready");

  await act(async () => { root.unmount(); });
  container.remove();
  domWindow.history.replaceState(null, "", "/");
});

test("a superseded stalled retry cannot swallow a newer-generation Retry", async () => {
  let manager!: InstanceManager;
  let persisted = profiles[1]!.id;
  let remoteOpens = 0;
  const closes: string[] = [];
  let finishStalledOpen!: () => void;
  const stalledOpen = new Promise<InstanceRuntime>((resolve) => {
    finishStalledOpen = () => resolve(runtime(profiles[1]!.id, closes));
  });
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(registry(persisted) as T);
      if (command === "set_active_instance") {
        persisted = (args as Record<string, string>).profileId!;
        return Promise.resolve(registry(persisted) as T);
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  const createRemoteRuntime = (profileId: string): Promise<InstanceRuntime> => {
    remoteOpens += 1;
    if (remoteOpens === 1 || remoteOpens === 3) {
      return Promise.reject(new Error("remote unavailable"));
    }
    if (remoteOpens === 2) return stalledOpen;
    return Promise.resolve(runtime(profileId, closes));
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}:{manager.activeProfile.id}</span>;
  }
  domWindow.history.replaceState(null, "", instanceViewPath(profiles[1]!.id, { name: "board" }));
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", closes)}
        createRemoteRuntime={createRemoteRuntime}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "failed");
  assert.equal(remoteOpens, 1);

  let stalledRetry!: Promise<void>;
  await act(async () => {
    stalledRetry = manager.retryActive();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(manager.phase, "opening");
  assert.equal(remoteOpens, 2);

  await act(async () => { await manager.switchInstance("local"); });
  assert.equal(manager.phase, "ready");
  assert.equal(manager.activeProfile.id, "local");

  await act(async () => { await manager.switchInstance(profiles[1]!.id); });
  assert.equal(manager.phase, "failed");
  assert.equal(remoteOpens, 3);

  let freshRetry!: Promise<void>;
  await act(async () => {
    freshRetry = manager.retryActive();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(remoteOpens, 4, "the new generation starts a fresh remote open");
  await act(async () => { await freshRetry; });
  assert.equal(manager.phase, "ready");

  await act(async () => {
    finishStalledOpen();
    await stalledOpen;
    await stalledRetry;
    await Promise.resolve();
  });
  assert.ok(closes.includes(profiles[1]!.id), "the superseded runtime is closed when it arrives");
  assert.equal(manager.phase, "ready");

  await act(async () => { root.unmount(); });
  container.remove();
  domWindow.history.replaceState(null, "", "/");
});

test("rapid selections serialize durable active-profile writes in user order", async () => {
  let manager!: InstanceManager;
  let persisted = "local";
  const requested: string[] = [];
  const completions: Array<() => void> = [];
  const closes: string[] = [];
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(registry(persisted) as T);
      if (command === "set_active_instance") {
        const profileId = (args as Record<string, string>).profileId!;
        requested.push(profileId);
        return new Promise<T>((resolve) => completions.push(() => {
          persisted = profileId;
          resolve(registry(profileId) as T);
        }));
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.activeProfile.id}</span>;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", closes)}
        createRemoteRuntime={async (profileId) => runtime(profileId, closes)}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    void manager.switchInstance(profiles[1]!.id);
    void manager.switchInstance(profiles[2]!.id);
    await Promise.resolve();
  });
  assert.deepEqual(requested, [profiles[1]!.id], "the second durable write waits for the first");
  await act(async () => { completions.shift()!(); await Promise.resolve(); await Promise.resolve(); });
  assert.deepEqual(requested, [profiles[1]!.id, profiles[2]!.id]);
  await act(async () => { completions.shift()!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  assert.equal(persisted, profiles[2]!.id);
  assert.equal(manager.activeProfile.id, profiles[2]!.id);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("an active removal cannot overwrite a later instance selection", async () => {
  let manager!: InstanceManager;
  let persisted = "local";
  let currentProfiles = profiles;
  let finishRemoval!: () => void;
  const closes: string[] = [];
  const withoutA = [profiles[0]!, profiles[2]!];
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return Promise.resolve({ profiles: currentProfiles, activeInstanceId: persisted } as T);
      if (command === "set_active_instance") {
        persisted = (args as Record<string, string>).profileId!;
        return Promise.resolve({ profiles: currentProfiles, activeInstanceId: persisted } as T);
      }
      if (command === "remove_remote_instance") {
        return new Promise<T>((resolve) => {
          finishRemoval = () => {
            persisted = "local";
            currentProfiles = withoutA;
            resolve({ profiles: withoutA, activeInstanceId: "local" } as T);
          };
        });
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.activeProfile.id}</span>;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", closes)}
        createRemoteRuntime={async (profileId) => runtime(profileId, closes)}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => { await manager.switchInstance(profiles[1]!.id); });
  assert.equal(manager.activeProfile.id, profiles[1]!.id);

  await act(async () => {
    void manager.removeInstance(profiles[1]!.id);
    await Promise.resolve();
    void manager.switchInstance(profiles[2]!.id);
    await Promise.resolve();
  });
  await act(async () => { finishRemoval(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  assert.equal(persisted, profiles[2]!.id);
  assert.equal(manager.activeProfile.id, profiles[2]!.id);
  assert.equal(manager.registry.profiles.some((profile) => profile.id === profiles[1]!.id), false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a rejected active removal exits the spinner with a retryable restored profile", async () => {
  let manager!: InstanceManager;
  let persisted = "local";
  const closes: string[] = [];
  const desktop = {
    isTauri: () => true,
    invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      if (command === "instance_registry") return Promise.resolve(registry(persisted) as T);
      if (command === "set_active_instance") {
        persisted = (args as Record<string, string>).profileId!;
        return Promise.resolve(registry(persisted) as T);
      }
      if (command === "remove_remote_instance") return Promise.reject(new Error("credential vault unavailable"));
      return Promise.reject(new Error(`unexpected ${command}`));
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  function Probe() {
    manager = useInstances();
    return <span>{manager.phase}</span>;
  }
  domWindow.history.replaceState(null, "", "/");
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", closes)}
        createRemoteRuntime={async (profileId) => runtime(profileId, closes)}
      >
        <Probe />
      </InstanceProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => { await manager.switchInstance(profiles[1]!.id); });
  let removalError: unknown;
  await act(async () => {
    try {
      await manager.removeInstance(profiles[1]!.id);
    } catch (error) {
      removalError = error;
    }
    await Promise.resolve();
  });
  assert.match(String(removalError), /credential vault unavailable/);
  assert.equal(manager.phase, "failed");
  assert.equal(manager.activeProfile.id, profiles[1]!.id);
  assert.match(manager.error ?? "", /Could not remove Remote A: credential vault unavailable/);

  await act(async () => { await manager.retryActive(); });
  assert.equal(manager.phase, "ready");
  await act(async () => { root.unmount(); });
  container.remove();
});
