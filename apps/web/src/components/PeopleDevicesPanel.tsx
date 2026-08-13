import React, { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
  OrganizationRole,
  TeamView,
  UserStatus,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { pairingLinks } from "../device-token.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { CopyButton, Modal } from "./common.js";
import { DeviceIcon, EditIcon, PlusIcon, TeamIcon, UserPlusIcon } from "./Icons.js";
import { useFeedback } from "./FeedbackProvider.js";

type AccessDialog =
  | { kind: "add-person" }
  | { kind: "manage-person"; member: OrganizationMembershipView }
  | { kind: "pair-device" }
  | { kind: "create-team" }
  | { kind: "manage-team"; team: TeamView };

const ROLE_HELP: Record<OrganizationRole, string> = {
  owner: "Full organization control, including ownership and administrator changes.",
  admin: "Manage connections, people, teams, and paired devices.",
  operator: "Run and manage work without changing organization access.",
  viewer: "Read-only access to shared work and connection status.",
};

function RoleOptions({ actorRole }: { actorRole: OrganizationRole }) {
  return (
    <>
      <option value="owner" disabled={actorRole !== "owner"}>Owner</option>
      <option value="admin">Admin</option>
      <option value="operator">Operator</option>
      <option value="viewer">Viewer</option>
    </>
  );
}

function DialogError({ error }: { error: string | null }) {
  return error ? <div className="form-error" role="alert">{error}</div> : null;
}

function AddPersonDialog({
  actorRole,
  onClose,
  onSaved,
}: {
  actorRole: OrganizationRole;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [role, setRole] = useState<OrganizationRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createIdentityMember({ displayName: name.trim(), role });
      await onSaved();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a Person"
      onClose={onClose}
      describedBy="add-person-description"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add Person"}
          </button>
        </>
      }
    >
      <p className="access-dialog-intro" id="add-person-description">
        Add the person first. You can pair a device for them after their access level is set.
      </p>
      <div className="access-form">
        <label>
          <span>Name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Person name" />
        </label>
        <label>
          <span>Access Level</span>
          <select value={role} onChange={(event) => setRole(event.target.value as OrganizationRole)}>
            <RoleOptions actorRole={actorRole} />
          </select>
          <small>{ROLE_HELP[role]}</small>
        </label>
        <DialogError error={error} />
      </div>
    </Modal>
  );
}

function ManagePersonDialog({
  actorRole,
  member,
  onClose,
  onSaved,
}: {
  actorRole: OrganizationRole;
  member: OrganizationMembershipView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const [displayName, setDisplayName] = useState(member.userName);
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState<UserStatus>(member.userStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy || !displayName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateIdentityMember(member.userId, {
        displayName: displayName.trim(),
        role,
        status,
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Manage ${member.userName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || !displayName.trim()}>
            {busy ? "Saving…" : "Save Changes"}
          </button>
        </>
      }
    >
      <div className="access-form">
        <label>
          <span>Name</span>
          <input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          <span>Access Level</span>
          <select value={role} onChange={(event) => setRole(event.target.value as OrganizationRole)}>
            <RoleOptions actorRole={actorRole} />
          </select>
          <small>{ROLE_HELP[role]}</small>
        </label>
        <label>
          <span>Account Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as UserStatus)}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <small>Suspending access invalidates this person's authenticated requests.</small>
        </label>
        <DialogError error={error} />
      </div>
    </Modal>
  );
}

