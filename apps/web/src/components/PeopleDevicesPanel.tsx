import React, { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
  TeamView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { DeviceIcon, EditIcon, PlusIcon, TeamIcon, UserPlusIcon } from "./Icons.js";
import { useFeedback } from "./FeedbackProvider.js";
import { TeamDialog } from "./TeamDialog.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { AddPersonDialog, ManagePersonDialog } from "./PersonAccessDialogs.js";
import { PairDeviceDialog } from "./PairDeviceDialog.js";

type AccessDialog =
  | { kind: "add-person" }
  | { kind: "manage-person"; member: OrganizationMembershipView }
  | { kind: "pair-device" }
  | { kind: "create-team" }
  | { kind: "manage-team"; team: TeamView };

export function PeopleDevicesPanel({
  identity,
  onIdentityChange,
}: {
  identity: IdentityAdministrationView;
  onIdentityChange: (identity: IdentityAdministrationView) => void;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [dialog, setDialog] = useState<AccessDialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const admin = identity.context.role === "owner" || identity.context.role === "admin";
  const canPair = admin && identity.context.localBootstrap;

  const refresh = async () => {
    setError(null);
    try {
      const nextIdentity = await api.getIdentity();
      const nextAdmin = nextIdentity.context.role === "owner" || nextIdentity.context.role === "admin";
      const nextDevices = nextAdmin ? await api.listDevices() : { devices: [] };
      onIdentityChange(nextIdentity);
      setDevices(nextDevices.devices);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [api]);

  const revoke = async (device: DeviceView) => {
    if (!canPair || !await confirm({
      title: "Revoke Device",
      message: `“${device.name}” loses access immediately. Pair it again to restore access.`,
      confirmLabel: "Revoke Device",
      tone: "danger",
    })) return;
    try {
      await api.revokeDevice(device.deviceId);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const people = useMemo(
    () => [...identity.memberships].sort((a, b) => a.userName.localeCompare(b.userName)),
    [identity.memberships],
  );
  const teams = useMemo(() => [...identity.teams].sort((a, b) => a.name.localeCompare(b.name)), [identity.teams]);

  return (
    <div className="access-page">
      <div className="access-page-intro">
        <div>
          <h2>People &amp; Devices</h2>
          <p>
            Manage who can use this organization and which devices can connect. Forms open only when
            you start a specific task.
          </p>
        </div>
        <span className="access-context">
          <PersonalIdentifier value={identity.context.userName} label="Your Name" lead="Signed in as" /> · {identity.context.role}
        </span>
      </div>
      {error && <div className="connection-access-error" role="alert">{error}</div>}

      <section className="access-section" aria-labelledby="people-heading">
        <div className="access-section-head">
          <div className="access-section-title">
            <UserPlusIcon />
            <div>
              <h3 id="people-heading">People</h3>
              <p>{people.length === 1 ? "Only you have access." : `${people.length} people have organization access.`}</p>
            </div>
          </div>
          {admin && (
            <button type="button" className="btn access-task-button" onClick={() => setDialog({ kind: "add-person" })}>
              <PlusIcon />
              <span>Add Person</span>
            </button>
          )}
        </div>
        <div className="access-list">
          {people.map((member) => {
            const protectedOwner = identity.context.role !== "owner" && member.role === "owner";
            return (
              <div className="access-row" key={member.userId}>
                <div className="access-row-main">
                  <strong><PersonalIdentifier value={member.userName} label="Person Name" lead="Person" /></strong>
                  <span className="access-row-meta">
                    <StatusBadge tone="neutral" noDot label={titleCaseLabel(member.role)} />
                    <StatusBadge meta={statusMeta("member", member.userStatus)} />
                  </span>
                </div>
                {admin && (
                  <button
                    type="button"
                    className="btn subtle access-row-action"
                    disabled={member.userId === identity.context.userId || protectedOwner}
                    onClick={() => setDialog({ kind: "manage-person", member })}
                  >
                    <EditIcon />
                    <span>Manage</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="access-section" aria-labelledby="devices-heading">
        <div className="access-section-head">
          <div className="access-section-title">
            <DeviceIcon />
            <div>
              <h3 id="devices-heading">Paired Devices</h3>
              <p>Credentials for dashboards that connect beyond this control-plane machine.</p>
            </div>
          </div>
          {canPair && (
            <button type="button" className="btn access-task-button" onClick={() => setDialog({ kind: "pair-device" })}>
              <PlusIcon />
              <span>Pair Device</span>
            </button>
          )}
        </div>
        {!identity.context.localBootstrap && (
          <div className="connection-access-note" role="note">
            Pairing and revocation must be started from this instance’s trusted local dashboard.
          </div>
        )}
        {loading && <div className="access-empty-copy">Loading paired devices…</div>}
        {!loading && devices?.length === 0 && (
          <div className="access-empty">
            <strong>No remote devices are paired.</strong>
            <span>{canPair ? "Pair a phone or another computer when you need remote dashboard access." : "Pairing must be started from the trusted local dashboard."}</span>
          </div>
        )}
        {devices && devices.length > 0 && (
          <div className="access-list">
            {devices.map((device) => (
              <div className="access-row" key={device.deviceId}>
                <div className="access-row-main">
                  <strong>{device.name}</strong>
                  <span><PersonalIdentifier value={device.userName} label="Person Name" lead="Person" /> · {titleCaseLabel(device.role)}</span>
                  <small>
                    Paired {relativeTime(device.createdAt)}
                    {device.lastSeenAt == null ? " · never used" : ` · last seen ${relativeTime(device.lastSeenAt)}`}
                  </small>
                </div>
                {canPair && (
                  <button type="button" className="btn subtle danger-text access-row-action" onClick={() => void revoke(device)}>
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="access-section" aria-labelledby="teams-heading">
        <div className="access-section-head">
          <div className="access-section-title">
            <TeamIcon />
            <div>
              <div className="access-heading-line">
                <h3 id="teams-heading">Teams</h3>
                <span className="access-secondary-badge">Advanced</span>
              </div>
              <p>Use teams when machines and work need a shared ownership scope.</p>
            </div>
          </div>
          {admin && (
            <button type="button" className="btn access-task-button" onClick={() => setDialog({ kind: "create-team" })}>
              <PlusIcon />
              <span>Create Team</span>
            </button>
          )}
        </div>
        {teams.length === 0 ? (
          <div className="access-empty">
            <strong>No teams yet.</strong>
            <span>Most personal fleets do not need one. Create a team only for shared ownership.</span>
          </div>
        ) : (
          <div className="access-list">
            {teams.map((team) => (
              <div className="access-row" key={team.teamId}>
                <div className="access-row-main">
                  <strong>{team.name}</strong>
                  <span>{team.memberUserIds.length} Member{team.memberUserIds.length === 1 ? "" : "s"}</span>
                </div>
                {admin && (
                  <button type="button" className="btn subtle access-row-action" onClick={() => setDialog({ kind: "manage-team", team })}>
                    <EditIcon />
                    <span>Manage</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {dialog?.kind === "add-person" && (
        <AddPersonDialog
          actorRole={identity.context.role}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === "manage-person" && (
        <ManagePersonDialog
          actorRole={identity.context.role}
          member={dialog.member}
          pairedDevices={canPair && devices
            ? devices.filter((device) => device.userId === dialog.member.userId).length
            : null}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === "pair-device" && (
        <PairDeviceDialog identity={identity} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
      {dialog?.kind === "create-team" && (
        <TeamDialog identity={identity} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
      {dialog?.kind === "manage-team" && (
        <TeamDialog identity={identity} team={dialog.team} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
    </div>
  );
}
