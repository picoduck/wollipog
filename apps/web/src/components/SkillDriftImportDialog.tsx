import { useEffect, useRef, useState } from "react";
import type { SkillFile } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { driftVariantLabel, type SkillDriftCopy, type SkillDriftPreview, type SkillDriftResolution } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";

const contents = (file?: SkillFile) => !file ? "(File absent)" : file.encoding === "utf8" ? file.content : `Binary content (base64):\n${file.content}`;

/** Review one drifted deployed copy as a library update, then commit exactly the reviewed bytes. */
export function SkillDriftImportDialog({ runnerId, machineLabel, copy, onClose, onImported }: {
  runnerId: string;
  machineLabel: string;
  copy: SkillDriftCopy;
  onClose: () => void;
  onImported: (result: SkillDriftResolution) => Promise<void>;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<SkillDriftPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    api.previewSkillDrift(runnerId, copy).then((result) => {
      previewId.current = result.previewId;
      if (active) setPreview(result);
    }).catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, runnerId, copy]);
  const close = () => {
    if (busy) return;
    if (previewId.current) void api.discardSkillDriftPreview(previewId.current).catch(() => {});
    onClose();
  };
  const importEdit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const result = await api.importSkillDrift(preview.previewId, accepted);
      previewId.current = null;
      await onImported(result);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };
  const needsAcceptance = preview?.disposition === "update";
  return <Modal title="Import Edit as New Version" wide onClose={close} footer={<>
    <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
    <button type="button" className="btn primary" disabled={busy || !preview?.importable || (needsAcceptance && !accepted)}
      onClick={() => void importEdit()}>Import Edit as New Version</button>
  </>}>
    <div className="form skills-machine-import">
      <p>
        Review the copy of <strong>{copy.name}</strong> that was edited on {machineLabel} ({driftVariantLabel(copy.variant)} of
        version {copy.digest.slice(0, 12)}). Importing creates a new library version from exactly these files. Machines that
        track the latest version deploy it, and this machine stops holding the skill.
      </p>
      {busy && !preview && <p role="status">Reading the edited copy…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {preview && <>
        {preview.pinned && <p>This machine is pinned to a version of this skill. Importing moves its pin to the new version.</p>}
        {!preview.publishedFromLatest && <p>This copy was edited from an older version. Importing replaces the newer library content shown as Current.</p>}
        {copy.variant === "manual" && <p>The Manual Only copy's injected <code>disable-model-invocation</code> line is left out, so the library keeps the untransformed skill.</p>}
        {preview.importBlocker && <p className="form-error" role="alert">{preview.importBlocker}</p>}
        {preview.disposition === "identical" && <p>The edited files already match the latest library version. Importing only resolves the machine's hold.</p>}
        <p>Review every file, including scripts. Reading and importing never run skill contents.</p>
        {[...new Set([...preview.previousFiles, ...preview.files].map((file) => file.path))].sort().map((path) => {
          const before = preview.previousFiles.find((file) => file.path === path);
          const after = preview.files.find((file) => file.path === path);
          const change = !before ? "Added" : !after ? "Removed" : contents(before) === contents(after) ? "Unchanged" : "Changed";
          return <details key={path}><summary>{path} · {change}</summary>
            <h4>Current</h4><pre className="skill-import-content">{contents(before)}</pre>
            <h4>Edited</h4><pre className="skill-import-content">{contents(after)}</pre>
          </details>;
        })}
        {preview.importable && needsAcceptance && <label className="field"><span>
          <Checkbox label="Accept Version Diff and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} />
          {" "}Accept Version Diff and Update Existing Assignments
        </span></label>}
      </>}
    </div>
  </Modal>;
}
