import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { State, useSnapshotState } from "./State.js";
import { TabList } from "./Tabs.js";
import {
  type AgentDefinition,
  type IdentityAdministrationView,
  type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { canManageProviderProfiles } from "../provider-profile-access.js";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { activeSessionCounts } from "../rail-attention.js";
import { machineListEntries } from "../runners.js";

import { DetailSkeleton } from "./common.js";
import { lifecycleConflictPresentation, MachineDetail, phoneMachineMenu, useMachineActions } from "./MachineDetail.js";
import { MachineSettingsDialog } from "./MachineSettingsDialog.js";
import { MachineList } from "./MachineList.js";
import { MachinesOverview } from "./MachinesOverview.js";
import { StaleContent } from "./StaleContent.js";
import { Notice } from "./Notice.js";
import { InstallManuallyDialog } from "./InstallManuallyDialog.js";
import { RepairConnectionDialog } from "./RepairConnectionDialog.js";
import { SetUpThisMachineDialog } from "./SetUpThisMachineDialog.js";
import { AddBoxDialog } from "./AddBoxDialog.js";
import { useFeedback } from "./FeedbackProvider.js";
import { MachineAgentsSection } from "./MachineAgentsSection.js";
import {
  CommandLineIcon,
  NetworkIcon,
  ComputerIcon,
} from "./Icons.js";
import { PeopleDevicesPanel } from "./PeopleDevicesPanel.js";
import { InstancesPanel } from "./InstancesPanel.js";
import { ProviderAccountsSection } from "./ProviderAccountsSection.js";
import { MachineCapacitySection } from "./MachineCapacitySection.js";
import { MachineSkillsSection } from "./MachineSkillsSection.js";
import { MachineWorkspacesSection } from "./MachineWorkspacesSection.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { DetailBar, PageHeader, type PageHeaderActions } from "./PageHeader.js";
import { useIsMobile } from "./useIsMobile.js";
import { useInstances } from "../instances-context.js";
import type { MachineSettingsTarget } from "../machine-settings.js";
import { backLabel, destination, type ConnectionSection, type MachineAccountsIntent } from "../navigation.js";
import {
  hasBundledLocalRunner,
  isManagedLocalRunnerRepair,
  readLocalRunnerStatus,
  type LocalRunnerStatus,
} from "../local-runner.js";

export function agentAvailabilityLabel(agent: AgentDefinition): "Available" | "Unavailable" | "Unverified" {
  return agent.available === true ? "Available" : agent.available === false ? "Unavailable" : "Unverified";
}

/**
 * A machine's sections under its header and notice (#2988), each its own block so the units that
 * restyle them (#2989 Capacity, Workspaces and Skills; #2990 Agents; #2995 Provider Accounts) each
 * change one. They keep their current content until then.
 */
function MachineSections({
  runner, name, online, canFindSessions, onChooseInstallation, canManageProfiles = false, canManageMachines, onChangeLimit,
  accountsIntent, profileAccessKnown = true,
}: {
  runner: RunnerView;
  name: string;
  online: boolean;
  canFindSessions: boolean;
  onChooseInstallation?: () => void;
  /** The viewer may use the provider profile routes: see `canManageProviderProfiles`. */
  canManageProfiles?: boolean;
  /** An organization owner or admin. */
  canManageMachines: boolean;
  onChangeLimit: () => void;
  /** An Add Account or Recover Existing Profile the route asks the accounts section to open (#3240). */
  accountsIntent?: MachineAccountsIntent;
  /** The viewer's identity has answered (or failed), so `canManageProfiles` is final. */
  profileAccessKnown?: boolean;
}) {
  return (
    <div className="machine-detail-sections">
      <MachineCapacitySection runner={runner} onChangeLimit={onChangeLimit} />
      <MachineAgentsSection runner={runner} online={online} machineName={name}
        canFindSessions={canFindSessions} onChooseInstallation={onChooseInstallation} />
      <ProviderAccountsSection runner={runner} online={online} machineName={name} canManageProfiles={canManageProfiles}
        profileAccessKnown={profileAccessKnown} intent={accountsIntent} />
      <MachineWorkspacesSection runner={runner} machineName={name} online={online} canAdd={canManageMachines} />
      <MachineSkillsSection runner={runner} />
    </div>
  );
}

export { canManageProviderProfiles };

/** One way to connect a machine: an item of the Add Machine menu and a row of the empty Machines tab. */
export interface AddMachineMethod {
  id: "local" | "ssh" | "manual";
  /** The menu item, with the ellipsis of a command that opens a dialog (§17). */
  label: string;
  /** The empty tab's row title and its button. */
  title: string;
  action: string;
  /** One line under the label or the title (§9.1). */
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}

/**
 * The ways to connect a machine, in the order offered: This Machine only where local setup is
 * offered today (`offerLocalSetup`), then SSH, then a manual install. The first is the empty tab's
 * primary, so the desktop app with a bundled runner leads with This Machine and the web app with SSH.
 */
export function addMachineMethods({ offerLocalSetup, localRunnerEnabled, onLocal, onSsh, onManual }: {
  offerLocalSetup: boolean;
  /** The local runner is enabled but offline: This Machine reconnects it rather than setting it up. */
  localRunnerEnabled: boolean;
  onLocal: () => void;
  onSsh: () => void;
  onManual: () => void;
}): AddMachineMethod[] {
  const local = localRunnerEnabled ? "Reconnect This Machine" : "Set Up This Machine";
  return [
    ...(offerLocalSetup ? [{
      id: "local" as const,
      label: `${local}…`,
      title: "This Machine",
      action: local,
      description: "Use the runner built into the Wollipog desktop app.",
      icon: <ComputerIcon />,
      onClick: onLocal,
    }] : []),
    {
      id: "ssh",
      label: "Connect via SSH…",
      title: "Over SSH",
      action: "Connect via SSH",
      description: "Wollipog installs and starts the runner for you over SSH.",
      icon: <NetworkIcon />,
      onClick: onSsh,
    },
    {
      id: "manual",
      label: "Install Manually…",
      title: "Manual Install",
      action: "Install Manually",
      description: "Run the runner yourself on any machine with Node.js.",
      icon: <CommandLineIcon />,
      onClick: onManual,
    },
  ];
}

/**
 * The Machines tab before its first machine (§12.1): one top-left state that owns the create
 * actions, so the header hides Add Machine, and under it one row per method with the first as the
 * primary. A viewer gets the sentence and no rows.
 */
function EmptyMachines({ methods, sentence }: { methods: AddMachineMethod[]; sentence: string }) {
  return (
    <State
      className="connections-empty"
      icon={<ComputerIcon />}
      title="No Machines Yet"
      actions={methods.length > 0 ? (
        <div className="surface">
          {methods.map((method, index) => (
            <div className="row row-2 add-machine-method" key={method.id}>
              <span className="row-icon" aria-hidden="true">{method.icon}</span>
              <span className="row-body">
                <span className="row-title">{method.title}</span>
                <span className="row-sub">{method.description}</span>
              </span>
              <button type="button" className={index === 0 ? "btn primary" : "btn"} onClick={method.onClick}>
                {method.action}
              </button>
            </div>
          ))}
        </div>
      ) : undefined}
    >
      {sentence}
    </State>
  );
}

/**
 * Each tab's page container (§4.5): the Machines master-detail (#2985) fills the column as
 * `.page.full.fill`, and the other tabs are a `.page`. The header sits inside the container either
 * way, so the title and the tabs keep the content's left edge on every tab.
 */
function connectionsPageClass(section: ConnectionSection): string {
  return section === "machines" ? "page full fill" : "page";
}

export function RunnersView() {
  const api = useApi();
  const { runners, boxes, sessions, view, navigate } = useStore();
  const snapshot = useSnapshotState();
  const { confirm } = useFeedback();
  const instances = useInstances();
  const bundledLocalRunner = hasBundledLocalRunner();
  const [onboarding, setOnboarding] = useState<"local" | "manual" | null>(null);
  const [localRunnerStatus, setLocalRunnerStatus] = useState<LocalRunnerStatus | null>(null);
  const [repairRunnerId, setRepairRunnerId] = useState<string | null>(null);
  const [addingBox, setAddingBox] = useState(false);
  /** Machine Settings and where it opens (#2991). */
  const [settings, setSettings] = useState<{ runnerId: string; at?: MachineSettingsTarget } | null>(null);
  const openSettings = (runnerId: string, at?: MachineSettingsTarget) => setSettings(at ? { runnerId, at } : { runnerId });
  const [identity, setIdentity] = useState<IdentityAdministrationView | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  // Instances is a desktop-app feature with nothing to do on a phone, so a narrowed window drops the
  // tab as the one-instance app does, and its route lands on Machines in place.
  const isMobile = useIsMobile();
  const instancesTab = instances.desktopMultiInstance && !isMobile;
  const requestedSection = view.name === "runners" ? view.section ?? "machines" : "machines";
  const section: ConnectionSection = !instancesTab && requestedSection === "instances"
    ? "machines"
    : requestedSection;
  // The route is the only source of selection (§6): `/connections/machines/~<runnerId>` a machine.
  const machineId = section === "machines" && view.name === "runners" ? view.machineId ?? null : null;
  /** An SSH machine just connected and selected, whose box has not streamed in yet. */
  const [arrivingMachineId, setArrivingMachineId] = useState<string | null>(null);
  const identityRole = identity?.context.role ?? null;
  const canManageMachines = identityRole === "owner" || identityRole === "admin";
  const canManageProfiles = canManageProviderProfiles(identity?.context);
  const selectSection = (next: ConnectionSection) => navigate({ name: "runners", section: next });
  useEffect(() => {
    if (!instancesTab && requestedSection === "instances") {
      navigate({ name: "runners", section: "machines" }, { replace: true });
    }
  }, [instancesTab, navigate, requestedSection]);

  // Only the latest load answers: an earlier one that fails after a Retry has succeeded must not
  // bring the failure notice back.
  const accessLoad = useRef(0);
  const loadMachineAccess = () => {
    const load = ++accessLoad.current;
    setIdentityError(null);
    void api.getIdentity().then((nextIdentity) => {
      if (load === accessLoad.current) setIdentity(nextIdentity);
    }).catch((error) => {
      if (load === accessLoad.current) setIdentityError(error instanceof Error ? error.message : String(error));
    });
  };
  useEffect(loadMachineAccess, [api]);
  useEffect(() => {
    if (!bundledLocalRunner) return;
    void readLocalRunnerStatus().then(setLocalRunnerStatus).catch(() => setLocalRunnerStatus(null));
  }, [bundledLocalRunner]);

  // A box's runner is that machine's, not a machine of its own; sorted by what needs the person.
  const machines = useMemo(() => machineListEntries(runners, boxes.values()), [runners, boxes]);
  const selectedMachine = machineId ? machines.find((machine) => machine.runnerId === machineId) ?? null : null;
  // Everything follows the live machines and the route; nothing tracks a deletion in flight. When the
  // machine on screen leaves them while it stays selected (deleted here or anywhere), its route is
  // replaced by the list, and the overview or the empty state follows (§6.1). Any other route to a
  // machine that is not there, a link, a reload or Back to an old entry, is Machine Not Found.
  /** The machine the detail showed as of the last commit, and only while it showed one. */
  const shownMachineId = useRef<string | null>(null);
  useEffect(() => {
    const wasShown = shownMachineId.current;
    shownMachineId.current = selectedMachine?.runnerId ?? null;
    if (!selectedMachine && machineId !== null && machineId === wasShown) {
      navigate({ name: "runners", section: "machines" }, { replace: true });
    }
  }, [machineId, navigate, selectedMachine]);
  const selectMachine = (runnerId: string | null) => navigate(runnerId
    ? { name: "runners", section: "machines", machineId: runnerId }
    : { name: "runners", section: "machines" });
  useEffect(() => {
    if (selectedMachine && selectedMachine.runnerId === arrivingMachineId) setArrivingMachineId(null);
  }, [arrivingMachineId, selectedMachine]);
  // With nothing selected, desktop and compact widths show the All Machines overview (§6.1 rule 1,
  // #2986); a phone shows the list, which is its overview.
  const activeSessions = useMemo(() => activeSessionCounts(sessions.values()), [sessions]);

  // Each pane scrolls on its own (§6). A new selection starts the detail at its top; on a phone, where
  // the route swaps the whole screen, focus moves to the new page title, which shows no ring (§16.1).
  const listBodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousMachineId = useRef(machineId);
  useLayoutEffect(() => {
    if (previousMachineId.current === machineId) return;
    previousMachineId.current = machineId;
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (isMobile) document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [machineId, isMobile]);
  // A phone hides the list while a machine is open, which loses its scroll position; Back puts the
  // list back where it was (§6.2). Recorded only while the list is on screen.
  const listScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (!machineId && listBodyRef.current) listBodyRef.current.scrollTop = listScrollTop.current;
  }, [machineId]);

  // The overview's Reconnect (#2986), confirming first when it would interrupt sessions, as the
  // machine's own Reconnect does.
  const reconnectFromOverview = async (boxId: string) => {
    try {
      await api.reconnectBox(boxId, false);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "BOX_HAS_ACTIVE_SESSIONS") throw cause;
      const conflict = lifecycleConflictPresentation(cause, "reconnect");
      const approved = await confirm({
        title: "Interrupt Sessions and Reconnect",
        message: conflict.message,
        detailRows: conflict.detailRows,
        detailRowsOverflow: conflict.detailRowsOverflow,
        confirmLabel: "Interrupt Sessions and Reconnect",
        tone: "danger",
      });
      if (approved) await api.reconnectBox(boxId, true);
    }
  };
  // Settings… opens on the machine it was chosen for, while that machine is still listed.
  const settingsMachine = settings ? machines.find((machine) => machine.runnerId === settings.runnerId) ?? null : null;
  const dialogs = (
    <>
      {onboarding === "local" && (
        <SetUpThisMachineDialog onClose={() => setOnboarding(null)} onLocalRunnerChanged={setLocalRunnerStatus} />
      )}
      {onboarding === "manual" && <InstallManuallyDialog onClose={() => setOnboarding(null)} />}
      {repairRunnerId && (
        <RepairConnectionDialog runnerId={repairRunnerId} onClose={() => setRepairRunnerId(null)} />
      )}
      {addingBox && (
        <AddBoxDialog
          onClose={() => setAddingBox(false)}
          // The new machine opens in the detail, so its Connecting notice is in view (#2987).
          onConnected={(box) => {
            setArrivingMachineId(box.runnerId);
            selectMachine(box.runnerId);
          }}
        />
      )}
      {settingsMachine && (
        <MachineSettingsDialog
          key={settingsMachine.runnerId}
          runner={settingsMachine.runner}
          box={settingsMachine.box}
          canManageMachines={canManageMachines}
          {...(settings?.at ? { at: settings.at } : {})}
          onClose={() => setSettings(null)}
          onDelete={async () => {
            if (settingsMachine.box) await api.removeBox(settingsMachine.box.boxId);
            else await api.removeRunner(settingsMachine.runnerId);
          }}
        />
      )}
    </>
  );

  const localRunnerOnline = Boolean(
    localRunnerStatus?.runnerId && runners.get(localRunnerStatus.runnerId)?.status === "online",
  );
  const localInstanceActive = instances.activeProfile.kind === "local";
  const repairRunner = (runnerId: string) => {
    if (isManagedLocalRunnerRepair(runnerId, localRunnerStatus, bundledLocalRunner, localInstanceActive)) {
      setOnboarding("local");
      return;
    }
    setRepairRunnerId(runnerId);
  };
  const canFindSessions = identityRole !== null && identityRole !== "viewer";
  const selectedActions = useMachineActions(selectedMachine, {
    canManage: canManageMachines,
    canOpenSettings: canManageMachines || selectedMachine?.runner?.canManage === true,
    canFindSessions,
  }, { onSettings: (runnerId) => openSettings(runnerId), onRepair: repairRunner });
  // "local" onboarding drives the desktop bridge, whose runner credential and socket work is
  // hard-coded to the loopback control plane, so on a remote instance it would set up a machine the
  // page in front of you does not show, and could overwrite the local runner while doing it.
  const offerLocalSetup = Boolean(
    localInstanceActive && localRunnerStatus?.available && (!localRunnerStatus.enabled || !localRunnerOnline),
  );
  const methods = addMachineMethods({
    offerLocalSetup,
    localRunnerEnabled: Boolean(localRunnerStatus?.enabled),
    onLocal: () => setOnboarding("local"),
    onSsh: () => setAddingBox(true),
    onManual: () => setOnboarding("manual"),
  });

  const total = machines.length;
  // An empty machine list proves nothing before the first snapshot or while disconnected. A route
  // that names a machine keeps its detail: the first machine is arriving after Connect via SSH, or
  // the link is to one that no longer exists (§6.1).
  const machinesEmpty = total === 0 && !snapshot.offline && !snapshot.loading && machineId === null;
  // Each tab supplies the header's actions (§3.3). Only owners and admins add machines, and while the
  // tab is empty its state offers the same methods, so the header does not repeat them (§12.1).
  const tabActions = (tab: ConnectionSection): PageHeaderActions => {
    if (tab === "machines" && canManageMachines && !machinesEmpty) {
      return {
        primary: {
          label: "Add Machine",
          items: methods.map(({ label, description, onClick }) => ({ label, description, onClick })),
        },
      };
    }
    return {};
  };
  const sections: Array<{ id: ConnectionSection; label: React.ReactNode }> = [
    // No count before the first snapshot: an empty list there proves nothing (§12.3).
    { id: "machines", label: <>Machines{snapshot.loading ? null : <> <span className="count">{total}</span></>}</> },
    ...(instancesTab
      ? [{ id: "instances" as const, label: <>Instances <span className="count">{instances.registry.profiles.length}</span></> }]
      : []),
    { id: "people", label: <>People and Devices</> },
  ];
  // On a phone the list and the open machine are two routes (§6.2): the machine takes the detail
  // bar and its Back, and the header with its tabs steps aside.
  const phoneDetail = isMobile && machineId !== null;
  const stale = snapshot.offline;
  const detail = snapshot.loading ? (
    // While the first snapshot loads, the list's skeleton is the one announcement.
    <DetailSkeleton />
  ) : selectedMachine ? (
    <MachineDetail key={selectedMachine.runnerId} entry={selectedMachine} actions={selectedActions} showTitle={!isMobile}>
      {selectedMachine.runner && (
        <MachineSections
          runner={selectedMachine.runner}
          name={selectedMachine.name}
          // An SSH machine's harness status is current only while its connection is up too.
          online={selectedMachine.runner.status === "online" && (!selectedMachine.box || selectedMachine.box.status === "online")}
          canFindSessions={canFindSessions}
          // Only owners and admins see Agent Installations in Machine Settings; a machine's own
          // manager does not, so the button would lead nowhere.
          onChooseInstallation={canManageMachines
            ? () => openSettings(selectedMachine.runnerId, "installations") : undefined}
          canManageProfiles={canManageProfiles}
          canManageMachines={canManageMachines}
          onChangeLimit={() => openSettings(selectedMachine.runnerId, "capacity")}
          accountsIntent={view.name === "runners" ? view.accounts : undefined}
          profileAccessKnown={identity !== null || identityError !== null}
        />
      )}
    </MachineDetail>
  ) : machineId && !stale && machineId !== arrivingMachineId ? (
    <State
      compact
      title="Machine Not Found"
      actions={<button type="button" className="btn sm" onClick={() => selectMachine(null)}>Show All Machines</button>}
    >
      It may have been deleted.
    </State>
  ) : machineId === null ? (
    // A phone's list is its overview, so it has no detail here (§6.2).
    isMobile ? null : (
      <StaleContent stale={stale}>
        <MachinesOverview
          entries={machines}
          activeSessions={activeSessions}
          canManage={canManageMachines}
          onOpen={selectMachine}
          onRepair={repairRunner}
          onReconnect={reconnectFromOverview}
        />
      </StaleContent>
    )
  ) : (
    // A machine that is arriving, or one the last-known list lacks while disconnected.
    <DetailSkeleton />
  );
  return (
    <div className={connectionsPageClass(section)}>
      {phoneDetail && (
        <DetailBar
          title={selectedMachine?.name ?? "Machine"}
          backLabel={backLabel("runners")}
          onBack={() => selectMachine(null)}
          menu={selectedMachine ? phoneMachineMenu(selectedActions) : []}
          menuLabel="Machine Actions"
        />
      )}
      {/* The tabs sit in the page header's tab slot (§4.2, §10.1), under its title and actions. */}
      {!phoneDetail && <PageHeader
        title={destination("runners").name}
        {...tabActions(section)}
        tabs={(
          <TabList label="Connections" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
            {sections.map((item) => (
              <button
                key={item.id}
                id={`connections-${item.id}-tab`}
                type="button"
                role="tab"
                aria-selected={section === item.id}
                aria-controls={`connections-${item.id}-panel`}
                tabIndex={section === item.id ? 0 : -1}
                className="tab"
                onClick={() => selectSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </TabList>
        )}
      />}
      {section === "instances" ? (
        <div
          id="connections-instances-panel"
          role="tabpanel"
          aria-labelledby="connections-instances-tab"
          className="connections-panel"
        >
          <InstancesPanel />
        </div>
      ) : section === "people" ? (
        <div
          id="connections-people-panel"
          role="tabpanel"
          aria-labelledby="connections-people-tab"
          className="connections-panel access-panel"
        >
          {identity ? (
            <PeopleDevicesPanel identity={identity} onIdentityChange={setIdentity} />
          ) : identityError ? (
            <div className="connection-access-error" role="alert">
              People and device access could not be loaded: {identityError}
              <button type="button" className="btn ghost sm" onClick={loadMachineAccess}>Retry</button>
            </div>
          ) : (
            <div className="access-loading">Loading organization access…</div>
          )}
        </div>
      ) : (
      <div
        id="connections-machines-panel"
        role="tabpanel"
        // A phone's machine route has no tabs, so the detail bar's title names the panel.
        aria-labelledby={phoneDetail ? undefined : "connections-machines-tab"}
        aria-label={phoneDetail ? selectedMachine?.name ?? "Machine" : undefined}
        className="connections-panel machines-panel"
      >
        {identityError && (
          <Notice
            compact
            tone="danger"
            role="alert"
            title="Couldn't Load Machine Permissions"
            actions={<button type="button" className="btn sm" onClick={loadMachineAccess}>Retry</button>}
            details={identityError}
          />
        )}
        {total === 0 && snapshot.offline ? (
          <div className="master-detail-state">
            <State variant="offline">Reconnecting…</State>
          </div>
        ) : machinesEmpty ? (
          // No machines is one state across both panes (§6.1, §12.1).
          <div className="master-detail-state">
            <EmptyMachines
              // Only where the person can act: a viewer is told whom to ask, since a button that fails
              // is worse than none (§11.3, applied to an empty state).
              methods={canManageMachines ? methods : []}
              sentence={canManageMachines
                ? "Wollipog runs agents on machines you connect. Choose how to connect the first one."
                : identityRole
                ? "Ask an organization owner or admin to connect a machine."
                : identityError
                ? "Wollipog runs agents on machines you connect."
                : "Loading machine access…"}
            />
          </div>
        ) : (
          <div className="master-detail" data-detail-open={machineId ? "" : undefined}>
            <MachineList
              entries={snapshot.loading ? null : machines}
              // Phone lists never show a selected row (§5.2).
              selectedId={isMobile ? null : machineId}
              onSelect={selectMachine}
              overview={isMobile ? undefined : { selected: machineId === null, onSelect: () => selectMachine(null) }}
              stale={stale}
              bodyRef={listBodyRef}
              onBodyScroll={(event) => {
                // A hidden list reports 0; that is not where the person left it.
                if (event.currentTarget.clientHeight > 0) listScrollTop.current = event.currentTarget.scrollTop;
              }}
            />
            <div ref={detailRef} className="master-detail-detail" data-focus-zone="main" tabIndex={-1}>
              {detail}
            </div>
          </div>
        )}
      </div>
      )}
      {dialogs}
    </div>
  );
}
