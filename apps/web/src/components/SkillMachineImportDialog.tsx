import { useState } from "react";
import type { RunnerView, SkillFile } from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type {
  MachineSkillAdoptionPreflight,
  MachineSkillDiscovery,
  MachineSkillPreview,
  MachineSkillRecovery,
} from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";

const contents = (file?: SkillFile) => !file ? "(File absent)" : file.encoding === "utf8" ? file.content : `Binary content (base64):\n${file.content}`;
const adoptionBlocker = (blocker: string) => ({
  library_skill_missing: "The skill is not in the library.",
  executable_mode_adoption_unsupported: "The source contains executable files. Import is available, but adoption cannot preserve executable metadata yet.",
  effective_assignment_missing: "The skill is not enabled for a compatible agent on this machine.",
  assigned_version_mismatch: "The assigned version does not match this snapshot.",
  library_version_invalid: "The assigned library version failed validation.",
  source_not_targeted: "No assigned agent reads this source directory.",
  invocation_unsupported: "An assigned agent does not support the selected invocation policy.",
  manual_variant_adoption_unsupported: "Manual invocation variants cannot be adopted because their deployed content may differ.",
  shared_invocation_conflict: "Agents sharing this directory require different invocation variants.",
}[blocker] ?? `Adoption prerequisite failed: ${blocker.replaceAll("_", " ")}.`);

