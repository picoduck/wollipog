import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  orphanedCopyRef,
  type OrphanedSkillCopy,
  type OrphanedSkillCopyPreview,
  type OrphanedSkillCopyResolution,
} from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { SkillCopyFileReview } from "./SkillDriftImportDialog.js";

/** Review one orphaned copy's files, then import exactly the reviewed bytes as a new skill or as a
 * new version of the skill with its name. */
export function SkillOrphanImportDialog({ runnerId, machineLabel, copy, onClose, onImported }: {
  runnerId: string;
  machineLabel: string;
  copy: OrphanedSkillCopy;
  onClose: () => void;
  onImported: (result: OrphanedSkillCopyResolution) => Promise<void>;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<OrphanedSkillCopyPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    api.previewOrphanedSkillCopy(runnerId, orphanedCopyRef(copy)).then((result) => {
      previewId.current = result.previewId;
      if (active) setPreview(result);
    }).catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, runnerId, copy]);
  const close = () => {
    if (busy) return;
    if (previewId.current) void api.discardOrphanedSkillCopyPreview(previewId.current).catch(() => {});
    onClose();
  };
  const importCopy = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const result = await api.importOrphanedSkillCopy(preview.previewId, accepted);
      previewId.current = null;
      await onImported(result);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };
  const needsAcceptance = preview?.disposition === "update";
  const importLabel = preview?.disposition === "new" ? "Import as New Skill" : "Import as New Version";
  const name = preview?.name ?? copy.name;
  return <Modal title="Review Orphaned Copy" wide onClose={close} footer={<>
    <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
    <button type="button" className="btn primary" disabled={busy || !preview?.importable || (needsAcceptance && !accepted)}
      onClick={() => void importCopy()}>{importLabel}</button>
  </>}>
    <div className="form skills-machine-import">
      <p>
        Review the {copy.kind === "kept_aside" ? "kept-aside copy" : "edited copy"}
        {name ? <> of <strong>{name}</strong></> : null} on {machineLabel}
        {copy.digest ? <> (version {copy.digest.slice(0, 12)})</> : null}. Importing records exactly these files in the library,
        then the machine discards its copy if it still matches what you reviewed.
      </p>
      {busy && !preview && <p role="status">Reading the copy…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {preview && <>
        {preview.disposition === "new" && name && <p>No library skill is named <strong>{name}</strong>, so importing creates it with no assignments.</p>}
        {preview.disposition === "update" && <p>Importing adds a new latest version of <strong>{name}</strong>. Machines that track the latest version deploy it.</p>}
        {preview.disposition === "identical" && <p>These files already match the latest version of <strong>{name}</strong>. Importing only records where they came from.</p>}
        {copy.variant === "manual" && <p>The Manual Only copy's injected <code>disable-model-invocation</code> line is left out, so the library keeps the untransformed skill.</p>}
        {copy.kind === "kept_aside" && !copy.variant && <p>This copy was kept aside before the runner recorded its details, so it is imported exactly as stored.</p>}
        {preview.importBlocker && <p className="form-error" role="alert">{preview.importBlocker}</p>}
        <p>Review every file, including scripts. Reading and importing never run skill contents.</p>
        <SkillCopyFileReview previousFiles={preview.previousFiles} files={preview.files} copyLabel="Copy" />
        {preview.importable && needsAcceptance && <label className="field"><span>
          <Checkbox label="Accept Version Diff and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} />
          {" "}Accept Version Diff and Update Existing Assignments
        </span></label>}
      </>}
    </div>
  </Modal>;
}
