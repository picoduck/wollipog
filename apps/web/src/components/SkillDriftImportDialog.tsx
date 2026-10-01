import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  findSkillVersions,
  invocationLabel,
  skillVersionNumber,
  type SkillDriftCopy,
  type SkillDriftPreview,
  type SkillDriftResolution,
} from "../skills.js";
import { Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillReviewChanges, SkillReviewFacts, skillReviewSafetyNote } from "./SkillReviewParts.js";

/** The version numbers the review names; null where the version list cannot say. */
interface DriftVersionNumbers { latest: number | null; copyOf: number | null; pinnedTo: number | null }

const UNKNOWN_VERSIONS: DriftVersionNumbers = { latest: null, copyOf: null, pinnedTo: null };
const versionName = (number: number | null) => number === null ? null : `v${number}`;

/** Review one drifted deployed copy as a library update, then commit exactly the reviewed bytes. */
export function SkillDriftImportDialog({ skillId, runnerId, machineLabel, copy, onClose, onImported, onRestore, restoreDisabled }: {
  skillId: string;
  runnerId: string;
  machineLabel: string;
  copy: SkillDriftCopy;
  onClose: () => void;
  onImported: (result: SkillDriftResolution) => Promise<void>;
  /** Restore Library Version…, the alternative to importing (§7.3): opens the same confirmation as
   * the skill's notice, and calls `closeReview` once it is confirmed. */
  onRestore?: (closeReview: () => void) => void;
  restoreDisabled?: boolean;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<SkillDriftPreview | null>(null);
  const [versions, setVersions] = useState<DriftVersionNumbers | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Counts the previews read, so Preview Again reads a fresh one. */
  const [previews, setPreviews] = useState(0);
  const previewId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    api.previewSkillDrift(runnerId, copy).then((result) => {
      previewId.current = result.previewId;
      if (active) setPreview(result);
    }).catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, runnerId, copy, previews]);
  // The versions the facts and the pin notice name. Only names depend on them, so a failed read
  // names the versions in words instead.
  useEffect(() => {
    let active = true;
    api.getMachineSkillVersionPolicy(skillId, runnerId).then((result) => result.policy?.versionId ?? null, () => null)
      .then(async (pinnedId) => {
        const found = await findSkillVersions((before) => api.listSkillVersions(skillId, before),
          { digests: [copy.digest], ids: pinnedId ? [pinnedId] : [] });
        return {
          latest: skillVersionNumber(found.latest),
          copyOf: skillVersionNumber(found.byDigest.get(copy.digest)),
          pinnedTo: pinnedId ? skillVersionNumber(found.byId.get(pinnedId)) : null,
        };
      })
      .catch(() => UNKNOWN_VERSIONS)
      .then((result) => { if (active) setVersions(result); });
    return () => { active = false; };
  }, [api, skillId, runnerId, copy.digest, previews]);
  const previewAgain = () => {
    setPreview(null); setVersions(null); setAccepted(false); setConflict(false); setError(null); setBusy(true);
    setPreviews((count) => count + 1);
  };
  const closeReview = () => {
    if (previewId.current) void api.discardSkillDriftPreview(previewId.current).catch(() => {});
    previewId.current = null;
    onClose();
  };
  const close = () => { if (!busy) closeReview(); };
  const importEdit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      // An update with no assignments deploys nothing, so reviewing it is the acceptance.
      const result = await api.importSkillDrift(preview.previewId, needsConsent ? accepted : preview.disposition === "update",
        preview.deploymentImpact);
      previewId.current = null;
      await onImported(result);
    } catch (cause) {
      if (isDeploymentImpactConflict(cause)) { setConflict(true); setAccepted(false); }
      else setError((cause as Error).message);
      setBusy(false);
    }
  };
  const needsConsent = !!preview?.importable && preview.disposition === "update" && preview.assignmentCount > 0;
  const identical = preview?.disposition === "identical";
  const latest = versionName(versions?.latest ?? null);
  const next = versions?.latest ? `v${versions.latest + 1}` : null;
  // What the import leaves as the machine's version: the new version, or the latest it matches.
  const result = identical ? latest : next;
  const copyOf = versionName(versions?.copyOf ?? null);
  const pinnedTo = versionName(versions?.pinnedTo ?? null);
  const description = identical
    ? `The edited files already match ${latest ?? "the latest version"}, so importing only releases ${machineLabel}'s hold.`
    : `Importing records the files edited on ${machineLabel} as a new version of ${copy.name}.`;
  // One notice, the consequence that matters most (§13.2).
  const notice = !preview ? null
    : preview.importBlocker ? <Notice tone="danger" compact role="alert">{preview.importBlocker}</Notice>
    : !preview.publishedFromLatest ? <Notice tone="warning" compact>
        This copy was edited from {copyOf ?? "an earlier version"}. Importing replaces the newer library content shown as removed lines.
      </Notice>
    : preview.pinned && !(pinnedTo && pinnedTo === result) ? <Notice tone="info" compact>
        {machineLabel} is pinned to {pinnedTo ?? "a version of this skill"}. Importing moves its pin to {result ?? "the new version"}.
      </Notice>
    : copy.variant === "manual" ? <Notice tone="info" compact>
        The copy was Manual Only. That setting isn't imported; choose it when you assign the skill.
      </Notice>
    : null;
  return <Modal title="Import Edit as New Version" description={description} size="lg" className="skill-review" onClose={close}
    tertiary={onRestore && <button type="button" className="btn ghost danger" disabled={busy || restoreDisabled}
      onClick={() => onRestore(closeReview)}>Restore Library Version…</button>}
    footer={<>
      {conflict ? <ReviewConflict busy={busy} onPreviewAgain={previewAgain} />
        : needsConsent && preview && <ReviewConsent label={deployToAssignmentsConsent(preview.assignmentCount)} checked={accepted} disabled={busy} onChange={setAccepted} />}
      <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy || conflict || !preview?.importable || (needsConsent && !accepted)}
        onClick={() => void importEdit()}>{identical ? "Import Edit" : next ? `Import as ${next}` : "Import as New Version"}</button>
    </>}>
    <SkillReviewFacts facts={[
      { label: "Machine", value: machineLabel },
      { label: "Edited Copy Of", value: versions && (copyOf ?? "Unknown") },
      { label: "Copy", value: invocationLabel(copy.variant) },
      { label: "Result", value: !preview && !busy && error ? "Unknown" : preview && versions && (identical
        ? latest ? `No new version, matches ${latest}` : "No new version"
        : next ? `New version ${next}` : "New version") },
    ]} />
    {notice}
    <SkillReviewChanges
      title={!versions ? "Changes" : latest ? `Changes From ${latest}` : "Changes From the Latest Version"}
      note={skillReviewSafetyNote("importing")}
      files={preview && { previous: preview.previousFiles, current: preview.files }}
      loading="Reading the edited copy…"
      failure={!preview && error && <Notice tone="danger" title="Couldn't Read the Edited Copy" role="alert"
        actions={<button type="button" className="btn sm" onClick={previewAgain}>Retry</button>}>{error}</Notice>}
    />
    {preview && error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Modal>;
}