export function SkillMachineImportDialog({ runners, onClose, onImported }: {
  runners: RunnerView[]; onClose: () => void; onImported: () => Promise<void>;
}) {
  const api = useApi();
  const compatible = runners.filter((runner) => runner.status === "online" && (
    runner.os === "linux"
      ? runnerSupportsProtocol(runner.protocolVersion, "machineSkillSnapshots")
      : runner.os === "windows" &&
        runnerSupportsProtocol(runner.protocolVersion, "nativeWindowsMachineSkillSnapshots")
  ));
  const [runnerId, setRunnerId] = useState(compatible[0]?.runnerId ?? "");
  const [discovery, setDiscovery] = useState<MachineSkillDiscovery | null>(null);
  const [preview, setPreview] = useState<MachineSkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<MachineSkillAdoptionPreflight | null>(null);
  const [adoptionConfirmed, setAdoptionConfirmed] = useState(false);
  const [sharedAccepted, setSharedAccepted] = useState(false);
  const [adoptionStatus, setAdoptionStatus] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<MachineSkillRecovery | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState<string | null>(null);
  const selectedRunner = compatible.find((runner) => runner.runnerId === runnerId);
  const recoverySupported = selectedRunner?.os === "linux" && runnerSupportsProtocol(
    selectedRunner?.protocolVersion,
    "machineSkillAdoptionRecovery",
  );
  const close = () => {
    if (busy) return;
    if (discovery) void api.discardMachineSkillDiscovery(discovery.discoveryId).catch(() => {});
    onClose();
  };
  const discover = async () => {
    setBusy(true); setError(null); setPreview(null); setAccepted(false); setImported(null); setPreflight(null); setAdoptionStatus(null);
    try {
      if (discovery) await api.discardMachineSkillDiscovery(discovery.discoveryId);
      setDiscovery(null);
      setDiscovery(await api.discoverMachineSkills(runnerId));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const inspectRecovery = async () => {
    setBusy(true); setError(null); setRecovery(null); setRestoreConfirmed(null);
    try { setRecovery(await api.inspectMachineSkillRecovery(runnerId)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const restore = async (operationId: string) => {
    setBusy(true); setError(null); setAdoptionStatus(null);
    try {
      const result = await api.restoreMachineSkillRecovery(runnerId, operationId);
      setAdoptionStatus(result.status === "restored"
        ? `Published a recovery link to the preserved original for ${result.operation?.name ?? "the selected skill"}. The managed link remains preserved in its recovery journal.`
        : result.status === "not_needed"
          ? "The original source was already in place; no restore was needed."
          : result.error ?? "Restore stopped safely and still needs recovery inspection.");
      setRecovery(await api.inspectMachineSkillRecovery(runnerId));
      setRestoreConfirmed(null);
      if (result.status === "restored") await onImported();
    } catch (cause) { setRecovery(null); setError((cause as Error).message); }
    finally { setRestoreConfirmed(null); setBusy(false); }
  };
  const selectRunner = (selectedRunnerId: string) => {
    setRunnerId(selectedRunnerId);
    setRecovery(null);
    setRestoreConfirmed(null);
    setAdoptionStatus(null);
    setError(null);
  };
  const read = async (id: string) => {
    if (!discovery) return;
    setBusy(true); setError(null); setPreview(null); setAccepted(false); setImported(null); setPreflight(null);
    setAdoptionConfirmed(false); setSharedAccepted(false); setAdoptionStatus(null);
    try { setPreview(await api.previewMachineSkill(discovery.discoveryId, id)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const checkAdoption = async () => {
    if (!discovery || !preview) return;
    setBusy(true); setError(null); setPreflight(null); setAdoptionConfirmed(false); setSharedAccepted(false);
    try { setPreflight(await api.preflightMachineSkillAdoption(discovery.discoveryId, preview.previewId)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const adopt = async () => {
    if (!discovery || !preview || !preflight?.adoptionToken) return;
    setBusy(true); setError(null); setAdoptionStatus(null);
    try {
      const result = await api.adoptMachineSkill(discovery.discoveryId, {
        previewId: preview.previewId, adoptionToken: preflight.adoptionToken, acceptSharedImpact: sharedAccepted,
      });
      if (result.status === "adopted") {
        setAdoptionStatus(`Adopted: ${preview.candidate.name}. Original preserved at ${result.backupDirectory}.`);
        setPreview(null); setPreflight(null);
        await onImported();
      } else {
        setAdoptionStatus(result.status === "recovery_required"
          ? `Adoption stopped and needs recovery inspection. Operation ${result.operationId}; backup ${result.backupDirectory}.`
          : result.error ?? "Adoption was rejected. Discover the source again.");
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!discovery || !preview) return;
    setBusy(true); setError(null);
    try {
      await api.importMachineSkill(discovery.discoveryId, preview.previewId, accepted);
      setImported(preview.candidate.name); setPreview(null); setAccepted(false);
      await onImported();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title="Import Skill from Machine" wide onClose={close} footer={<>
    <button className="btn ghost" type="button" disabled={busy} onClick={close}>Close</button>
    <button className="btn primary" type="button" disabled={busy || !preview || (preview.disposition === "update" && !accepted)} onClick={() => void submit()}>Import Snapshot</button>
  </>}>
    <div className="form skills-machine-import">
      <p>Import a read-only snapshot. After an identical library version is assigned, a separate confirmed action can preserve the original and replace it with a managed link. New skills stay unassigned; accepted updates deploy to current assignments on unpinned machines.</p>
      <p className="skills-hint">Snapshot import requires protocol 111 on Linux or protocol 117 on Windows. Adoption requires a connected Linux runner on protocol 115 or newer. Symlinks, hard links, special files, executable files, and manual invocation variants are not adopted.</p>
      <label className="field"><span>Machine</span><Select label="Machine" value={runnerId} disabled={busy || discovery !== null}
        options={compatible.map((runner) => ({ value: runner.runnerId, label: runner.displayName || runner.hostname || runner.runnerId }))} onChange={selectRunner} /></label>
      {compatible.length === 0 && <p>No compatible connected machines. Update a Linux or Windows runner to enable snapshot imports.</p>}
      <button className="btn" type="button" disabled={busy || !compatible.some((runner) => runner.runnerId === runnerId)} onClick={() => void discover()}>{busy ? "Working…" : "Discover Skills"}</button>
      <button className="btn" type="button" disabled={busy || !recoverySupported}
        onClick={() => void inspectRecovery()}>Inspect Recovery</button>
      {selectedRunner && !recoverySupported && <p className="skills-hint">
        {selectedRunner.os === "linux"
          ? "Recovery inspection requires protocol 116 or newer. Update this runner to inspect or restore adoption journals."
          : "Recovery inspection and source adoption require a Linux runner. Read-only snapshot import remains available."}
      </p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {imported && <p role="status">Imported: {imported}. The source directory was not adopted.</p>}
      {adoptionStatus && <p role="status">{adoptionStatus}</p>}
      {recovery && <section className="skills-section">
        <h3>Adoption Recovery</h3>
        <p>Recovery journals retain source content after adoption and interrupted operations. Restore never overwrites an occupied source path.</p>
        {recovery.truncated && <p className="form-error">The bounded recovery list was truncated. Resolve visible operations, then inspect again.</p>}
        {!recovery.operations.length && <p>No adoption recovery journals were found.</p>}
        {recovery.operations.map((operation) => {
          const restorable = operation.state === "source_preserved" || operation.state === "managed_linked";
          return <section className="skills-section" key={operation.operationId}>
            <strong>{operation.name}</strong>
            <p className="skills-hint">{operation.sourceDirectory}/{operation.name} · {operation.state.replaceAll("_", " ")} · {operation.operationId}</p>
            <p>{operation.detail}</p>
            {restorable && <>
              <label className="field"><span>
                <Checkbox label={`Confirm Restore of ${operation.name}`} checked={restoreConfirmed === operation.operationId}
                  disabled={busy} onChange={(checked) => setRestoreConfirmed(checked ? operation.operationId : null)} />
                {" "}Confirm Restore of {operation.name}
              </span><small>The current managed link is preserved inside {operation.backupDirectory} before an exclusive recovery link exposes the original.</small></label>
              <button className="btn danger" type="button" disabled={busy || restoreConfirmed !== operation.operationId}
                onClick={() => void restore(operation.operationId)}>Restore Original Source</button>
            </>}
          </section>;
        })}
      </section>}
      {discovery && <>
        <p className="skills-hint">Up to 64 real skill directories are listed from native harness and shared skill locations. Same-name variants are shown separately; identical imports reuse the existing version.</p>
        {!discovery.candidates.length && <p>No importable skill directories were found.</p>}
        {discovery.candidates.map((candidate) => <section className="skills-section" key={candidate.id}>
          <strong>{candidate.name}</strong><p className="skills-hint">{candidate.sourceDirectory}/{candidate.name}</p>
          <button className="btn sm" type="button" disabled={busy} onClick={() => void read(candidate.id)} aria-label={`Preview Files for ${candidate.name} from ${candidate.sourceDirectory}`}>Preview Files</button>
        </section>)}
      </>}
      {preview && <section className="skills-section">
        <h3>Snapshot Preview</h3>
        <p>{preview.candidate.name} · {preview.disposition === "new" ? "New skill · no assignments" : preview.disposition === "identical" ? "Identical content; reuses the library version." : `New version · ${preview.assignmentCount} existing assignments`}</p>
        <p className="skills-hint">Digest: {preview.digest}</p>
        {!!preview.executablePaths?.length && <p className="skills-hint">Executable files: {preview.executablePaths.join(", ")}. These files can be imported as content, but this snapshot cannot be adopted.</p>}
        <p>Review every file before importing. Instructions and scripts are content, not executed during import.</p>
        {[...new Set([...preview.files, ...preview.previousFiles].map((file) => file.path))].sort().map((path) => {
          const before = preview.previousFiles.find((file) => file.path === path);
          const after = preview.files.find((file) => file.path === path);
          const change = !before ? "Added" : !after ? "Removed" : contents(before) === contents(after) ? "Unchanged" : "Changed";
          return <details key={path}><summary>{path}{/\.(sh|py|js|mjs|ts|ps1|bat|cmd)$/.test(path) ? " · Script" : ""} · {change}</summary>
            {preview.disposition !== "new" && <><h4>Current</h4><pre className="skill-import-content">{contents(before)}</pre></>}
            <h4>Proposed</h4><pre className="skill-import-content">{contents(after)}</pre>
          </details>;
        })}
        {preview.disposition === "update" && <label className="field"><span><Checkbox label="Accept Version Diff and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} /> Accept Version Diff and Update Existing Assignments</span></label>}
        {preview.disposition === "identical" && <>
          <button className="btn" type="button" disabled={busy || selectedRunner?.os !== "linux" ||
            !runnerSupportsProtocol(selectedRunner.protocolVersion, "machineSkillAdoption")}
            onClick={() => void checkAdoption()}>Check Adoption</button>
          {preflight && <section className="skills-section">
            <h4>Adoption Safety Check</h4>
            <p>{preflight.notice}</p>
            {preflight.blockers.length > 0 && <><p>Adoption is blocked:</p><ul>{preflight.blockers.map((blocker) =>
              <li key={blocker}>{adoptionBlocker(blocker)}</li>)}</ul></>}
            {preflight.mutationSupported && preflight.adoptionToken && <>
              <p>The original directory will be moved into a private recovery journal before the managed link is created. This is not an atomic exchange.</p>
              {preflight.sharedReaders.length > 0 && <label className="field"><span>
                <Checkbox label="Accept Shared Directory Impact" checked={sharedAccepted} disabled={busy} onChange={setSharedAccepted} />
                {" "}Accept Shared Directory Impact
              </span><small>Also readable by: {preflight.sharedReaders.join(", ")}</small></label>}
              <label className="field"><span>
                <Checkbox label="Confirm Recoverable Adoption" checked={adoptionConfirmed} disabled={busy} onChange={setAdoptionConfirmed} />
                {" "}Confirm Recoverable Adoption
              </span></label>
              <button className="btn danger" type="button" disabled={busy || !adoptionConfirmed ||
                (preflight.sharedReaders.length > 0 && !sharedAccepted)} onClick={() => void adopt()}>
                Adopt Source Directory
              </button>
            </>}
          </section>}
        </>}
      </section>}
    </div>
  </Modal>;
}
