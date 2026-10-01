import { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import { skillVersionNumber, type SkillBuiltInReview } from "../skills.js";
import { Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillReviewChanges, SkillReviewFacts, skillReviewSafetyNote } from "./SkillReviewParts.js";

/** Review the running release's version of a skill file by file, then commit exactly that
 * version: a built-in update held by local changes, or the adoption of a same-name skill. */
export function SkillBuiltInReviewDialog({ skillId, skillName, kind: initialKind = "update", onClose, onAccepted }: {
  skillId: string;
  skillName: string;
  /** What the skill offers, so the title is right before the review is read: a held update of a
   * built-in skill, or a built-in version of a same-name skill. The review read decides after. */
  kind?: SkillBuiltInReview["kind"];
  onClose: () => void;
  onAccepted: () => Promise<void>;
}) {
  const api = useApi();
  const [review, setReview] = useState<SkillBuiltInReview | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Counts the reviews read, so Preview Again reads a fresh one. */
  const [reviews, setReviews] = useState(0);
  useEffect(() => {
    let active = true;
    api.getBuiltInSkillVersion(skillId).then((result) => { if (active) setReview(result); })
      .catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, skillId, reviews]);
  const previewAgain = () => {
    setReview(null); setAccepted(false); setConflict(false); setError(null); setBusy(true);
    setReviews((count) => count + 1);
  };
  const accept = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try {
      await api.acceptBuiltInSkillVersion(skillId, { digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId,
        ...(review.deploymentImpact ? { expectedDeploymentImpact: review.deploymentImpact } : {}) });
      await onAccepted();
    } catch (cause) {
      if (isDeploymentImpactConflict(cause)) { setConflict(true); setAccepted(false); }
      else setError((cause as Error).message);
      setBusy(false);
    }
  };
  const changed = review ? review.currentVersion?.digest !== review.digest : false;
  const adopt = (review?.kind ?? initialKind) === "adopt";
  // Accepting makes the release's version the latest, which assigned machines tracking it deploy.
  const needsConsent = changed && !!review && review.assignmentCount > 0;
  const currentNumber = skillVersionNumber(review?.currentVersion);
  const current = currentNumber === null ? null : `v${currentNumber}`;
  const failed = !review && !busy && !!error;
  const description = review && !changed
    ? `The built-in version matches ${current ?? "the latest version"}, so accepting only records where it comes from.`
    : adopt
      ? `This Wollipog release ships a built-in version of ${skillName}; accepting makes this a built-in skill.`
      : `This Wollipog release updates ${skillName}, whose latest library version has changes made here.`;
  return <Modal title={adopt ? "Review Built-In Version" : "Review Built-In Update"} description={description} size="lg"
    className="skill-review" onClose={() => { if (!busy) onClose(); }} footer={<>
    {conflict ? <ReviewConflict busy={busy} onPreviewAgain={previewAgain} />
      : needsConsent && review && <ReviewConsent label={deployToAssignmentsConsent(review.assignmentCount)} checked={accepted} disabled={busy} onChange={setAccepted} />}
    <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="button" className="btn primary" disabled={busy || conflict || !review || (needsConsent && !accepted)} onClick={() => void accept()}>
      {adopt ? "Accept Built-In Version" : "Accept Built-In Update"}
    </button>
  </>}>
    <SkillReviewFacts facts={[
      { label: "Release", value: failed ? "Unknown" : review && review.release },
      { label: "Library Version", value: failed ? "Unknown" : review && (!review.currentVersion ? "None"
        : `${current ?? "Latest"}${adopt ? "" : ", changed here"}`) },
      { label: "Result", value: failed ? "Unknown" : review && (!changed ? "No new version"
        : currentNumber !== null ? `New version v${currentNumber + 1}` : "New version") },
    ]} />
    {review && <Notice tone="info" compact>{adopt
      ? "Later releases update it on machines that track the latest version. Its assignments and every machine pin stay as they are."
      : "Earlier versions stay in Version History; pinned machines keep their version."}</Notice>}
    {review?.gitAutoUpdate && <Notice tone="warning" compact>Accepting turns off this skill's automatic Git updates.</Notice>}
    <SkillReviewChanges
      title={current ? `Changes From ${current}` : review && !review.currentVersion ? "Files" : "Changes"}
      note={skillReviewSafetyNote("accepting")}
      files={review && { previous: review.currentVersion?.files ?? [], current: review.files }}
      loading="Reading the built-in version…"
      failure={failed && <Notice tone="danger" title="Couldn't Read the Built-In Version" role="alert"
        actions={<button type="button" className="btn sm" onClick={previewAgain}>Retry</button>}>{error}</Notice>}
    />
    {review && error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Modal>;
}
