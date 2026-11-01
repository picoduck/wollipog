import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import { State } from "./State.js";
import { StaleContent } from "./StaleContent.js";
import { useOptionalStoreSelector } from "../store.js";
import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
  TeamView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { pairingLinks } from "../device-token.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { CopyButton, Modal } from "./common.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { ChevronRightIcon, DeviceIcon, LockIcon, PlusIcon, ShieldIcon, TeamIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { TEAM_PURPOSE, TeamDialog } from "./TeamDialog.js";
import {
  PersonalIdentifier,
  PersonalIdentifierRevealButton,
  PersonalIdentifierText,
  usePersonalIdentifierReveal,
} from "./PersonalIdentifier.js";
import { AddPersonDialog, ManagePersonDialog } from "./PersonAccessDialogs.js";
import { DeviceDetailsDialog, PairedTime, useRevokeDevice } from "./DeviceDetailsDialog.js";
import { useIsMobile } from "./useIsMobile.js";
import {
  canAdminister,
  deviceCountLabel,
  devicesByPerson,
  OWNER_LOCKED_REASON,
  personRowAction,
} from "./people-device-rows.js";

type AccessDialog =
  | { kind: "add-person" }
  | { kind: "manage-person"; member: OrganizationMembershipView }
  | { kind: "pair-device" }
  | { kind: "device"; device: DeviceView }
  | { kind: "create-team" }
  | { kind: "manage-team"; team: TeamView };

const QRCodeSVG = lazy(() => import("qrcode.react").then((module) => ({ default: module.QRCodeSVG })));

function DialogError({ error }: { error: string | null }) {
  return error ? <div className="form-error" role="alert">{error}</div> : null;
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
  const memberTitles = maskedAccountTitles(activeMembers.map((member) => member.userName), "Hidden Name");
  const [namesRevealed, toggleNames] = usePersonalIdentifierReveal(
    activeMembers.map((member) => member.userName).join("\n"),
  );
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
          <strong>{name}</strong> is ready for{" "}
          {person ? <PersonalIdentifier value={person.userName} label="Person Name" /> : "this person"}. This credential is shown once.
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
              <Suspense fallback={<State variant="loading" compact>Loading pairing code…</State>}>
              <QRCodeSVG
                value={primaryLink}
                title={`Pair ${name} with Wollipog`}
                size={208}
                level="M"
                marginSize={4}
              />
              </Suspense>
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
        <details className="disclosure">
          <summary><ChevronRightIcon className="disclosure-chevron" />Manual Setup</summary>
          <div className="disclosure-body">
            <p className="hint">Use this only when the dashboard cannot provide a clickable pairing link.</p>
            <pre className="code-block install-cmd">
              {`#pair=${result.token}`}
              <CopyButton text={`#pair=${result.token}`} />
            </pre>
            <pre className="code-block install-cmd">
              {result.token}
              <CopyButton text={result.token} />
            </pre>
          </div>
        </details>
      </Modal>
    );
  }
  return (
    <Modal
      title={step === "person" ? "Choose a Person" : "Name the Device"}
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
        <>
          {activeMembers.some((member) => isPersonalIdentifier(member.userName)) && (
            <div className="pid-field-head">
              <PersonalIdentifierRevealButton
                label="Person Names"
                revealed={namesRevealed}
                onToggle={toggleNames}
                controls="pair-person-choices"
                withText
              />
            </div>
          )}
          <ChoiceRows<string>
            id="pair-person-choices"
            label="Person"
            value={userId || null}
            onChange={setUserId}
            options={activeMembers.map((member, index) => ({
              value: member.userId,
              title: namesRevealed ? member.userName : memberTitles[index]!,
              description: `${titleCaseLabel(member.role)} Access`,
            }))}
          />
          {activeMembers.length === 0 && <div className="access-empty-copy">Add an active person before pairing a device.</div>}
        </>
      ) : (
        <div className="access-form">
          <p className="access-dialog-intro">
            Pairing for <strong>{person && <PersonalIdentifier value={person.userName} label="Person Name" />}</strong>. Use a name they will recognize later.
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

const DEVICE_SKELETON_ROWS = 2;

/** A section of the tab (§4.5, §5.1): its title with a plain count, and at most one action. */
function AccessSection({
  id,
  title,
  count,
  note,
  action,
  children,
}: {
  id: string;
  title: string;
  /** Omitted while the list is unknown: not loaded, failed, or not visible to this person. */
  count?: number;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="section" aria-labelledby={`${id}-heading`}>
      <div className="section-head">
        <h2 className="section-title" id={`${id}-heading`}>
          {title}{count !== undefined && <> <span className="count">{count}</span></>}
        </h2>
        {action}
      </div>
      {note && <p className="section-note">{note}</p>}
      {children}
    </section>
  );
}

/** A section's one action: a small button with a plus, ending in an ellipsis because it opens a form. */
function SectionAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn sm" aria-haspopup="dialog" onClick={onClick}>
      <PlusIcon />
      <span>{label}</span>
    </button>
  );
}

