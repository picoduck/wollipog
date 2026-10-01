import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  orphanedCopyRef,
  skillVersionNumber,
  type OrphanedSkillCopy,
  type OrphanedSkillCopyPreview,
  type OrphanedSkillCopyResolution,
} from "../skills.js";
import { Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillReviewChanges, SkillReviewFacts, skillReviewSafetyNote } from "./SkillReviewParts.js";

/** Review one orphaned copy's files, then import exactly the reviewed bytes as a new skill or as a
 * new version of the skill with its name. */
export function SkillOrphanImportDialog({ runnerId, machineLabel, copy, onClose, onImported, onDiscard, discardDisabled }: {
  runnerId: string;
  machineLabel: string;
  copy: OrphanedSkillCopy;
  onClose: () => void;
  onImported: (result: OrphanedSkillCopyResolution) => Promise<void>;
  /** Discard Copy…, the alternative to importing (§7.3): opens the same confirmation as the list,
   * and calls `closeReview` once it is confirmed. */
  onDiscard?: (closeReview: () => void) => void;
  discardDisabled?: boolean;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<OrphanedSkillCopyPreview | null>(null);
  /** The latest version of the skill with this name, for the diff's heading; null until read or
   * when it cannot be. */
  const [latest, setLatest] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Counts the previews read, so Preview Again reads a fresh one. */
  const [previews, setPreviews] = useState(0);
  const previewId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    api.previewOrphanedSkillCopy(runnerId, orphanedCopyRef(copy)).then((result) => {
      previewId.current = result.previewId;
      if (!active) return;
      setPreview(result);
      // Read after the preview, so the heading names its library version or a newer one; a newer
      // one means the library moved since the preview, and the import's fence refuses it.
      if (copy.skillId && result.disposition !== "new") {
        api.listSkillVersions(copy.skillId).then((found) => { if (active) setLatest(skillVersionNumber(found.versions[0])); }, () => {});
      }
    }).catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, runnerId, copy, previews]);
  const previewAgain = () => {
    setPreview(null); setLatest(null); setAccepted(false); setConflict(false); setError(null); setBusy(true);
    setPreviews((count) => count + 1);
  };
  const closeReview = () => {
    if (previewId.current) void api.discardOrphanedSkillCopyPreview(previewId.current).catch(() => {});
    previewId.current = null;
    onClose();
  };
  const close = () => { if (!busy) closeReview(); };
  const importCopy = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      // An update with no assignments deploys nothing, so reviewing it is the acceptance.
      const result = await api.importOrphanedSkillCopy(preview.previewId, needsConsent ? accepted : preview.disposition === "update",
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
  const disposition = preview?.disposition;
  const importLabel = disposition === "new" ? "Import as New Skill" : disposition === "identical" ? "Import Copy" : "Import as New Version";
  const name = preview?.name ?? copy.name;
  const latestName = latest === null ? null : `v${latest}`;
  const description = disposition === "identical"
    ? `These files already match the latest version of ${name}, so importing only records where they came from.`
    : `Importing adds exactly these files to the library, then ${machineLabel} discards its copy if it still matches.`;
  // One notice, the consequence that matters most (§13.2).
  const notice = !preview ? null
    : preview.importBlocker ? <Notice tone="danger" compact role="alert">{preview.importBlocker}</Notice>
    : copy.variant === "manual" ? <Notice tone="info" compact>
        The copy was Manual Only. That setting isn't imported; choose it when you assign the skill.
      </Notice>
    : copy.kind === "kept_aside" && !copy.variant ? <Notice tone="info" compact>
        This copy was kept aside before the runner recorded its details, so it's imported exactly as stored.
      </Notice>
    : null;
  return <Modal title="Import Orphaned Copy" description={description} size="lg" className="skill-review" onClose={close}
    tertiary={onDiscard && <button type="button" className="btn ghost danger" disabled={busy || discardDisabled}
      onClick={() => onDiscard(closeReview)}>Discard Copy…</button>}
    footer={<>
      {conflict ? <ReviewConflict busy={busy} onPreviewAgain={previewAgain} />
        : needsConsent && preview && <ReviewConsent label={deployToAssignmentsConsent(preview.assignmentCount)} checked={accepted} disabled={busy} onChange={setAccepted} />}
      <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy || conflict || !preview?.importable || (needsConsent && !accepted)}
        onClick={() => void importCopy()}>{importLabel}</button>
    </>}>
    <SkillReviewFacts facts={[
      { label: "Machine", value: machineLabel },
      copy.kind === "kept_aside"
        ? { label: "Kept Aside", value: copy.keptAsideAt
          ? new Date(copy.keptAsideAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown" }
        : { label: "Deleted Skill", value: copy.name ?? "Unknown" },
      { label: "Result", value: !preview ? (!busy && error ? "Unknown" : null)
        : disposition === "new" ? "New skill"
        : disposition === "update" ? `New version of ${name}`
        : "No new version" },
    ]} />
    {notice}
    <SkillReviewChanges
      title={disposition === "new" || (!preview && !copy.skillId) ? "Files"
        : latestName ? `Changes From ${latestName}` : preview ? "Changes From the Latest Version" : "Changes"}
      note={skillReviewSafetyNote("importing")}
      files={preview && { previous: preview.previousFiles, current: preview.files }}
      loading="Reading the copy…"
      failure={!preview && error && <Notice tone="danger" title="Couldn't Read the Copy" role="alert"
        actions={<button type="button" className="btn sm" onClick={previewAgain}>Retry</button>}>{error}</Notice>}
    />
    {preview && error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Modal>;
}