export function PairDeviceDialog({
  identity,
  onClose,
  onSaved,
}: {
  identity: IdentityAdministrationView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const activeMembers = identity.memberships.filter((member) => member.userStatus === "active");
  const [step, setStep] = useState<"person" | "device" | "success">("person");
  const [userId, setUserId] = useState(
    activeMembers.some((member) => member.userId === identity.context.userId)
      ? identity.context.userId
      : activeMembers[0]?.userId ?? "",
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    token: string;
    links: string[];
    blocked: string | null;
  } | null>(null);
  const [selectedPairingLink, setSelectedPairingLink] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  const person = activeMembers.find((member) => member.userId === userId);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const pair = async () => {
    if (busy || !name.trim() || !userId) return;
    setBusy(true);
    setError(null);
    let response: Awaited<ReturnType<typeof api.pairDevice>>;
    try {
      response = await api.pairDevice(name.trim(), userId);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
      return;
    }

    // The credential is returned exactly once. Reveal it as soon as creation succeeds; refreshing
    // the surrounding lists is useful but must never make the only plaintext copy inaccessible.
    const pairing = pairingLinks(response.token, response.pairing);
    setResult({ token: response.token, ...pairing });
    setSelectedPairingLink(pairing.links[0] ?? "");
    setStep("success");
    setBusy(false);
    try {
      await onSaved();
    } catch (cause) {
      if (mountedRef.current) {
        setError(`Device created, but the device list could not be refreshed: ${(cause as Error).message}`);
      }
    }
  };
  if (step === "success" && result) {
    const primaryLink = result.links.includes(selectedPairingLink)
      ? selectedPairingLink
      : result.links[0] ?? null;
    const copyValue = primaryLink ?? `#pair=${result.token}`;
    return (
      <Modal
        title="Device Ready to Pair"
        onClose={requestClose}
        footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}
      >
        <div className="access-success" role="status">
          <strong>{name}</strong> is ready for {person?.userName ?? "this person"}. This credential is shown once.
        </div>
        {primaryLink ? (
          <section className="access-pairing-qr" aria-labelledby="pair-device-qr-heading">
            <h3 id="pair-device-qr-heading">Scan to Pair</h3>
            {result.links.length > 1 && (
              <label className="access-pairing-address">
                Network Address
                <select
                  value={primaryLink ?? ""}
                  onChange={(event) => setSelectedPairingLink(event.target.value)}
                >
                  {result.links.map((link) => (
                    <option key={link} value={link}>{new URL(link).host}</option>
                  ))}
                </select>
                <small>Choose an address the device you are pairing can reach.</small>
              </label>
            )}
            <div className="access-pairing-qr-frame">
              <QRCodeSVG
                value={primaryLink}
                title={`Pair ${name} with Wollipog`}
                size={208}
                level="M"
                marginSize={4}
              />
            </div>
            <p>On the device you are pairing, open the camera and scan this code.</p>
            <CopyButton text={copyValue} label="Copy Pairing Link" className="btn" />
          </section>
        ) : (
          <div className="access-copy-primary">
            <CopyButton text={copyValue} label="Copy Pairing Link" className="btn primary" />
          </div>
        )}
        {result.blocked && <p className="hint">{result.blocked}</p>}
        <DialogError error={error} />
        <details className="access-manual-disclosure">
          <summary>Manual Setup</summary>
          <p className="hint">Use this only when the dashboard cannot provide a clickable pairing link.</p>
          <pre className="code-block install-cmd">
            {`#pair=${result.token}`}
            <CopyButton text={`#pair=${result.token}`} />
          </pre>
          <pre className="code-block install-cmd">
            {result.token}
            <CopyButton text={result.token} />
          </pre>
        </details>
      </Modal>
    );
  }
  return (
    <Modal
      title={step === "person" ? "Who is this device for?" : "Name the device"}
      onClose={requestClose}
      footer={step === "person"
        ? (
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => setStep("device")} disabled={!userId}>Continue</button>
          </>
        )
        : (
          <>
            <button type="button" className="btn" onClick={() => setStep("person")} disabled={busy}>Back</button>
            <button type="button" className="btn primary" onClick={() => void pair()} disabled={busy || !name.trim()}>
              {busy ? "Pairing…" : "Create Pairing"}
            </button>
          </>
        )}
    >
      {step === "person" ? (
        <div className="access-choice-list" role="radiogroup" aria-label="Person">
          {activeMembers.map((member) => (
            <label className={`access-choice${userId === member.userId ? " selected" : ""}`} key={member.userId}>
              <input
                type="radio"
                name="pair-person"
                value={member.userId}
                checked={userId === member.userId}
                onChange={() => setUserId(member.userId)}
              />
              <span>
                <strong>{member.userName}</strong>
                <small>{titleCaseLabel(member.role)} Access</small>
              </span>
            </label>
          ))}
          {activeMembers.length === 0 && <div className="access-empty-copy">Add an active person before pairing a device.</div>}
        </div>
      ) : (
        <div className="access-form">
          <p className="access-dialog-intro">
            Pairing for <strong>{person?.userName}</strong>. Use a name they will recognize later.
          </p>
          <label>
            <span>Device Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="For example, Pixel 9 or Home laptop"
            />
          </label>
          <DialogError error={error} />
        </div>
      )}
    </Modal>
  );
}

function TeamDialog({
  identity,
  team,
  onClose,
  onSaved,
}: {
  identity: IdentityAdministrationView;
  team?: TeamView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const activeMembers = identity.memberships.filter((member) => member.userStatus === "active");
  const [name, setName] = useState(team?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(team?.memberUserIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (userId: string) => {
    setMemberIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  };
  const save = async () => {
    if (busy || (!team && !name.trim())) return;
    setBusy(true);
    setError(null);
    try {
      if (team) await api.updateIdentityTeamMembers(team.teamId, memberIds);
      else await api.createIdentityTeam({ name: name.trim(), memberUserIds: memberIds });
      await onSaved();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!team || busy || !await confirm({
      title: `Delete “${team.name}”?`,
      message: "The team is removed permanently. People and paired devices are unchanged.",
      confirmLabel: "Delete Team",
      tone: "danger",
    })) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteIdentityTeam(team.teamId);
      await onSaved();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={team ? `Manage ${team.name}` : "Create a Team"}
      onClose={onClose}
      describedBy="team-dialog-description"
      footer={
        <>
          {team && (
            <button type="button" className="btn danger access-dialog-danger" onClick={() => void remove()} disabled={busy}>
              Delete Team
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || (!team && !name.trim())}>
            {busy ? "Saving…" : team ? "Save Members" : "Create Team"}
          </button>
        </>
      }
    >
      <p className="access-dialog-intro" id="team-dialog-description">
        Teams provide a shared ownership scope for machines, workspaces, and sessions.
      </p>
      <div className="access-form">
        {!team && (
          <label>
            <span>Team Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Team name" />
          </label>
        )}
        <fieldset className="access-member-picker">
          <legend>Members</legend>
          {activeMembers.map((member) => (
            <label key={member.userId}>
              <input
                type="checkbox"
                checked={memberIds.includes(member.userId)}
                onChange={() => toggle(member.userId)}
              />
              <span>{member.userName}</span>
              <small>{member.role}</small>
            </label>
          ))}
          {activeMembers.length === 0 && <div className="access-empty-copy">No active people are available.</div>}
        </fieldset>
        <DialogError error={error} />
      </div>
    </Modal>
  );
}

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
      title: `Revoke “${device.name}”?`,
      message: "This device loses access immediately.",
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
          {identity.context.userName} · {identity.context.role}
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
                  <strong>{member.userName}</strong>
                  <span className="access-row-meta">
                    <span className="access-role-badge">{titleCaseLabel(member.role)}</span>
                    <span className={`access-status access-status-${member.userStatus}`}>{titleCaseLabel(member.userStatus)}</span>
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
                  <span>{device.userName} · {titleCaseLabel(device.role)}</span>
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
