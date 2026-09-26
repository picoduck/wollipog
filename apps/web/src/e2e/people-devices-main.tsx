import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DeviceView, IdentityAdministrationView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { PeopleDevicesPanel } from "../components/PeopleDevicesPanel.js";
import "../styles.css";

const owner = "owner@example.com";
const nextOwner = "next.owner@example.net";
const member = "pat@example.org";
const organizationId = "organization-1";
const organizationName = "Fixture Organization";

function identity(ownerName: string): IdentityAdministrationView {
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
      { organizationId, organizationName, userId: "member-1", userName: member, userStatus: "active", role: "operator", createdAt: 2 },
    ],
    teams: [{ teamId: "team-1", organizationId, name: "Support", memberUserIds: ["member-1"], createdAt: 3 }],
  };
}

let currentIdentity = identity(owner);
const devices: DeviceView[] = [{
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

const client: ApiClient = {
  ...api,
  getIdentity: async () => currentIdentity,
  listDevices: async () => ({ devices }),
  pairDevice: async (name, userId) => ({
    device: { ...devices[0]!, deviceId: "device-2", name, userId: userId ?? "member-1" },
    token: "fixture_pairing_token",
    pairing: { hosts: [], port: 443, webServed: false, boundBeyondLoopback: false },
  }),
};

function Fixture() {
  const [shownIdentity, setShownIdentity] = useState(currentIdentity);
  const [open, setOpen] = useState(true);
  const switchIdentity = () => {
    currentIdentity = identity(nextOwner);
    setShownIdentity(currentIdentity);
  };

  return (
    <FeedbackProvider>
      <ApiProvider client={client}>
        <div className="app" style={{ minHeight: "100vh" }}>
          <div className="fixture-controls">
            <button type="button" onClick={switchIdentity}>Change Identity</button>
          </div>
          <div className="connections-tabs" role="tablist" aria-label="Connection Settings">
            <button type="button" id="connections-machines-tab" role="tab" aria-selected={!open}
              aria-controls="connections-machines-panel" onClick={() => setOpen(false)}>Machines</button>
            <button type="button" id="connections-people-tab" role="tab" aria-selected={open}
              aria-controls="connections-people-panel" onClick={() => setOpen(true)}>People &amp; Devices</button>
          </div>
          {open ? (
            <div id="connections-people-panel" role="tabpanel" aria-labelledby="connections-people-tab"
              className="connections-panel access-panel">
              <PeopleDevicesPanel identity={shownIdentity} onIdentityChange={setShownIdentity} />
            </div>
          ) : (
            <div id="connections-machines-panel" role="tabpanel" aria-labelledby="connections-machines-tab"
              className="connections-panel">Machines</div>
          )}
        </div>
      </ApiProvider>
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