/**
 * One two-line row of the tab (§5.2). When it opens something, its title is the one open target,
 * stretched over the whole row; the reveal controls and the trailing action are siblings above it,
 * never nested inside it. A row that opens nothing is plain text.
 */
function AccessRow({
  title,
  titleAfter,
  meta,
  onOpen,
  trailing,
  kind,
}: {
  title: React.ReactNode;
  /** Beside the title, outside the open target: a reveal control, the You or Suspended badge. */
  titleAfter?: React.ReactNode;
  meta: React.ReactNode;
  onOpen?: () => void;
  trailing?: React.ReactNode;
  /** Which list the row is in, for tests and evidence. */
  kind: "person" | "device" | "team";
}) {
  return (
    <div className={`row row-2 access-row${onOpen ? " is-openable" : ""}`} data-row={kind}>
      <div className="row-body">
        <div className="row-line">
          {onOpen
            ? <button type="button" className="row-title access-row-open" aria-haspopup="dialog" onClick={onOpen}>{title}</button>
            : <span className="row-title">{title}</span>}
          {titleAfter}
        </div>
        <div className="row-sub access-row-meta">{meta}</div>
      </div>
      {trailing && <div className="access-row-trail">{trailing}</div>}
    </div>
  );
}

/** A line-2 fact, after its 14px icon when it has one (§11.3). */
function MetaItem({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return <span className="access-meta">{icon}<span>{children}</span></span>;
}

/** The chevron a phone row shows instead of its action (§15.1). */
function RowChevron() {
  return <ChevronRightIcon aria-hidden="true" />;
}

/** A person's name as a row title: masked when email-shaped, with its reveal control outside the
 * row's open target so the row never nests buttons. */
function usePersonTitle(name: string): { title: React.ReactNode; reveal: React.ReactNode } {
  const [revealed, toggle] = usePersonalIdentifierReveal(name);
  if (!isPersonalIdentifier(name)) return { title: name, reveal: null };
  return {
    title: <span className="pid" data-revealed={revealed}><PersonalIdentifierText value={name} revealed={revealed} lead="Person" /></span>,
    reveal: <PersonalIdentifierRevealButton label="Person Name" revealed={revealed} onToggle={toggle} />,
  };
}

function PersonRow({
  member,
  context,
  deviceCount,
  teamNames,
  phone,
  onManage,
}: {
  member: OrganizationMembershipView;
  context: IdentityAdministrationView["context"];
  /** Null when the devices are not loaded or not visible to this person. */
  deviceCount: number | null;
  teamNames: string[];
  phone: boolean;
  onManage: () => void;
}) {
  const { title, reveal } = usePersonTitle(member.userName);
  const action = personRowAction(member, context);
  const trailing = action === "manage"
    ? phone ? <RowChevron /> : (
      <button type="button" className="btn sm ghost" aria-haspopup="dialog" onClick={onManage}>Manage…</button>
    )
    : action === "owner-locked"
      ? phone
        ? <span className="access-row-lock" role="img" aria-label={OWNER_LOCKED_REASON} title={OWNER_LOCKED_REASON}><LockIcon /></span>
        : <span className="access-row-note">{OWNER_LOCKED_REASON}</span>
      : null;
  return (
    <AccessRow
      kind="person"
      title={title}
      titleAfter={(
        <>
          {reveal}
          {action === "you" && <StatusBadge tone="neutral" noDot label="You" />}
          {/* Status shows only when it is an exception: Active shows nothing (§11.1). */}
          {member.userStatus === "suspended" && <StatusBadge meta={statusMeta("member", "suspended")} />}
        </>
      )}
      meta={(
        <>
          <MetaItem icon={<ShieldIcon size={14} />}>{titleCaseLabel(member.role)}</MetaItem>
          {deviceCount !== null && <MetaItem icon={<DeviceIcon size={14} />}>{deviceCountLabel(deviceCount)}</MetaItem>}
          {teamNames.length > 0 && <MetaItem icon={<TeamIcon size={14} />}>{teamNames.join(", ")}</MetaItem>}
        </>
      )}
      onOpen={action === "manage" ? onManage : undefined}
      trailing={trailing}
    />
  );
}

function DeviceRow({
  device,
  canRevoke,
  phone,
  onOpen,
  onRevoke,
}: {
  device: DeviceView;
  canRevoke: boolean;
  phone: boolean;
  onOpen: () => void;
  onRevoke: () => void;
}) {
  return (
    <AccessRow
      kind="device"
      title={device.name}
      meta={(
        <>
          <MetaItem><PersonalIdentifier value={device.userName} label="Person Name" lead="Person" /></MetaItem>
          {/* A phone keeps whose it is and its last use whole; Device Details has the pairing date. */}
          {!phone && <MetaItem>Paired <PairedTime at={device.createdAt} /></MetaItem>}
          <MetaItem>{device.lastSeenAt == null ? "Never used" : `Last used ${relativeTime(device.lastSeenAt)}`}</MetaItem>
        </>
      )}
      onOpen={onOpen}
      trailing={phone ? <RowChevron /> : canRevoke && (
        <button type="button" className="btn sm ghost danger" aria-haspopup="dialog" onClick={onRevoke}>Revoke…</button>
      )}
    />
  );
}

function TeamRow({
  team,
  members,
  canManage,
  phone,
  onManage,
}: {
  team: TeamView;
  members: OrganizationMembershipView[];
  canManage: boolean;
  phone: boolean;
  onManage: () => void;
}) {
  return (
    <AccessRow
      kind="team"
      title={team.name}
      meta={members.length === 0 ? "No members yet" : (
        <MetaItem>
          {members.length === 1 ? "1 member: " : `${members.length} members: `}
          {members.map((member, index) => (
            <React.Fragment key={member.userId}>
              {index > 0 && ", "}
              <PersonalIdentifier value={member.userName} label="Member Name" />
            </React.Fragment>
          ))}
        </MetaItem>
      )}
      onOpen={canManage ? onManage : undefined}
      trailing={canManage && (phone ? <RowChevron /> : (
        <button type="button" className="btn sm ghost" aria-haspopup="dialog" onClick={onManage}>Manage…</button>
      ))}
    />
  );
}

/** Skeleton rows at the real row's height and anatomy, a title bar over a meta bar (§12.3). */
function AccessSkeleton({ rows, announcement }: { rows: number; announcement: string }) {
  return (
    <div className="skeleton access-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{announcement}</span>
      <div className="surface" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="row row-2 access-row-skeleton" key={index}>
            <span className="row-body">
              <span className="skeleton-bar title" />
              <span className="skeleton-bar" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * People and Devices (#2997): People, Paired Devices and Teams as three sections of two-line rows.
 * Each section keeps its own permissions, loading and errors, so a failed device list never hides
 * the people or teams. The dialogs the rows open belong to #2998, #2999 and #3000.
 */
export function PeopleDevicesPanel({
  identity,
  onIdentityChange,
  offline = false,
}: {
  identity: IdentityAdministrationView;
  onIdentityChange: (identity: IdentityAdministrationView) => void;
  /** The connection is down: the last lists stay on screen (dimmed by the caller) without errors. */
  offline?: boolean;
}) {
  const api = useApi();
  const phone = useIsMobile();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(() => canAdminister(identity.context));
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AccessDialog | null>(null);
  const admin = canAdminister(identity.context);
  // Pairing and revoking are trusted-local operations; a paired dashboard only lists.
  const canPair = admin && identity.context.localBootstrap;
  const contextRef = useRef(identity.context);
  contextRef.current = identity.context;

  // Only the latest device load answers, so a slow earlier one can't replace a newer list or error.
  const deviceLoad = useRef(0);
  const loadDevices = async () => {
    const load = ++deviceLoad.current;
    setDevicesLoading(true);
    setDeviceError(null);
    try {
      const next = await api.listDevices();
      if (load === deviceLoad.current) setDevices(next.devices);
    } catch (cause) {
      if (load === deviceLoad.current) setDeviceError((cause as Error).message);
    } finally {
      if (load === deviceLoad.current) setDevicesLoading(false);
    }
  };

  const refresh = async () => {
    let context = contextRef.current;
    try {
      const nextIdentity = await api.getIdentity();
      setRefreshError(null);
      onIdentityChange(nextIdentity);
      context = nextIdentity.context;
    } catch (cause) {
      setRefreshError((cause as Error).message);
    }
    // Only owners and admins may read the device list, so nobody else asks for it. Their devices stay
    // unloaded rather than empty: the section says why it shows none.
    if (canAdminister(context)) {
      await loadDevices();
    } else {
      deviceLoad.current += 1;
      setDevices(null);
      setDeviceError(null);
      setDevicesLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [api]);
  // Back online, the lists are read again: what was on screen may no longer be true (§12.5).
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) void refresh();
    wasOffline.current = offline;
  }, [offline]);

  const revokeDevice = useRevokeDevice(refresh);

  const people = useMemo(
    () => [...identity.memberships].sort((a, b) => a.userName.localeCompare(b.userName)),
    [identity.memberships],
  );
  const teams = useMemo(() => [...identity.teams].sort((a, b) => a.name.localeCompare(b.name)), [identity.teams]);
  // Offline, the last list stays on screen and a failure says nothing: the banner explains it.
  const showDeviceError = deviceError !== null && !offline;
  // People count devices only from a list Paired Devices is showing, never from one it says failed.
  const deviceCounts = useMemo(
    () => admin && devices && !showDeviceError ? devicesByPerson(devices) : null,
    [admin, devices, showDeviceError],
  );
  const teamNamesByPerson = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const team of teams) {
      for (const userId of team.memberUserIds) names.set(userId, [...names.get(userId) ?? [], team.name]);
    }
    return names;
  }, [teams]);

  return (
    <div className="access-sections">
      {refreshError && !offline && (
        <Notice
          compact
          tone="danger"
          role="alert"
          title="Couldn't Refresh People and Teams"
          actions={<button type="button" className="btn sm" onClick={() => void refresh()}>Retry</button>}
          details={refreshError}
        >
          The lists below may be out of date.
        </Notice>
      )}

      <AccessSection
        id="people"
        title="People"
        count={people.length}
        action={admin && <SectionAction label="Add Person…" onClick={() => setDialog({ kind: "add-person" })} />}
      >
        <div className="surface">
          {people.map((member) => (
            <PersonRow
              key={member.userId}
              member={member}
              context={identity.context}
              deviceCount={deviceCounts ? deviceCounts.get(member.userId) ?? 0 : null}
              teamNames={teamNamesByPerson.get(member.userId) ?? []}
              phone={phone}
              onManage={() => setDialog({ kind: "manage-person", member })}
            />
          ))}
        </div>
      </AccessSection>

      <AccessSection
        id="devices"
        title="Paired Devices"
        count={admin && devices && !showDeviceError ? devices.length : undefined}
        note="Phones and other computers that can open Wollipog away from this computer."
        action={canPair && <SectionAction label="Pair Device…" onClick={() => setDialog({ kind: "pair-device" })} />}
      >
        {!admin ? (
          <Notice compact tone="neutral" role="note" icon={<LockIcon />}>
            Only owners and admins can see paired devices.
          </Notice>
        ) : (
          <>
            {!identity.context.localBootstrap && (
              <Notice compact tone="neutral" role="note">
                You're on a paired device. Pair and revoke devices from the computer running Wollipog.
              </Notice>
            )}
            {showDeviceError ? (
              <Notice
                compact
                tone="danger"
                role="alert"
                title="Couldn't Load Paired Devices"
                actions={<button type="button" className="btn sm" onClick={() => void loadDevices()}>Retry</button>}
                details={deviceError}
              >
                Wollipog didn't get the device list. People and teams are unaffected.
              </Notice>
            ) : devices === null ? (
              devicesLoading && !offline ? <AccessSkeleton rows={DEVICE_SKELETON_ROWS} announcement="Loading paired devices…" /> : null
            ) : devices.length === 0 ? (
              <p className="access-empty">
                {canPair
                  ? "No devices yet. Pair your phone to check on agents when you're away from this computer."
                  : "No devices yet."}
              </p>
            ) : (
              <div className="surface">
                {devices.map((device) => (
                  <DeviceRow
                    key={device.deviceId}
                    device={device}
                    canRevoke={canPair}
                    phone={phone}
                    onOpen={() => setDialog({ kind: "device", device })}
                    onRevoke={() => void revokeDevice(device)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </AccessSection>

      <AccessSection
        id="teams"
        title="Teams"
        count={teams.length}
        note={TEAM_PURPOSE}
        action={admin && <SectionAction label="Create Team…" onClick={() => setDialog({ kind: "create-team" })} />}
      >
        {teams.length === 0 ? <p className="access-empty">No teams yet.</p> : (
          <div className="surface">
            {teams.map((team) => (
              <TeamRow
                key={team.teamId}
                team={team}
                members={people.filter((member) => team.memberUserIds.includes(member.userId))}
                canManage={admin}
                phone={phone}
                onManage={() => setDialog({ kind: "manage-team", team })}
              />
            ))}
          </div>
        )}
      </AccessSection>

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
      {dialog?.kind === "device" && (
        <DeviceDetailsDialog
          device={dialog.device}
          canRevoke={canPair}
          onRevoke={revokeDevice}
          onClose={() => setDialog(null)}
        />
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

const IDENTITY_SKELETON_ROWS = 3;

/**
 * The People and Devices tab around its panel (#2997): the one state it shows before the directory
 * is there, or the panel itself. An unpaired device shows one line, since the pairing banner is the
 * next step; a lost connection keeps the last lists, dimmed, under Reconnecting… (§12.5).
 */
export function PeopleDevicesTab({
  identity,
  identityError,
  offline,
  onIdentityChange,
  onRetry,
}: {
  identity: IdentityAdministrationView | null;
  identityError: string | null;
  offline: boolean;
  onIdentityChange: (identity: IdentityAdministrationView) => void;
  onRetry: () => void;
}) {
  // As the shell's pairing banner does: latched by the refusal, through the background retries'
  // connecting and offline states, until a connection succeeds.
  const pairing = useOptionalStoreSelector((state) => state.authRequired && state.conn !== "online");
  if (pairing) {
    return <State variant="offline" className="access-state">People and devices load after this device is paired.</State>;
  }
  if (identity) {
    // The panel stays mounted through a disconnect, so its last device list and reveals survive it.
    return (
      <>
        {offline && <State variant="offline" className="access-state">Reconnecting…</State>}
        <StaleContent stale={offline}>
          <PeopleDevicesPanel identity={identity} onIdentityChange={onIdentityChange} offline={offline} />
        </StaleContent>
      </>
    );
  }
  if (offline) return <State variant="offline" className="access-state">Reconnecting…</State>;
  if (identityError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't Load People and Devices"
        actions={<button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
        details={identityError}
      >
        Wollipog didn't get the list of people and devices.
      </Notice>
    );
  }
  return <AccessSkeleton rows={IDENTITY_SKELETON_ROWS} announcement="Loading people and devices…" />;
}
