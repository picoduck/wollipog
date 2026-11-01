import { browserRandomUUID } from "../browser-crypto.js";
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "../api.js";
import type { InstanceProfile, InstanceRegistrySnapshot } from "../desktop-instances.js";
import { InstanceProvider } from "../InstanceProvider.js";
import type { InstanceRuntime } from "../instance-runtime.js";
import {
  ActiveInstanceConnectionProvider,
  useInstances,
  type ActiveInstanceConnection,
} from "../instances-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InstanceSelector } from "../components/InstanceSelector.js";
import { addRemoteInstanceAction, InstancesPanel } from "../components/InstancesPanel.js";
import { OfflineBanner } from "../components/OfflineBanner.js";
import { PageHeader } from "../components/PageHeader.js";
import { Rail } from "../components/Rail.js";
import { RemoteInstanceBanner } from "../components/RemoteInstanceBanner.js";
import { SettingsTrigger } from "../components/SettingsTrigger.js";
import { useRailPreferences } from "../use-rail-preferences.js";
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
const MUTATIONS = new Set(["add_remote_instance", "edit_remote_instance", "repair_remote_instance"]);
let nextMutationFailure: string | null = null;
let heldOpen: { profileId: string; released: Promise<void> } | null = null;
let releaseHeldOpen: () => void = () => undefined;

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
    if (nextMutationFailure && MUTATIONS.has(command)) {
      const message = nextMutationFailure;
      nextMutationFailure = null;
      // The desktop commands reject with a plain string, as instances.rs does.
      throw message;
    }
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
      /** The next add, edit or re-pair rejects with this desktop message. */
      failNextMutation(message: string): void;
      /** The next connection to this profile stays open (Connecting) until `releaseOpen`. */
      holdNextOpen(profileId: string): void;
      releaseOpen(): void;
      /** What the shell's banner says about the active instance's connection. */
      setConnection(connection: ActiveInstanceConnection | null): void;
      registry(): InstanceRegistrySnapshot;
      closedRuntimes(): string[];
    };
  }
}

window.__WOLLIPOG_INSTANCE_E2E__ = {
  failNextOpen(profileId, code, message) { openFailures.set(profileId, { code, message }); },
  failNextMutation(message) { nextMutationFailure = message; },
  holdNextOpen(profileId) {
    heldOpen = { profileId, released: new Promise<void>((resolve) => { releaseHeldOpen = resolve; }) };
  },
  releaseOpen() { releaseHeldOpen(); },
  setConnection(connection) { setHarnessConnection(connection); },
  registry: () => structuredClone(registry),
  closedRuntimes: () => [...closedRuntimes],
};

let setHarnessConnection: (connection: ActiveInstanceConnection | null) => void = () => undefined;

/** The shell's part: the rail with the tile, and the banner the tile must agree with (#1970). */
function Shell() {
  const instances = useInstances();
  const [connection, setConnection] = useState<ActiveInstanceConnection | null>(null);
  setHarnessConnection = setConnection;
  const { labels } = useRailPreferences();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <ActiveInstanceConnectionProvider value={connection}>
      <div className="app">
        <Rail
          view={{ name: "inbox" }}
          blockedCount={0}
          stalledCount={0}
          onNavigate={() => undefined}
          instanceControl={<InstanceSelector labelled={labels} />}
          // The shell's own Settings item and page container, so captures show what production draws.
          settingsControl={<SettingsTrigger active={false} onOpen={() => undefined} />}
          onSearch={() => undefined}
        />
        <main className="main">
          {connection && (instances.activeProfile.kind === "remote"
            ? <RemoteInstanceBanner authenticationRequired={connection === "sign-in-required"} />
            : connection === "reconnecting" && <OfflineBanner connecting={false} onRetryNow={() => false} developmentBuild={false} />)}
          {/* The Connections page's header and Instances tab, as RunnersView draws them (#3002). */}
          <div className="main-body">
            <div className="page">
              <PageHeader title="Connections" primary={addRemoteInstanceAction(instances, addButtonRef)} />
              <div className="connections-panel"><InstancesPanel addButtonRef={addButtonRef} /></div>
            </div>
          </div>
        </main>
      </div>
    </ActiveInstanceConnectionProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <FeedbackProvider>
      <InstanceProvider
        desktop={desktop}
        createLocalRuntime={() => runtime("local", localProfile.origin)}
        createRemoteRuntime={async (profileId) => {
          if (heldOpen?.profileId === profileId) {
            const { released } = heldOpen;
            heldOpen = null;
            await released;
          }
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
        <Shell />
      </InstanceProvider>
    </FeedbackProvider>
  </React.StrictMode>,
);
