import { useEffect, useState } from "react";
import type { SkillFile } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { SkillVersionPreview, SkillVersionSummary } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";

const contents = (file?: SkillFile) => !file ? "(File absent)" : file.encoding === "utf8" ? file.content : `Binary content (base64):\n${file.content}`;

export function SkillVersionHistoryDialog({ skillId, onClose, onRestored }: {
  skillId: string; onClose: () => void; onRestored: () => Promise<void>;
}) {
  const api = useApi();
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillVersionPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let active = true;
    api.listSkillVersions(skillId).then((result) => {
      if (active) { setVersions(result.versions); setCursor(result.nextCursor); }
    }).catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, skillId]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true); setError(null);
    try {
      const result = await api.listSkillVersions(skillId, cursor);
      setVersions((prior) => [...prior, ...result.versions]); setCursor(result.nextCursor);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const read = async (versionId: string) => {
    setBusy(true); setPreview(null); setAccepted(false); setError(null); setRestored(false);
    try { setPreview(await api.previewSkillVersion(skillId, versionId)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!accepted || !preview?.version.id || !preview.currentVersion?.id) return;
    setBusy(true); setError(null);
    try {
      await api.restoreSkillVersion(skillId, preview.version.id, preview.currentVersion.id);
      setPreview(null); setAccepted(false); setRestored(true);
      const result = await api.listSkillVersions(skillId);
      setVersions(result.versions); setCursor(result.nextCursor);
      await onRestored();
    } catch (cause) { setPreview(null); setAccepted(false); setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title="Version History" wide onClose={() => { if (!busy) onClose(); }} footer={<>
    <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Close</button>
    <button type="button" className="btn primary" disabled={busy || !accepted || !preview?.currentVersion?.id || preview.version.id === preview.currentVersion.id} onClick={() => void restore()}>Restore Version</button>
  </>}>
    <div className="form skills-machine-import">
      <p>Restore historical content as a new library revision. Unpinned machines track the restored content; pinned machines keep their selected revision. Newer history is kept.</p>
      {busy && <p role="status">Loading…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {restored && <p role="status">Version restored. Assignments on unpinned machines will sync to the restored content.</p>}
      <div className="skill-version-list" role="region" aria-label="Available Versions" tabIndex={0}>
      {versions.map((version) => <section className="skills-section" key={version.id}>
        <p className="skills-hint">{version.id} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : "Unknown date"}</p>
        <p className="skills-hint">Digest: {version.digest}</p>
        <button type="button" className="btn sm" disabled={busy || !version.id} aria-label={`Preview Version ${version.id}`} onClick={() => void read(version.id!)}>Preview Version</button>
      </section>)}
      {cursor && <button type="button" className="btn" disabled={busy} onClick={() => void more()}>Load Older Versions</button>}
      {!busy && !error && versions.length === 0 && <p>No versions are available.</p>}
      </div>
      {preview && <section className="skills-section">
        <h3>Restore Preview</h3>
        {preview.version.id === preview.currentVersion?.id && <p>This is the current version.</p>}
        {preview.version.note && <p>{preview.version.note}</p>}
        {preview.version.gitSource && <p className="skills-hint">Git source: {preview.version.gitSource.url} · {preview.version.gitSource.commit}</p>}
        {preview.version.machineSource && <p className="skills-hint">Machine snapshot: {preview.version.machineSource.context?.kind === "wsl" ? `WSL: ${preview.version.machineSource.context.distro} · ` : ""}{preview.version.machineSource.sourceDirectory}/{preview.version.machineSource.name} · {preview.version.machineSource.digest}</p>}
        <p>Review every file, including scripts. Preview and restore never execute skill contents. Restoring updates assignments on unpinned machines.</p>
        {[...new Set([...(preview.currentVersion?.files ?? []), ...(preview.version.files ?? [])].map((file) => file.path))].sort().map((path) => {
          const before = preview.currentVersion?.files?.find((file) => file.path === path);
          const after = preview.version.files?.find((file) => file.path === path);
          const change = !before ? "Added" : !after ? "Removed" : contents(before) === contents(after) ? "Unchanged" : "Changed";
          return <details key={path}><summary>{path} · {change}</summary>
            <h4>Current</h4><pre className="skill-import-content">{contents(before)}</pre>
            <h4>Proposed</h4><pre className="skill-import-content">{contents(after)}</pre>
          </details>;
        })}
        {preview.version.id !== preview.currentVersion?.id && <label className="field"><span><Checkbox label="Accept Version Diff and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} /> Accept Version Diff and Update Existing Assignments</span></label>}
      </section>}
    </div>
  </Modal>;
}
