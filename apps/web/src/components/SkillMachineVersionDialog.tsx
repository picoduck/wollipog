import { useEffect, useState } from "react";
import { runnerSupportsProtocol, type RunnerView, type SkillFile } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { MachineSkillVersionPreview, SkillVersionSummary } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";

const contents = (file?: SkillFile) => !file ? "(File absent)" : file.encoding === "utf8" ? file.content : `Binary content (base64):\n${file.content}`;

export function SkillMachineVersionDialog({ skillId, runners, onClose, onSaved }: {
  skillId: string; runners: RunnerView[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const compatible = runners.filter((runner) => runnerSupportsProtocol(runner.protocolVersion, "agentSkills"));
  const [runnerId, setRunnerId] = useState(compatible[0]?.runnerId ?? "");
  const [versionId, setVersionId] = useState("");
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<MachineSkillVersionPreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api.listSkillVersions(skillId).then((result) => { if (active) { setVersions(result.versions); setCursor(result.nextCursor); } })
      .catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, skillId]);
  const reset = () => { setPreview(null); setAccepted(false); setSaved(false); setError(null); };
  const more = async () => {
    if (!cursor) return;
    setBusy(true); setError(null);
    try { const result = await api.listSkillVersions(skillId, cursor); setVersions((prior) => [...prior, ...result.versions]); setCursor(result.nextCursor); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const read = async () => {
    reset(); setBusy(true);
    try { setPreview(await api.previewMachineSkillVersion(skillId, runnerId, versionId || null)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!accepted || !preview) return;
    setBusy(true); setError(null);
    try {
      await api.setMachineSkillVersion(skillId, runnerId, { versionId: versionId || null, expectedRevision: preview.policy?.revision ?? null, expectedLatestVersionId: preview.expectedLatestVersionId });
      setSaved(true); setPreview(null); setAccepted(false);
      try { await onSaved(); } catch { setError("Version policy saved, but status could not refresh. Reopen this view to refresh."); }
    } catch (cause) { setPreview(null); setAccepted(false); setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title="Machine Versions" wide onClose={() => { if (!busy) onClose(); }} footer={<>
    <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Close</button>
    <button className="btn primary" type="button" disabled={busy || !preview || !accepted} onClick={() => void save()}>Save Version Policy</button>
  </>}><div className="form skills-machine-import">
    <p>All assigned agents on a machine share one canonical skill version. Pin that machine to a revision, or track library updates. This does not create or change assignments.</p>
    <label className="field"><span>Machine</span><Select label="Machine" value={runnerId} disabled={busy} options={compatible.map((runner) => ({ value: runner.runnerId, label: runner.displayName || runner.hostname || runner.runnerId }))} onChange={(value) => { reset(); setRunnerId(value); }} /></label>
    <label className="field"><span>Version Policy</span><Select label="Version Policy" value={versionId} disabled={busy} options={[{ value: "", label: "Track Latest" }, ...versions.filter((v) => v.id).map((v) => ({ value: v.id!, label: `Pin ${v.id} · ${v.digest?.slice(0, 12) ?? ""}` }))]} onChange={(value) => { reset(); setVersionId(value); }} /></label>
    {cursor && <button className="btn" type="button" disabled={busy} onClick={() => void more()}>Load Older Versions</button>}
    <button className="btn" type="button" disabled={busy || !compatible.some((runner) => runner.runnerId === runnerId)} onClick={() => void read()}>Preview Version Policy</button>
    {busy && <p role="status">Loading…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {saved && <p role="status">Version policy saved. Offline machines sync when they reconnect.</p>}
    {preview && <section className="skills-section"><h3>Version Policy Preview</h3>
      <p>Current policy: {preview.policy?.versionId ? `pinned to ${preview.policy.versionId}` : "track latest"}.</p>
      <p>Proposed policy: {versionId ? `pin ${versionId}` : "track latest, including future library updates"}.</p>
      <p className="skills-hint">Proposed digest: {preview.proposedVersion.digest}</p>
      <p>Review every file. Saving affects all assigned agents on this machine; scripts are not executed by preview or save.</p>
      {[...new Set([...(preview.currentVersion?.files ?? []), ...(preview.proposedVersion.files ?? [])].map((file) => file.path))].sort().map((path) => <details key={path}><summary>{path}</summary>
        <h4>Current</h4><pre className="skill-import-content">{contents(preview.currentVersion?.files?.find((file) => file.path === path))}</pre>
        <h4>Proposed</h4><pre className="skill-import-content">{contents(preview.proposedVersion.files?.find((file) => file.path === path))}</pre>
      </details>)}
      <label className="field"><span><Checkbox label="Accept Files and Machine-Wide Version Policy" checked={accepted} disabled={busy} onChange={setAccepted} /> Accept Files and Machine-Wide Version Policy</span></label>
    </section>}
  </div></Modal>;
}
