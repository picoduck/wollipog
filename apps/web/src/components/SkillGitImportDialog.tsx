import { useState } from "react";
import type { SkillFile } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { SkillGitPreview, SkillGitSource } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";

function contents(file: SkillFile | undefined): string {
  if (!file) return "(File absent)";
  if (file.encoding === "utf8") return file.content;
  return "Binary content (base64):\n" + file.content;
}

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
  const close = () => {
    if (busy) return;
    if (preview) void api.discardGitSkillPreview(preview.previewId).catch(() => {});
    onClose();
  };
  const discover = async () => {
    setBusy(true); setError(null);
    try {
      if (preview) await api.discardGitSkillPreview(preview.previewId);
      setPreview(null); setSelected([]); setAccepted(false); setImported([]);
      setPreview(await api.previewGitSkills({ url, ref, subdirectory }));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      for (const path of selected) {
        const candidate = preview.candidates.find((entry) => entry.path === path)!;
        await api.importGitSkill({ previewId: preview.previewId, path, acceptUpdate: accepted });
        setImported((current) => [...current, candidate.name]);
        setSelected((current) => current.filter((entry) => entry !== path));
        setPreview((current) => current && { ...current, candidates: current.candidates.filter((entry) => entry.path !== path) });
      }
    } catch (cause) { setError((cause as Error).message); }
    finally {
      try { await onImported(); } catch (cause) { setError((cause as Error).message); }
      setBusy(false);
    }
  };
  const updates = preview?.candidates.filter((entry) => selected.includes(entry.path) && entry.disposition === "update") ?? [];
  return <Modal title={source ? "Check for Skill Updates" : "Import Skills from Git"} wide onClose={close} footer={<>
    <button className="btn ghost" type="button" disabled={busy} onClick={close}>Close</button>
    {preview && <button className="btn primary" type="button" disabled={busy || !selected.length || (updates.length > 0 && !accepted)}
      onClick={() => void submit()}>{busy ? "Working…" : "Import Selected"}</button>}
  </>}>
    <div className="form">
      <p>Preview an immutable snapshot before importing. New skills stay unassigned. Updates to existing skills deploy to their current assignments after you accept the diff.</p>
      <label className="field"><span>Git Repository</span><input value={url} disabled={busy || preview !== null} placeholder="owner/repository or HTTPS/SSH URL" onChange={(event) => setUrl(event.target.value)} /></label>
      <label className="field"><span>Ref</span><input value={ref} disabled={busy || preview !== null} onChange={(event) => setRef(event.target.value)} /></label>
      <label className="field"><span>Repository Subdirectory</span><input value={subdirectory} disabled={busy || preview !== null} placeholder=".agents/skills" onChange={(event) => setSubdirectory(event.target.value)} /></label>
      <button className="btn" type="button" disabled={busy || !url.trim()} onClick={() => void discover()}>{busy ? "Working…" : "Preview Skills"}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {imported.length > 0 && <p role="status">Imported: {imported.join(", ")}</p>}
      {preview && preview.candidates.length === 0 && <p>No remaining skill candidates in this preview.</p>}
      {preview?.candidates.map((candidate) => {
        const paths = [...new Set([...candidate.files, ...candidate.previousFiles].map((file) => file.path))].sort();
        return <section className="skills-section" key={candidate.path}>
          <label className="field"><span><Checkbox label={candidate.name} disabled={busy} checked={selected.includes(candidate.path)}
            onChange={(checked) => { setAccepted(false); setSelected((current) => checked ? [...current, candidate.path] : current.filter((path) => path !== candidate.path)); }} /> {candidate.name}</span></label>
          <p className="skills-hint">{candidate.disposition === "identical" ? "Identical content; reuses the library version." : candidate.disposition === "update" ? `New version · ${candidate.assignmentCount} existing assignments` : "New skill · no assignments"}</p>
          <p className="skills-hint">Source: {candidate.source.url} · {candidate.path || "/"} · Commit {candidate.commit}</p>
          <p>Review every file below. Scripts and instructions are imported as content.</p>
          {paths.map((path) => {
            const before = candidate.previousFiles.find((file) => file.path === path);
            const after = candidate.files.find((file) => file.path === path);
            const change = !before ? "Added" : !after ? "Removed" : contents(before) === contents(after) ? "Unchanged" : "Changed";
            return <details key={path}><summary>{path}{candidate.executablePaths.includes(path) || /\.(sh|py|js|mjs|ts|ps1|bat|cmd)$/.test(path) ? " · Script" : ""} · {change}</summary>
              {candidate.disposition !== "new" && <><h4>Current</h4><pre className="skill-import-content">{contents(before)}</pre></>}
              <h4>Proposed</h4><pre className="skill-import-content">{contents(after)}</pre>
            </details>;
          })}
        </section>;
      })}
      {updates.length > 0 && <label className="field"><span><Checkbox label="Accept Version Diffs and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} /> Accept Version Diffs and Update Existing Assignments</span></label>}
    </div>
  </Modal>;
}
