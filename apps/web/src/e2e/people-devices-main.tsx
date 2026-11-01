import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  DeviceView,
  IdentityAdministrationView,
  OrganizationRole,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { OfflineBanner } from "../components/OfflineBanner.js";
import { PairingBanner } from "../components/PairingBanner.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

// The production Connections view owns the tabs and the identity state; this fixture supplies only
// the control-plane responses, so tab switches and identity refreshes run through RunnersView.
const owner = "owner@example.com";
const nextOwner = "next.owner@example.net";
const member = "pat@example.org";
const renamedMember = "pat.renamed@example.org";
const organizationId = "organization-1";
const organizationName = "Fixture Organization";
// Opt-in states for the Team dialog's evidence (#3000), so the default directory the other specs
// count stays as it is: a suspended member who is already on the team, and a members save the
// server refuses.
const params = new URLSearchParams(window.location.search);
const withSuspendedMember = params.has("suspended");
const failMembers = params.has("failMembers");
// Opt-in states for the People and Devices list (#2997):
// - `role=admin|operator|viewer` signs in with that role, and adds Grace Hopper as another owner;
// - `extra` adds a second team and a laptop of the signed-in person's;
// - `deviceError` fails the device list until `__WOLLIPOG_PEOPLE_DEVICES_E2E__.fixDevices()`;
// - `onlyYou` leaves only the signed-in person, with no teams or devices;
// - `paired` is a paired (non-local) dashboard;
// - `pairing` refuses this device (1008), so the shell would show its pairing banner.
const role: OrganizationRole = (["admin", "operator", "viewer"] as const).find((value) => params.get("role") === value) ?? "owner";
const extra = params.has("extra");
const onlyYou = params.has("onlyYou");
let failDevices = params.has("deviceError");
const pairedDashboard = params.has("paired");
const pairingRequired = params.has("pairing");
// Pair Device's result (#2999): by default the common local setup, bound to this computer only;
// `?reach=lan` offers two addresses with a QR, and the other values each reason no link is offered.
const REACH: Record<string, { hosts: string[]; webServed: boolean; boundBeyondLoopback: boolean }> = {
  lan: { hosts: ["192.168.1.24", "100.101.102.103"], webServed: true, boundBeyondLoopback: true },
  loopback: { hosts: [], webServed: true, boundBeyondLoopback: false },
  "not-web-served": { hosts: [], webServed: false, boundBeyondLoopback: false },
  "no-address": { hosts: [], webServed: true, boundBeyondLoopback: true },
};
const reach = REACH[params.get("reach") ?? "loopback"] ?? REACH.loopback!;
if (params.has("theme")) document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

function identity(ownerName: string, memberName: string): IdentityAdministrationView {
  const membership = (userId: string, userName: string, memberRole: OrganizationRole, createdAt: number, userStatus: "active" | "suspended" = "active") =>
    ({ organizationId, organizationName, userId, userName, userStatus, role: memberRole, createdAt });
  return {
    context: {
      userId: "owner-1",
      userName: ownerName,
      organizationId,
      organizationName,
      role,
      deviceId: null,
      localBootstrap: !pairedDashboard,
    },
    organizations: [{ organizationId, name: organizationName, createdAt: 1 }],
    memberships: onlyYou ? [membership("owner-1", ownerName, role, 1)] : [
      membership("owner-1", ownerName, role, 1),
      membership("member-1", memberName, "operator", 2),
      ...(withSuspendedMember ? [membership("member-2", "Morgan Lee", "viewer", 4, "suspended")] : []),
      ...(role !== "owner" ? [membership("owner-2", "Grace Hopper", "owner", 5)] : []),
    ],
    teams: onlyYou ? [] : [{
      teamId: "team-1", organizationId, name: "Support",
      memberUserIds: withSuspendedMember ? ["member-1", "member-2"] : ["member-1"], createdAt: 3,
    }, ...(extra ? [{
      teamId: "team-2", organizationId, name: "Release Crew", memberUserIds: ["owner-1", "member-1"], createdAt: 6,
    }] : [])],
  };
}

