import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RunnerView } from "@wollipog/protocol";
import {
  machineSkillAdoptionRecoveryRequirement,
  machineSkillAdoptionRequirement,
  runnerSupportsProtocol,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { machineOptionLabels } from "../runners.js";
import {
  adoptionAdvisoryText,
  adoptionBlockerText,
  machineRequestQueue,
  MACHINE_SKILL_RESULT_FACT,
  machineSkillImportLabel,
  machineSkillLocation,
  machineSkillRowResult,
  MATCHING_FOLDER_REASON,
  MATCHING_FOLDER_TITLE,
  runnerCanImportSkills,
  userFacingMachineError,
  type MachineSkillResult,
} from "../skill-machine.js";
import type {
  MachineSkillAdoptionPreflight,
  MachineSkillAdoptionResult,
  MachineSkillDiscovery,
  MachineSkillPreview,
} from "../skills.js";
import { MoreHorizontalIcon, RefreshIcon } from "./Icons.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillAdoptionRecoveryDialog } from "./SkillAdoptionRecoveryDialog.js";
import { SKILL_DIFF_PANE_CLASS, SkillFileDiff } from "./SkillFileDiff.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import { useAccessibleMenu } from "./interactions.js";
import { useIsMobile } from "./useIsMobile.js";

type Candidate = MachineSkillDiscovery["candidates"][number];
/** Runs one machine request after the ones before it, counting it until it settles. */
export type MachineRequestTracker = <T>(request: () => Promise<T>) => Promise<T>;
type Outcome = { tone: "success" | "warning"; title?: string; text: string };

/**
 * Import from Machine (#1963): a `.modal.lg` at full height with the machine's skill folders on the
 * left and the selected folder's review on the right; on a phone, the list and then the review in
 * one sheet, with Back. The footer primary names what importing does. A folder that matches the
 * latest library version can instead be replaced with a link, behind one danger confirmation.
 */
export function SkillMachineImportDialog({ runners, libraryNames, machineLabels, onClose, onImported }: {
  runners: RunnerView[];
  /** Names of the library's skills, so an unreviewed folder can say whether it is a new skill. */
  libraryNames: ReadonlySet<string>;
  /** The page's machine names; the dialog derives its own when absent. */
  machineLabels?: ReadonlyMap<string, string>;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const api = useApi();
  const phone = useIsMobile();
  const labels = useMemo(() => machineLabels ?? machineOptionLabels(runners), [machineLabels, runners]);
  const nameOf = (runner: RunnerView | undefined) =>
    runner ? labels.get(runner.runnerId) ?? (runner.displayName || runner.hostname || runner.runnerId) : "This machine";
  const [runnerId, setRunnerId] = useState(() => (
    runners.find((runner) => runner.status === "online" && runnerCanImportSkills(runner)) ??
    runners.find((runner) => runner.status === "online")
  )?.runnerId ?? "");
  const runner = runners.find((candidate) => candidate.runnerId === runnerId);
  const machineName = nameOf(runner);
  const online = runner?.status === "online";
  const compatible = !!runner && online && runnerCanImportSkills(runner);
  const recoveryRequirement = machineSkillAdoptionRecoveryRequirement(runner?.os);
  const recoverySupported = compatible && !!recoveryRequirement &&
    runnerSupportsProtocol(runner?.protocolVersion, recoveryRequirement.capability);

  const [discovery, setDiscovery] = useState<MachineSkillDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** What each reviewed folder of this scan imports as. */
  const [results, setResults] = useState<Record<string, MachineSkillResult>>({});
  const [preview, setPreview] = useState<MachineSkillPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  /** The import was refused because the skill's assignments changed after this review (#2129). */
  const [conflict, setConflict] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [step, setStep] = useState<"list" | "review">("list");
  const [confirmingAdoption, setConfirmingAdoption] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  /** Refreshing the page and the folders after an adoption: the dialog stays locked meanwhile. */
  const [settling, setSettling] = useState(false);
  /**
   * Machine requests running or waiting, from this dialog, the dialogs stacked on it, and an earlier
   * opening of it. The server serves one machine request at a time and refuses a second, and a
   * request keeps running after the dialog that started it is cancelled. So every request goes
   * through the page's one queue (`machineRequestQueue`), which starts each only after the one
   * before it has settled; the controls that start one also wait while this is above 0, so a person
   * never queues work they cannot see.
   */
  const machineRequests = useSyncExternalStore(machineRequestQueue.subscribe, machineRequestQueue.pending, () => 0);
  const track = machineRequestQueue.run;

  // The discovery the server holds for us, read by close and by requests that finish after it.
  const discoveryRef = useRef<MachineSkillDiscovery | null>(null);
  discoveryRef.current = discovery;
  const closed = useRef(false);
  const discard = (id: string) => { void api.discardMachineSkillDiscovery(id).catch(() => {}); };

  // However the dialog goes away, the server's discovery goes with it. The flag is reset on (re)mount
  // because StrictMode's simulated unmount runs this cleanup once before the real mount.
  useEffect(() => {
    closed.current = false;
    return () => {
      if (closed.current) return;
      closed.current = true;
      if (discoveryRef.current) discard(discoveryRef.current.discoveryId);
    };
  }, []);

  const busy = importing || confirmingAdoption || settling;
  /** A machine request other than the folder read in progress, which queues clicks itself. */
  const machineBusy = machineRequests > (reading ? 1 : 0);
  const close = () => {
    if (importing) return;
    closed.current = true;
    if (discoveryRef.current) discard(discoveryRef.current.discoveryId);
    onClose();
  };

  /** List the machine's skill folders. The server serializes machine reads, so the dialog never
   * starts one while another runs: the Machine select and Scan Again wait for it. */
  const scan = async (targetRunnerId: string, keepMessages = false) => {
    const previous = discoveryRef.current;
    setScanning(true); setScanError(null); setSelectedId(null); setPreview(null); setPreviewError(null);
    setResults({}); setAccepted(false); setConflict(false); setStep("list");
    // A rescan after an adoption keeps what the adoption and the page refresh reported.
    if (!keepMessages) { setOutcome(null); setError(null); }
    setDiscovery(null);
    discoveryRef.current = null;
    try {
      if (previous) await api.discardMachineSkillDiscovery(previous.discoveryId).catch(() => {});
      const next = await track(() => api.discoverMachineSkills(targetRunnerId));
      if (closed.current) { discard(next.discoveryId); return; }
      discoveryRef.current = next;
      setDiscovery(next);
    } catch (cause) {
      if (!closed.current) setScanError(userFacingMachineError(cause, nameOf(runners.find((entry) => entry.runnerId === targetRunnerId))));
    } finally {
      if (!closed.current) setScanning(false);
    }
  };

  // Folders load as soon as a machine is chosen, including the one chosen on open. The ref keeps
  // StrictMode's simulated remount from starting a second read the server would refuse.
  const scannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!compatible || scannedFor.current === runnerId) return;
    scannedFor.current = runnerId;
    void scan(runnerId);
  }, [compatible, runnerId]);

  const chooseRunner = (id: string) => {
    if (id === runnerId) return;
    if (discoveryRef.current) discard(discoveryRef.current.discoveryId);
    discoveryRef.current = null;
    setDiscovery(null); setScanError(null); setSelectedId(null); setPreview(null); setPreviewError(null);
    setResults({}); setAccepted(false); setConflict(false); setError(null); setOutcome(null); setStep("list");
    scannedFor.current = null;
    setRunnerId(id);
  };

  // Reading a folder is one machine read at a time: a click while one runs waits, and the newest
  // choice is read when it finishes, so the review always matches the highlighted row.
  const wanted = useRef<string | null>(null);
  const readingRef = useRef(false);
  const read = async (candidateId: string, keepError = false) => {
    wanted.current = candidateId;
    if (readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    // An automatic re-read keeps what the change before it reported; a person's choice clears it.
    let keep = keepError;
    try {
      while (wanted.current !== null) {
        const id: string = wanted.current;
        const current = discoveryRef.current;
        if (!current || closed.current) break;
        setPreview(null); setPreviewError(null); setAccepted(false); setConflict(false);
        if (!keep) setError(null);
        keep = false;
        try {
          const next = await track(() => api.previewMachineSkill(current.discoveryId, id));
          if (closed.current || discoveryRef.current !== current) break;
          setResults((known) => ({ ...known, [id]: next.disposition }));
          if (wanted.current === id) { setPreview(next); wanted.current = null; }
        } catch (cause) {
          if (closed.current || discoveryRef.current !== current) break;
          if (wanted.current === id) { setPreviewError(userFacingMachineError(cause, machineName)); wanted.current = null; }
        }
      }
    } finally {
      readingRef.current = false;
      wanted.current = null;
      if (!closed.current) setReading(false);
    }
  };
  const select = (candidate: Candidate) => {
    if (busy || machineBusy) return;
    if (candidate.id !== selectedId) setOutcome(null);
    setSelectedId(candidate.id);
    setStep("review");
    void read(candidate.id);
  };

  const selected = discovery?.candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const shown = preview && preview.candidate.id === selectedId ? preview : null;
  const needsConsent = shown?.disposition === "update" && shown.assignmentCount > 0;
  const importable = !!shown && shown.disposition !== "identical";
  const adoptionRequirement = shown ? machineSkillAdoptionRequirement(runner?.os, shown.candidate.context) : null;
  const adoptionSupported = !!adoptionRequirement && runnerSupportsProtocol(runner?.protocolVersion, adoptionRequirement.capability);

  const submit = async () => {
    if (!discovery || !shown || !importable) return;
    setImporting(true); setError(null);
    try {
      // An update with no assignments deploys nothing, so reviewing it is the acceptance.
      await track(() => api.importMachineSkill(discovery.discoveryId, shown.previewId, needsConsent ? accepted : shown.disposition === "update",
        shown.deploymentImpact));
    } catch (cause) {
      if (isDeploymentImpactConflict(cause)) { setConflict(true); setAccepted(false); }
      else setError(userFacingMachineError(cause, machineName));
      setImporting(false);
      return;
    }
    setOutcome({ tone: "success", text: `Imported ${shown.candidate.name} as ${shown.disposition === "new" ? "a new skill" : "a new version"}. The folder on ${machineName} was not changed.` });
    setPreview(null); setAccepted(false);
    await refreshPage();
    setImporting(false);
    // Read the folder again: it now matches the latest version, which may offer Replace with Link.
    if (!closed.current) void read(shown.candidate.id, true);
  };

  /** Refresh the Skills page after a change. Its failure is reported, and never undoes the change. */
  const refreshPage = async () => {
    try { await onImported(); }
    catch (cause) {
      if (!closed.current) setError(`The change was made, but the Skills page didn't refresh: ${userFacingMachineError(cause, machineName)}`);
    }
  };

  const adopted = async (result: MachineSkillAdoptionResult, candidate: Candidate) => {
    const name = candidate.name;
    // The server has consumed this review either way: nothing may act on it again.
    setPreview(null);
    setConfirmingAdoption(false);
    if (result.status === "rejected") {
      // The server drops a rejected adoption's review, so the folder is read again.
      setOutcome({ tone: "warning", title: "Couldn't Replace with Link",
        text: result.error ? userFacingMachineError(new Error(result.error), machineName) : `${name} changed after the safety check. Review it again.` });
      void read(candidate.id);
      return;
    }
    if (result.status === "adopted") {
      setOutcome({ tone: "success", title: "Replaced with Link",
        text: `${name} on ${machineName} now reads the library version. The original folder is kept in Adoption Recovery.` });
    } else {
      setOutcome({ tone: "warning", title: "Replacing Stopped Partway",
        text: `${name} needs attention. Open Adoption Recovery from the ⋯ menu to restore the original folder.` });
    }
    // Locked until the folders are read again, so the machine cannot change underneath.
    setSettling(true);
    await refreshPage();
    setSettling(false);
    // The folder changed on the machine, so the list is read again.
    if (!closed.current) void scan(runnerId, true);
  };

  const reasonId = useId();
  const primaryReason = shown?.disposition === "identical"
    ? MATCHING_FOLDER_REASON
    : null;
  const listStep = !phone || step === "list";
  const reviewStep = !phone || step === "review";

  // A phone shows one pane at a time, so choosing a folder, or crossing the breakpoint, can unmount
  // the control that has focus, as can a Retry that starts a read or a machine change that swaps the
  // pane; focus would fall to the page behind the sheet. After every commit, focus that was in this
  // dialog and is now lost moves to the shown pane's first control: Back on the review step, else the
  // chosen folder (or the first), else the Machine field. One that is disabled (all of them are
  // while the machine is busy) passes it on, and the dialog itself takes it last. Focus that is still
  // somewhere, such as in a dialog stacked over this one, is never moved. Back takes focus to the
  // chosen folder too, where the person left off: the header button it stays on is Close on the list
  // step. The dialog is found through whichever pane is shown.
  const dialogRef = useRef<HTMLElement | null>(null);
  const paneRef = (pane: HTMLDivElement | null) => {
    if (pane) dialogRef.current = pane.closest<HTMLElement>('[role="dialog"]');
  };
  const focusInside = useRef(false);
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      !!dialogRef.current && target instanceof HTMLElement && target.closest('[role="dialog"]') === dialogRef.current;
    // Modal focuses its card before this effect runs, so the current focus is read once here.
    focusInside.current = inside(document.activeElement);
    const track = (event: FocusEvent) => { focusInside.current = inside(event.target); };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  const backToList = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    // Read when the folders show: a commit that was waiting for its effects may run them first.
    const back = backToList.current && listStep;
    if (listStep) backToList.current = false;
    if (!dialog?.isConnected) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!(back && dialog.contains(active)) && !(lost && focusInside.current)) return;
    const rows = [...dialog.querySelectorAll<HTMLElement>('[aria-label="Skill Folders"] > button')];
    const targets = [
      reviewStep && !listStep ? dialog.querySelector<HTMLElement>('button[aria-label="Back to Skill Folders"]') : null,
      rows.find((row) => row.getAttribute("aria-current") === "true"),
      rows[0],
      dialog.querySelector<HTMLElement>(".skill-machine-import-pane .ui-select-trigger"),
    ];
    for (const target of targets) {
      if (!target || target.getAttribute("aria-disabled") === "true") continue;
      target.focus();
      if (document.activeElement === target) return;
    }
    dialog.focus();
  });

  const menu = <DialogMoreMenu label="More Actions" items={[{
    label: "Adoption Recovery…",
    disabled: !recoverySupported || busy || scanning || machineRequests > 0,
    reason: !runner ? "Choose a machine first." : !online ? `${machineName} is offline.`
      : !recoverySupported ? `${machineName} needs a runner update.`
        : busy || scanning || machineRequests > 0 ? "Wait for the current machine read to finish." : undefined,
    onSelect: () => setRecoveryOpen(true),
  }]} />;

  const machineField = <label className="field">
    <span>Machine</span>
    <Select label="Machine" value={runnerId || null} placeholder="Choose a Machine" disabled={scanning || reading || busy || machineBusy}
      options={runners.map((entry) => ({
        value: entry.runnerId,
        label: nameOf(entry),
        description: entry.status !== "online" ? undefined : runnerCanImportSkills(entry) ? "Online" : "Needs a runner update",
        disabled: entry.status !== "online",
        disabledReason: entry.status !== "online" ? "Offline" : undefined,
      }))}
      onChange={chooseRunner} />
  </label>;

  const folderList = !runner ? <p className="skill-machine-import-note">{runners.some((entry) => entry.status === "online")
    ? "Choose a machine to list its skill folders."
    : runners.length ? "No machine is online. Skill folders are read from a machine that is online." : "No machines are connected."}</p>
    : !online ? <p className="skill-machine-import-note">{machineName} is offline.</p>
    : scanning ? <div className="skill-machine-import-loading" role="status">
      <span className="sr-only">Reading skill folders…</span>
      <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
    </div>
    : scanError ? <Notice tone="danger" title="Couldn't Read Skill Folders"
      actions={<button className="btn sm" type="button" disabled={busy || machineBusy} onClick={() => void scan(runnerId)}>Retry</button>}>{scanError}</Notice>
    : !discovery ? null
    : discovery.candidates.length === 0 ? <p className="skill-machine-import-note">No skill folders were found on {machineName}.</p>
    : <div className="surface" role="group" aria-label="Skill Folders">
      {discovery.candidates.map((candidate) => {
        const isSelected = candidate.id === selectedId;
        return <button key={candidate.id} type="button" className={`row row-2${isSelected ? " is-selected" : ""}`}
          aria-current={isSelected || undefined} disabled={busy || machineBusy} onClick={() => select(candidate)}>
          <span className="row-body">
            <span className="row-title">{candidate.name}</span>
            <span className="row-sub skill-machine-location" title={machineSkillLocation(candidate, runner)}>{machineSkillLocation(candidate, runner)}</span>
          </span>
          <span className="row-trail">{machineSkillRowResult(candidate.name, results[candidate.id], libraryNames)}</span>
        </button>;
      })}
    </div>;

  const matchNotice = shown?.disposition === "identical" && <Notice tone="info" title={MATCHING_FOLDER_TITLE}
    actions={shown.assignmentCount > 0 && adoptionSupported
      ? <button className="btn sm" type="button" disabled={busy || machineRequests > 0} onClick={() => setConfirmingAdoption(true)}>Replace with Link…</button>
      : undefined}>
    {shown.assignmentCount === 0
      ? `Assign ${shown.candidate.name} to an agent on ${machineName} to replace this folder with a link to the library.`
      : !adoptionSupported
        ? `${machineName} needs a runner update to replace this folder with a link to the library.`
        : "Replace the folder with a link, so this machine's agents read the library's copy."}
  </Notice>;

  const review = <>
    {outcome && <Notice tone={outcome.tone} title={outcome.title} role="status">{outcome.text}</Notice>}
    {!selected ? (!outcome && <p className="skill-machine-import-note">Choose a folder to review it.</p>)
      : previewError ? <Notice tone="danger" title="Couldn't Read This Folder"
        actions={<button className="btn sm" type="button" disabled={busy || machineBusy} onClick={() => void read(selected.id)}>Retry</button>}>{previewError}</Notice>
      : !shown ? <p className="skill-machine-import-note" role="status">Reading {selected.name}…</p>
      : <>
        <h3 className="skill-machine-import-title">{shown.candidate.name}</h3>
        <dl className="facts">
          <div><dt>Machine</dt><dd>{machineName}</dd></div>
          <div><dt>Folder</dt><dd className="skill-machine-location">{machineSkillLocation(shown.candidate, runner)}</dd></div>
          <div><dt>Result</dt><dd>{MACHINE_SKILL_RESULT_FACT[shown.disposition]}</dd></div>
        </dl>
        {matchNotice}
        <SkillFileDiff previousFiles={shown.previousFiles} files={shown.files} executablePaths={shown.executablePaths} />
      </>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </>;

  return <>
    <Modal title="Import from Machine" size="lg" className="skill-machine-import" onClose={close} headerActions={menu}
      back={phone && step === "review" ? { label: "Back to Skill Folders", onBack: () => { backToList.current = true; setStep("list"); } } : undefined}
      footer={<>
        {conflict && shown
          ? <ReviewConflict busy={busy || machineBusy} onPreviewAgain={() => void read(shown.candidate.id)} />
          : needsConsent && shown && <ReviewConsent label={deployToAssignmentsConsent(shown.assignmentCount)} checked={accepted} disabled={importing} onChange={setAccepted} />}
        {primaryReason && <p className="skill-machine-import-reason" id={reasonId}>{primaryReason}</p>}
        <button className="btn" type="button" disabled={importing} onClick={close}>Cancel</button>
        <BusyButton className="btn primary" busy={importing} progress={`Importing ${shown?.candidate.name ?? "the skill"}…`}
          disabled={!importable || conflict || reading || confirmingAdoption || settling || (machineRequests > 0 && !importing) ||
            (needsConsent && !accepted)}
          aria-describedby={primaryReason ? reasonId : undefined} onClick={() => void submit()}>
          {machineSkillImportLabel(shown?.disposition)}
        </BusyButton>
      </>}>
      {runner && online && !compatible
        ? <div ref={paneRef} className="skill-machine-import-pane only">
          {machineField}
          <Notice tone="warning" title={`${machineName} Needs a Runner Update`}>
            Update Wollipog on this machine to import its skill folders.
          </Notice>
        </div>
        : <>
          {listStep && <div ref={paneRef} className="skill-machine-import-pane list">
            {machineField}
            <div className="skill-machine-import-head">
              <h3 className="skill-machine-import-title">Skill Folders</h3>
              {compatible && <button type="button" className="icon-btn sm" aria-label="Scan Again" title="Scan Again"
                disabled={scanning || reading || busy || machineBusy} onClick={() => void scan(runnerId)}><RefreshIcon /></button>}
            </div>
            {folderList}
          </div>}
          {reviewStep && <div ref={paneRef} className={`skill-machine-import-pane review ${SKILL_DIFF_PANE_CLASS}`}>{review}</div>}
        </>}
    </Modal>
    {confirmingAdoption && discovery && shown && runner && <AdoptionConfirmation discovery={discovery} preview={shown}
      runner={runner} machineName={machineName} track={track} onCancel={() => setConfirmingAdoption(false)}
      onDone={(result) => adopted(result, shown.candidate)} />}
    {recoveryOpen && runner && <SkillAdoptionRecoveryDialog runner={runner} machineName={machineName} track={track}
      machineBusy={machineRequests > 0}
      onClose={() => setRecoveryOpen(false)} onRestored={refreshPage} />}
  </>;
}

