import { browserRandomUUID } from "../browser-crypto.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "../api.js";
import type { InstanceProfile, InstanceRegistrySnapshot } from "../desktop-instances.js";
import { InstanceProvider } from "../InstanceProvider.js";
import type { InstanceRuntime } from "../instance-runtime.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InstanceSelector } from "../components/InstanceSelector.js";
import { InstancesPanel } from "../components/InstancesPanel.js";
import { Rail } from "../components/Rail.js";
import "../styles.css";

const STORAGE_KEY = "wollipog.e2e.instance-registry";
const localProfile: InstanceProfile = {
  id: "local",
  serverInstanceId: "local",
  kind: "local",
  label: "This Machine",
  origin: "http://127.0.0.1:4317",
  createdAt: "",
};

function loadRegistry(): InstanceRegistrySnapshot {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return { profiles: [localProfile], activeInstanceId: "local" };
  return JSON.parse(stored) as InstanceRegistrySnapshot;
}

let registry = loadRegistry();
const openFailures = new Map<string, { code: string; message: string }>();
const closedRuntimes: string[] = [];

function saveRegistry(next: InstanceRegistrySnapshot): InstanceRegistrySnapshot {
  registry = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function runtime(instanceId: string, publicOrigin: string): InstanceRuntime {
  const transport = {
    instanceId,
    publicOrigin,
    async request() { return new Response("{}"); },
    close() {},
  };
  return {
    instanceId,
    publicOrigin,
    api: createApiClient(transport),
    ui: {
      instanceId,
      runtimeKey: `${instanceId}:${browserRandomUUID()}`,
      createSocket() { throw new Error("The E2E management fixture does not mount a session socket."); },
      close() {},
    },
    close() { closedRuntimes.push(instanceId); },
  };
}

const desktop = {
  isTauri: () => true,
  async invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
    const input = (args ?? {}) as Record<string, string>;
    if (command === "instance_registry") return structuredClone(registry) as T;
    if (command === "set_active_instance") {
      if (!registry.profiles.some((profile) => profile.id === input.profileId)) {
        throw { code: "missing-profile", message: "The selected Wollipog instance no longer exists." };
      }
      return structuredClone(saveRegistry({ ...registry, activeInstanceId: input.profileId! })) as T;
    }
    if (command === "add_remote_instance") {
      const id = `remote-${registry.profiles.filter((profile) => profile.kind === "remote").length + 1}`;
      const profile: InstanceProfile = {
        id,
        serverInstanceId: `server-${id}`,
        kind: "remote",
        label: input.label!,
        origin: input.origin!,
        createdAt: "2026-07-21T12:00:00.000Z",
        lastConnectedAt: "2026-07-21T12:00:00.000Z",
      };
      return structuredClone(saveRegistry({ profiles: [...registry.profiles, profile], activeInstanceId: registry.activeInstanceId })) as T;
    }
    if (command === "edit_remote_instance") {
      return structuredClone(saveRegistry({
        ...registry,
        profiles: registry.profiles.map((profile) => profile.id === input.profileId
          ? { ...profile, label: input.label!, origin: input.origin! }
          : profile),
      })) as T;
    }
    if (command === "repair_remote_instance") return structuredClone(registry) as T;
    if (command === "remove_remote_instance") {
      const profiles = registry.profiles.filter((profile) => profile.id !== input.profileId);
      const activeInstanceId = registry.activeInstanceId === input.profileId ? "local" : registry.activeInstanceId;
      return structuredClone(saveRegistry({ profiles, activeInstanceId })) as T;
    }
    throw new Error(`Unexpected E2E command: ${command}`);
  },
  channel<T>() { return { onmessage: (_event: T) => {} }; },
};

declare global {
  interface Window {
    __WOLLIPOG_INSTANCE_E2E__: {
      failNextOpen(profileId: string, code: string, message: string): void;
      registry(): InstanceRegistrySnapshot;
      closedRuntimes(): string[];
    };
  }
}

window.__WOLLIPOG_INSTANCE_E2E__ = {
  failNextOpen(profileId, code, message) { openFailures.set(profileId, { code, message }); },
  registry: () => structuredClone(registry),
  closedRuntimes: () => [...closedRuntimes],
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <FeedbackProvider>
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", localProfile.origin)}
        createRemoteRuntime={async (profileId) => {
          const failure = openFailures.get(profileId);
          if (failure) {
            openFailures.delete(profileId);
            throw failure;
          }
          const profile = registry.profiles.find((candidate) => candidate.id === profileId);
          if (!profile) throw { code: "missing-profile", message: "The remote profile no longer exists." };
          return runtime(profileId, profile.origin);
        }}
      >
        <div className="app">
          <Rail
            view={{ name: "inbox" }}
            blockedCount={0}
            stalledCount={0}
            onlineConnections={1}
            onNavigate={() => undefined}
            instanceControl={<InstanceSelector compact />}
            settingsControl={<button type="button" className="settings-trigger">Settings</button>}
          />
          <main className="main">
            <div className="main-body"><InstancesPanel /></div>
          </main>
        </div>
      </InstanceProvider>
    </FeedbackProvider>
  </React.StrictMode>,
);