let currentIdentity = identity(owner, member);
let devices: DeviceView[] = onlyYou ? [] : [{
  deviceId: "device-1",
  name: "Pat's Phone",
  createdAt: Date.now() - 60_000,
  lastSeenAt: null,
  userId: "member-1",
  userName: member,
  organizationId,
  organizationName,
  role: "operator",
}, ...(extra ? [{
  deviceId: "device-3",
  name: "Home Laptop",
  createdAt: Date.now() - 3 * 86_400_000,
  lastSeenAt: Date.now() - 2 * 3_600_000,
  userId: "owner-1",
  userName: owner,
  organizationId,
  organizationName,
  role,
}] : [])];
let identityRequests = 0;
let deviceRequests = 0;
let online = true;
const sockets: FixtureSocket[] = [];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      createProjectLocations: true,
    },
    runners: [],
    boxes: [],
    projects: [],
    sessions: [],
    runs: [],
    pods: [],
  };
}

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    sockets.push(this);
    window.setTimeout(() => {
      // The control plane opens, then policy-closes an unpaired device's socket (1008).
      if (pairingRequired) {
        this.onopen?.();
        this.onclose?.({ code: 1008 });
        return;
      }
      // While offline a reconnect never opens; it fails as an abnormal close.
      if (!online) {
        this.onclose?.({ code: 1006 });
        return;
      }
      this.onopen?.();
      this.push(snapshot());
    }, 0);
  }
  send() {}
  close() {}
  push(message: ControlPlaneToUi): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connection: UiConnectionRuntime = {
  instanceId: "people-devices-e2e",
  runtimeKey: "people-devices-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "runners", section: "people" }),
  push() {},
  listen: () => () => {},
};

const client: ApiClient = {
  ...api,
  getIdentity: async () => {
    identityRequests += 1;
    if (pairingRequired) throw new ApiError("this device is not paired", 401);
    if (!online) throw new Error("Failed to fetch");
    return structuredClone(currentIdentity);
  },
  listDevices: async () => {
    deviceRequests += 1;
    if (!online) throw new Error("Failed to fetch");
    if (failDevices) throw new ApiError("SQLITE_BUSY: database is locked (devices)", 500);
    return { devices: structuredClone(devices) };
  },
  revokeDevice: async (deviceId) => {
    devices = devices.filter((device) => device.deviceId !== deviceId);
  },
  pairDevice: async (name, userId) => ({
    device: { ...devices[0]!, deviceId: "device-2", name, userId: userId ?? "member-1" },
    // A real token's length (43), so Manual Setup shows its ellipsis; never a real credential.
    token: "fixture_pairing_token_not_a_real_credential",
    pairing: { ...reach, port: 4317 },
  }),
  renameIdentityTeam: async (teamId, name) => {
    if (currentIdentity.teams.some((team) => team.teamId !== teamId && team.name === name)) {
      throw new ApiError("another team in this organization already has this name", 409, "team_name_taken");
    }
    currentIdentity = {
      ...currentIdentity,
      teams: currentIdentity.teams.map((team) => team.teamId === teamId ? { ...team, name } : team),
    };
    return { team: currentIdentity.teams.find((team) => team.teamId === teamId)! };
  },
  updateIdentityTeamMembers: async (teamId, memberUserIds) => {
    if (failMembers) {
      throw new ApiError(
        "cannot remove user 'member-1' from this team because Session 's_1' containment in Project 'p_1' relies on that membership; change the related access scopes first",
        409,
        "team_member_containment",
      );
    }
    currentIdentity = {
      ...currentIdentity,
      teams: currentIdentity.teams.map((team) => team.teamId === teamId ? { ...team, memberUserIds } : team),
    };
    return { team: currentIdentity.teams.find((team) => team.teamId === teamId)! };
  },
};

declare global {
  interface Window {
    __WOLLIPOG_PEOPLE_DEVICES_E2E__: {
      /** Rename the signed-in owner and the member on the server, as another client would. */
      renameEveryone(): void;
      identityRequests(): number;
      deviceRequests(): number;
      /** Let the device list load after a `deviceError` start. */
      fixDevices(): void;
      /** Drop the connection, as a control plane that went away would: reconnects never open. */
      goOffline(): void;
    };
  }
}

window.__WOLLIPOG_PEOPLE_DEVICES_E2E__ = {
  renameEveryone: () => {
    currentIdentity = { ...identity(nextOwner, renamedMember), teams: currentIdentity.teams };
    devices = devices.map((device) => ({ ...device, userName: device.userId === "owner-1" ? nextOwner : renamedMember }));
  },
  identityRequests: () => identityRequests,
  deviceRequests: () => deviceRequests,
  fixDevices: () => {
    failDevices = false;
  },
  goOffline: () => {
    online = false;
    for (const socket of sockets.splice(0)) socket.onclose?.({ code: 1006 });
  },
};

/** The shell's banners, as App places them above the page, so evidence shows the tab under each. */
function FixtureBanner() {
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  if (conn === "unauthorized") return <PairingBanner connecting={false} nativePairingFailure={null} />;
  if (snapshotLoaded && conn !== "online") return <OfflineBanner connecting={conn === "connecting"} onRetryNow={() => false} />;
  return null;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="people-devices-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            {/* The production `.app > main.main > .main-body` structure, so the page container
                takes its real width rather than shrinking to its content. */}
            <div className="app" style={{ minHeight: "100vh" }}>
              <main className="main">
                <FixtureBanner />
                <div className="main-body">
                  <RunnersView />
                </div>
              </main>
            </div>
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
