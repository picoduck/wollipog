import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  DeviceView,
  IdentityAdministrationView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
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
  return {
    context: {
      userId: "owner-1",
      userName: ownerName,
      organizationId,
      organizationName,
      role: "owner",
      deviceId: null,
      localBootstrap: true,
    },
    organizations: [{ organizationId, name: organizationName, createdAt: 1 }],
    memberships: [
      { organizationId, organizationName, userId: "owner-1", userName: ownerName, userStatus: "active", role: "owner", createdAt: 1 },
      { organizationId, organizationName, userId: "member-1", userName: memberName, userStatus: "active", role: "operator", createdAt: 2 },
      ...(withSuspendedMember ? [{
        organizationId, organizationName, userId: "member-2", userName: "Morgan Lee", userStatus: "suspended" as const, role: "viewer" as const, createdAt: 4,
      }] : []),
    ],
    teams: [{
      teamId: "team-1", organizationId, name: "Support",
      memberUserIds: withSuspendedMember ? ["member-1", "member-2"] : ["member-1"], createdAt: 3,
    }],
  };
}

let currentIdentity = identity(owner, member);
let devices: DeviceView[] = [{
  deviceId: "device-1",
  name: "Pat's Phone",
  createdAt: Date.now() - 60_000,
  lastSeenAt: null,
  userId: "member-1",
  userName: member,
  organizationId,
  organizationName,
  role: "operator",
}];
let identityRequests = 0;

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
    window.setTimeout(() => {
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
    return structuredClone(currentIdentity);
  },
  listDevices: async () => ({ devices: structuredClone(devices) }),
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
    };
  }
}

window.__WOLLIPOG_PEOPLE_DEVICES_E2E__ = {
  renameEveryone: () => {
    currentIdentity = { ...identity(nextOwner, renamedMember), teams: currentIdentity.teams };
    devices = devices.map((device) => ({ ...device, userName: renamedMember }));
  },
  identityRequests: () => identityRequests,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="people-devices-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <div className="app" style={{ minHeight: "100vh" }}>
              <RunnersView />
            </div>
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
