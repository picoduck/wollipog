import { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import type { SkillBuiltInReview } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { SkillCopyFileReview } from "./SkillDriftImportDialog.js";

/** Review the running release's version of a skill file by file, then commit exactly that
 * version: a built-in update held by local changes, or the adoption of a same-name skill. */
export function SkillBuiltInReviewDialog({ skillId, skillName, onClose, onAccepted }: {
  skillId: string;
  skillName: string;
  onClose: () => void;
  onAccepted: () => Promise<void>;
}) {
  const api = useApi();
  const [review, setReview] = useState<SkillBuiltInReview | null>(null);
  const [busy, setBusy] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api.getBuiltInSkillVersion(skillId).then((result) => { if (active) setReview(result); })
      .catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, skillId]);
  const accept = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try {
      await api.acceptBuiltInSkillVersion(skillId, { digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId });
      await onAccepted();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };
  const changed = review ? review.currentVersion?.digest !== review.digest : false;
  const adopt = review?.kind === "adopt";
  return <Modal title={adopt ? "Review Built-In Version" : "Review Built-In Update"} wide onClose={() => { if (!busy) onClose(); }} footer={<>
    <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="button" className="btn primary" disabled={busy || !review || (changed && !accepted)} onClick={() => void accept()}>
      Accept Built-In Version
    </button>
  </>}>
    <div className="form skills-machine-import">
      {busy && !review && <p role="status">Loading the built-in version…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {review && <>
        {adopt ? (
          <p>
            Wollipog {review.release} ships a built-in version of <strong>{skillName}</strong>. Accepting adds it as a new
            library version and makes this a built-in skill, so later releases update it on machines that track the latest
            version. {review.assignmentCount} existing assignment{review.assignmentCount === 1 ? "" : "s"} and every machine
            pin stay as they are.
          </p>
        ) : (
          <p>
            Wollipog {review.release} includes an updated version of <strong>{skillName}</strong>. The library's latest version
            has changes made here; accepting makes the release's version the latest one. Earlier versions stay in Version
            History, and pinned machines keep their version.
          </p>
        )}
        {review.gitAutoUpdate && <p>Accepting turns off this skill's automatic Git updates.</p>}
        {!changed && <p>The built-in version matches the latest library version. Accepting only records where it comes from.</p>}
        <p>Review every file, including scripts. Reviewing and accepting never run skill contents.</p>
        <SkillCopyFileReview previousFiles={review.currentVersion?.files ?? []} files={review.files} copyLabel="Built-In" />
        {changed && <label className="field"><span>
          <Checkbox label="Accept Version Diff and Update Existing Assignments" checked={accepted} disabled={busy} onChange={setAccepted} />
          {" "}Accept Version Diff and Update Existing Assignments
        </span></label>}
      </>}
    </div>
  </Modal>;
}
