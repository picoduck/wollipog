import { useState } from "react";
import { useApi } from "../api-context.js";
import type { SkillGitPreview, SkillGitSource } from "../skills.js";
import { Modal } from "./common.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillFileDiff } from "./SkillFileDiff.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export function SkillGitImportDialog({ onClose, onImported, source }: {
  onClose: () => void; onImported: () => Promise<void>; source?: SkillGitSource;
}) {
  const api = useApi();
  const [url, setUrl] = useState(source?.url ?? "");
  const [ref, setRef] = useState(source?.ref ?? "HEAD");
  const [subdirectory, setSubdirectory] = useState(source?.subdirectory ?? "");
  const [preview, setPreview] = useState<SkillGitPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string[]>([]);
  /** The skill whose import was refused because its assignments changed after the preview (#2129). */
  const [conflict, setConflict] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    if (preview) void api.discardGitSkillPreview(preview.previewId).catch(() => {});
    onClose();
  };
  /** Preview the source. Previewing it again keeps the selection and what this dialog imported. */
  const discover = async (again = false) => {
    const keep = again ? selected : [];
    setBusy(true); setError(null); setConflict(null);
    try {
      if (preview) await api.discardGitSkillPreview(preview.previewId);
      setPreview(null); setSelected([]); setAccepted(false);
      if (!again) setImported([]);
      const next = await api.previewGitSkills({ url, ref, subdirectory });
      setPreview(next);
      setSelected(keep.filter((path) => next.candidates.some((entry) => entry.path === path)));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    let name: string | undefined;
    try {
      for (const path of selected) {
        const candidate = preview.candidates.find((entry) => entry.path === path)!;
        name = candidate.name;
        // Updates with no assignments deploy nothing, so reviewing them is the acceptance.
        await api.importGitSkill({ previewId: preview.previewId, path, acceptUpdate: needsConsent ? accepted : true,
          ...(candidate.deploymentImpact ? { expectedDeploymentImpact: candidate.deploymentImpact } : {}) });
        setImported((current) => [...current, candidate.name]);
        setSelected((current) => current.filter((entry) => entry !== path));
        setPreview((current) => current && { ...current, candidates: current.candidates.filter((entry) => entry.path !== path) });
      }
    } catch (cause) {
      if (isDeploymentImpactConflict(cause)) { setConflict(name ?? null); setAccepted(false); }
      else setError((cause as Error).message);
    }
    finally {
      try { await onImported(); } catch (cause) { setError((cause as Error).message); }
      setBusy(false);
    }
  };
  const updates = preview?.candidates.filter((entry) => selected.includes(entry.path) && entry.disposition === "update") ?? [];
  const deployedAssignments = updates.reduce((sum, entry) => sum + entry.assignmentCount, 0);
  const needsConsent = deployedAssignments > 0;
  return <Modal title={source ? "Check for Skill Updates" : "Import Skills from Git"} size="lg" onClose={close} footer={<>
    {conflict !== null ? <ReviewConflict name={conflict} busy={busy} onPreviewAgain={() => void discover(true)} />
      : needsConsent && <ReviewConsent label={deployToAssignmentsConsent(deployedAssignments)} checked={accepted} disabled={busy} onChange={setAccepted} />}
    <button className="btn ghost" type="button" disabled={busy} onClick={close}>Close</button>
    {preview && <button className="btn primary" type="button" disabled={busy || conflict !== null || !selected.length || (needsConsent && !accepted)}
      onClick={() => void submit()}>{busy ? "Working…" : "Import Selected"}</button>}
  </>}>
    <div className="form">
      <p>Preview an immutable snapshot before importing. New skills stay unassigned. Accepted updates deploy to current assignments on unpinned machines; pinned machines keep their selected revision.</p>
      <label className="field"><span>Git Repository</span><input value={url} disabled={busy || preview !== null} placeholder="owner/repository or HTTPS/SSH URL" onChange={(event) => setUrl(event.target.value)} /></label>
      <label className="field"><span>Ref</span><input value={ref} disabled={busy || preview !== null} onChange={(event) => setRef(event.target.value)} /></label>
      <label className="field"><span>Repository Subdirectory</span><input value={subdirectory} disabled={busy || preview !== null} placeholder=".agents/skills" onChange={(event) => setSubdirectory(event.target.value)} /></label>
      <button className="btn" type="button" disabled={busy || !url.trim()} onClick={() => void discover()}>{busy ? "Working…" : "Preview Skills"}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {imported.length > 0 && <p role="status">Imported: {imported.join(", ")}</p>}
      {preview && preview.candidates.length === 0 && <p>No remaining skill candidates in this preview.</p>}
      {preview?.candidates.map((candidate) => {
        return <section className="skills-section" key={candidate.path}>
          <Checkbox label={candidate.name} disabled={busy} checked={selected.includes(candidate.path)}
            onChange={(checked) => { setAccepted(false); setSelected((current) => checked ? [...current, candidate.path] : current.filter((path) => path !== candidate.path)); }} />
          <p className="skills-hint">{candidate.disposition === "identical" ? "Identical content; reuses the library version." : candidate.disposition === "update" ? `New version · ${candidate.assignmentCount} existing assignments` : "New skill · no assignments"}</p>
          <p className="skills-hint">Source: {candidate.source.url} · {candidate.path || "/"} · Commit {candidate.commit}</p>
          <p>Review every file below. Scripts and instructions are imported as content.</p>
          <SkillFileDiff previousFiles={candidate.previousFiles} files={candidate.files} executablePaths={candidate.executablePaths}
            label={`File Changes in ${candidate.name}`} />
        </section>;
      })}
    </div>
  </Modal>;
}