/** The dialog header's ⋯ menu of secondary actions. */
function DialogMoreMenu({ label, items }: {
  label: string;
  items: Array<{ label: string; disabled?: boolean; reason?: string; onSelect: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  // Focus goes to the menu itself on open, so its Escape and Tab handling applies even when every
  // item is unavailable and none can take focus.
  const menu = useAccessibleMenu(open, setOpen, "dialog-more", "menu");
  // Opening with an arrow key focuses the first or last item, and none can take focus when all are
  // unavailable; the menu itself takes it then, or Escape would close the whole dialog.
  useEffect(() => {
    const surface = menu.menuRef.current;
    if (open && surface && !surface.contains(document.activeElement)) surface.focus();
  }, [open, menu.menuRef]);
  return <>
    <button ref={menu.triggerRef} type="button" className="icon-btn" title={label} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menu.menuId : undefined}
      onClick={menu.toggle} onKeyDown={menu.onTriggerKeyDown}>
      <MoreHorizontalIcon />
    </button>
    {open && <MenuSurface surfaceRef={menu.menuRef} anchor={{ trigger: menu.triggerRef }} id={menu.menuId} label={label} tabIndex={-1}
      align="end" inline onDismiss={() => menu.close(true)} onKeyDown={menu.onMenuKeyDown}>
      {items.map((item) => <MenuItem key={item.label} disabled={item.disabled} description={item.disabled ? item.reason : undefined}
        onClick={() => {
          // The dialog it opens returns focus to the trigger, which is what it records as its opener.
          menu.triggerRef.current?.focus();
          menu.close(false);
          item.onSelect();
        }}>{item.label}</MenuItem>)}
    </MenuSurface>}
  </>;
}

/**
 * Replace with Link (#1963): one danger confirmation for adoption. The safety check runs when it
 * opens and its findings are the body; confirming sends both acceptances the server requires, the
 * explicit confirmation and, when the check named other readers, the shared-folder impact.
 */
function AdoptionConfirmation({ discovery, preview, runner, machineName, track, onCancel, onDone }: {
  discovery: MachineSkillDiscovery;
  preview: MachineSkillPreview;
  runner: RunnerView;
  machineName: string;
  onCancel: () => void;
  /** Counts the request in the parent, which stays locked until it settles even if this closes. */
  track: MachineRequestTracker;
  onDone: (result: MachineSkillAdoptionResult) => Promise<void>;
}) {
  const api = useApi();
  const [preflight, setPreflight] = useState<MachineSkillAdoptionPreflight | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const closed = useRef(false);
  const messageId = useId();
  const findingsId = useId();
  const reasonId = useId();

  const check = async () => {
    setChecking(true); setError(null); setPreflight(null);
    try {
      const result = await track(() => api.preflightMachineSkillAdoption(discovery.discoveryId, preview.previewId));
      if (!closed.current) setPreflight(result);
    } catch (cause) { if (!closed.current) setError(userFacingMachineError(cause, machineName)); }
    finally { if (!closed.current) setChecking(false); }
  };
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void check();
  }, []);
  // Reset on (re)mount: StrictMode's simulated unmount runs this cleanup once before the real mount.
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; };
  }, []);

  const readers = (preflight?.sharedReaders ?? []).map((id) => runner.agents.find((agent) => agent.id === id)?.name ?? id);
  const ready = !!preflight && preflight.blockers.length === 0 && preflight.mutationSupported && !!preflight.adoptionToken;
  const reason = checking ? null
    : !preflight ? null
      : preflight.blockers.length > 0 ? "Resolve what the safety check found to replace this folder."
        : !ready ? `${machineName} needs a runner update to replace folders with links.`
          : null;
  const cancel = () => { if (!adopting) onCancel(); };
  const adopt = async () => {
    if (!ready || !preflight?.adoptionToken) return;
    setAdopting(true); setError(null);
    try {
      const token = preflight.adoptionToken;
      const result = await track(() => api.adoptMachineSkill(discovery.discoveryId, {
        previewId: preview.previewId, adoptionToken: token, acceptSharedImpact: preflight.sharedReaders.length > 0,
      }));
      await onDone(result);
    } catch (cause) {
      if (!closed.current) { setError(userFacingMachineError(cause, machineName)); setAdopting(false); }
    }
  };

  return <Modal title="Replace with Link" size="sm" tone="danger" closeButton={false} className="skill-adoption-confirmation"
    describedBy={`${messageId} ${findingsId}`} onClose={cancel}
    footer={<>
      {reason && <p className="skill-machine-import-reason" id={reasonId}>{reason}</p>}
      <button className="btn" type="button" autoFocus disabled={adopting} onClick={cancel}>Cancel</button>
      <BusyButton className="btn danger" busy={adopting} progress="Replacing the folder with a link…"
        disabled={!ready} aria-describedby={reason ? reasonId : undefined} onClick={() => void adopt()}>
        Replace with Link
      </BusyButton>
    </>}>
    <p className="confirmation-message" id={messageId}>
      {preview.candidate.name} in {machineSkillLocation(preview.candidate, runner).replace(/\/[^/]*$/u, "")} on {machineName} moves
      into a recovery journal, and a link to the library version takes its place. You can undo this from Adoption Recovery.
    </p>
    <div className="skill-adoption-findings" id={findingsId}>
      {checking ? <p className="skill-machine-import-note" role="status">Running the safety check…</p>
        : error && !preflight ? <Notice tone="danger" title="The Safety Check Didn't Finish"
          actions={<button className="btn sm" type="button" onClick={() => void check()}>Retry</button>}>{error}</Notice>
        : preflight && <>
          {preflight.blockers.length > 0 && <Notice tone="danger" title="This Folder Can't Be Replaced">
            <ul className="skill-adoption-list">{preflight.blockers.map((blocker) => <li key={blocker}>{adoptionBlockerText(blocker)}</li>)}</ul>
          </Notice>}
          {readers.length > 0 && <>
            <p className="skill-adoption-label">Other agents that read this folder will read the link too:</p>
            <ul className="surface confirmation-rows" aria-label="Also Read By">
              {readers.map((name) => <li className="row dense" key={name}><span className="row-title" title={name}>{name}</span></li>)}
            </ul>
          </>}
          {preflight.advisories.map((advisory) => <p className="skill-machine-import-note" key={advisory}>{adoptionAdvisoryText(advisory)}</p>)}
        </>}
      {error && preflight && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
  </Modal>;
}
