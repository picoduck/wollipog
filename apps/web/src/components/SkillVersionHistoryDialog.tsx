import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { relativeTime } from "../format.js";
import {
  SHORT_DIGEST_LENGTH,
  skillVersionLabel,
  skillVersionNote,
  skillVersionSource,
  type SkillVersionPreview,
  type SkillVersionSummary,
} from "../skills.js";
import { CopyButton } from "./common.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { DEPLOY_TO_TRACKING_MACHINES_CONSENT, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SkillReviewChanges, SkillReviewFacts, skillReviewSafetyNote } from "./SkillReviewParts.js";
import { SkillVersionListEnd, useSkillVersionPages } from "./SkillVersionPages.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useIsMobile } from "./useIsMobile.js";

/** Why Restore is disabled while the current version is selected (§7.3). */
export const CURRENT_VERSION_REASON = "This is the current version.";

/** "v3", or the short fingerprint from a control plane without version numbers; never a `skillv_` id. */
export function versionName(version: SkillVersionSummary | null | undefined): string {
  return skillVersionLabel(version)?.text ?? "this version";
}

/**
 * Version History (#1984): a `.modal.lg` at full height with the skill's versions on the left and the
 * selected one on the right: its date, source and fingerprint, then what restoring it changes. On a
 * phone, the list and then the version in one sheet, with Back. Older versions load as the list
 * scrolls. Restoring repeats the selected content as a new version, as before.
 */
export function SkillVersionHistoryDialog({ skillId, machineName, onClose, onRestored }: {
  skillId: string;
  /** The page's name for a machine, for a machine snapshot's source. */
  machineName?: (runnerId: string) => string | undefined;
  onClose: () => void;
  onRestored: () => Promise<void>;
}) {
  const api = useApi();
  const phone = useIsMobile();
  const pages = useSkillVersionPages(skillId);
  const { versions } = pages;
  const byId = useMemo(() => new Map(versions.flatMap((version) => version.id ? [[version.id, version] as const] : [])), [versions]);
  /** The newest version is the current one; the list is newest first. A list the dialog couldn't
   * read again may be out of date, so it names no version current. */
  const currentId = pages.error ? null : versions[0]?.id ?? null;

  /** The chosen version as it was listed; a reload that drops its page keeps it on screen. */
  const [chosen, setChosen] = useState<SkillVersionSummary | null>(null);
  const selectedId = chosen?.id ?? null;
  const [step, setStep] = useState<"list" | "detail">("list");
  const [preview, setPreview] = useState<SkillVersionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  /** The restore was refused because the skill's assignments changed after this preview (#2129). */
  const [conflict, setConflict] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  // Only the newest read is shown, so the detail always matches the highlighted row.
  const readToken = useRef(0);
  const read = async (versionId: string) => {
    const token = ++readToken.current;
    setPreview(null); setPreviewError(null); setAccepted(false); setConflict(false);
    try {
      const next = await api.previewSkillVersion(skillId, versionId);
      if (readToken.current === token) setPreview(next);
    } catch (cause) {
      if (readToken.current === token) setPreviewError((cause as Error).message);
    }
  };
  const select = (version: SkillVersionSummary, keepOutcome = false) => {
    const versionId = version.id;
    if (restoring || !versionId) return;
    // The version on screen (or being read) is kept; a phone only steps to it.
    if (versionId === selectedId && !previewError) { setStep("detail"); return; }
    if (!keepOutcome) { setOutcome(null); setError(null); }
    setChosen(version);
    setStep("detail");
    void read(versionId);
  };

  // On desktop the detail is never empty: it opens on the version before the current one, the one
  // a restore most often wants, or the current one when there is no other. A phone starts on the list,
  // and a version chosen there is kept when the window widens.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || chosen || phone || pages.loading || versions.length === 0) return;
    opened.current = true;
    const first = versions[1] ?? versions[0];
    if (first) select(first);
  }, [phone, pages.loading, versions]);

  const selected = selectedId ? byId.get(selectedId) ?? chosen : null;
  const shown = preview && preview.version.id === selectedId ? preview : null;
  // The preview names the current version as the server has it now; the list may be older.
  const isCurrent = !!selectedId && (shown ? shown.version.id === shown.currentVersion?.id : selectedId === currentId);
  const restorable = !!shown?.version.id && !!shown.currentVersion?.id && !isCurrent;
  // Restoring makes this content the latest version; when it differs from what is deployed now,
  // every machine that tracks the latest version deploys it. Without both digests, assume it differs.
  const sameContent = !!shown?.version.digest && shown.version.digest === shown.currentVersion?.digest;
  const needsConsent = restorable && !sameContent;
  const name = versionName(selected ?? shown?.version);

  const restore = async () => {
    if (!restorable || (needsConsent && !accepted) || !shown?.version.id || !shown.currentVersion?.id) return;
    const restoredName = name;
    setRestoring(true); setError(null);
    try {
      await api.restoreSkillVersion(skillId, shown.version.id, shown.currentVersion.id, shown.deploymentImpact);
    } catch (cause) {
      setAccepted(false);
      setRestoring(false);
      // The preview stays on screen, so Preview Again can read the same version afresh.
      if (isDeploymentImpactConflict(cause)) { setConflict(true); return; }
      // Anything else (the library changed since the preview) reads the list and this version again,
      // so the next restore is fenced on what is current now; the error stays until a new choice.
      setError((cause as Error).message);
      void pages.reload();
      void read(shown.version.id);
      return;
    }
    setAccepted(false); setPreview(null);
    const fresh = await pages.reload();
    setRestoring(false);
    setOutcome(`Restored ${restoredName}. Machines that track the latest version deploy it; pinned machines keep their version.`);
    // The new current version is selected, which says there is nothing left to restore. Only a
    // fresh list can name it: when the read failed, the list says so and nothing is selected.
    if (fresh?.[0]) select(fresh[0], true);
    else setChosen(null);
    try { await onRestored(); }
    catch { setError("The version was restored, but the Skills page didn't refresh. Reopen it to refresh."); }
  };

  // Crossing to a phone while a version row has focus hides the list and the row with it, which drops
  // focus on the page behind the sheet. Keep it in the dialog: on Back, or else on the dialog itself.
  const detailRef = useRef<HTMLDivElement>(null);
  const shownPhone = useRef(phone);
  useLayoutEffect(() => {
    // Only a crossing: opening the dialog places focus itself (Modal, §7.2).
    if (shownPhone.current === phone) return;
    shownPhone.current = phone;
    if (document.activeElement && document.activeElement !== document.body) return;
    const dialog = detailRef.current?.closest<HTMLElement>('[role="dialog"]');
    const back = dialog?.querySelector<HTMLElement>('button[aria-label="Back to Versions"]');
    (back ?? dialog)?.focus();
  }, [phone]);

  const reasonId = useId();
  const reason = isCurrent ? CURRENT_VERSION_REASON : null;
  const listStep = !phone || step === "list";
  const detailStep = !phone || step === "detail";

  const list = pages.loading ? <div className="skill-version-loading" role="status">
    <span className="sr-only">Loading versions…</span>
    <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
  </div>
    : versions.length === 0 && !pages.error ? <p className="skill-version-note">No versions are available.</p>
    : <>
      {pages.error && <Notice tone="danger" title="Couldn't Load Versions" role="alert"
        actions={<button className="btn sm" type="button" onClick={() => void pages.reload()}>Retry</button>}>
        {versions.length ? `${pages.error} The list below may be out of date.` : pages.error}
      </Notice>}
      {versions.length > 0 && <div className="surface" role="group" aria-label="Versions">
        {versions.map((version) => {
          const isSelected = !!version.id && version.id === selectedId;
          const note = skillVersionNote(version, byId);
          const label = skillVersionLabel(version);
          return <button key={version.id ?? version.digest} type="button" className={`row${note === undefined ? "" : " row-2"}${isSelected ? " is-selected" : ""}`}
            aria-current={isSelected || undefined} disabled={restoring || !version.id} onClick={() => select(version)}>
            <span className="row-body">
              <span className="row-line">
                <span className={`row-title${label?.mono ? " mono" : ""}`}>{label?.text ?? "Unnumbered Version"}</span>
                {version.id === currentId && <span className="status t-neutral no-dot">Current</span>}
              </span>
              {note !== undefined && <span className={`row-sub${note ? "" : " is-empty"}`} title={note ?? undefined}>{note ?? "No note"}</span>}
            </span>
            {version.createdAt !== undefined && <span className="row-trail">
              <time dateTime={new Date(version.createdAt).toISOString()} title={new Date(version.createdAt).toLocaleString()}>{relativeTime(version.createdAt)}</time>
            </span>}
          </button>;
        })}
      </div>}
      <SkillVersionListEnd pages={pages} />
    </>;

  const digest = shown?.version.digest ?? selected?.digest;
  const createdAt = shown?.version.createdAt ?? selected?.createdAt;
  const detail = <>
    {outcome && <Notice tone="success" role="status">{outcome}</Notice>}
    {!selected ? (!pages.loading && versions.length > 0 && <p className="skill-version-note">Choose a version to see what restoring it changes.</p>)
      : <>
        <SkillReviewFacts facts={[
          { label: "Date", value: createdAt !== undefined ? new Date(createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown" },
          { label: "Source", value: shown ? skillVersionSource(shown.version, machineName) : previewError ? "Unknown" : null },
          { label: "Fingerprint", value: digest
            ? <span className="skill-version-hash">
              <span className="mono">{digest.slice(0, SHORT_DIGEST_LENGTH)}</span>
              <CopyButton text={digest} iconOnly ariaLabel="Copy Fingerprint" className="icon-btn sm" />
            </span>
            : "Unknown" },
        ]} />
        <SkillReviewChanges
          title={isCurrent ? `Files in ${name}` : `Changes If You Restore ${name}`}
          note={isCurrent ? "Restoring the current version changes nothing." : skillReviewSafetyNote("restoring")}
          files={shown ? { previous: shown.currentVersion?.files ?? [], current: shown.version.files ?? [] } : null}
          loading={`Reading ${name}…`}
          failure={previewError && <Notice tone="danger" title={`Couldn't Read ${name}`}
            actions={<button className="btn sm" type="button" onClick={() => void read(selected.id!)}>Retry</button>}>{previewError}</Notice>} />
      </>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </>;

  return <Modal title="Version History" size="lg" className="skill-version-history" onClose={() => { if (!restoring) onClose(); }}
    back={phone && step === "detail" ? { label: "Back to Versions", onBack: () => setStep("list") } : undefined}
    footer={<>
      {conflict && shown?.version.id
        ? <ReviewConflict busy={restoring} onPreviewAgain={() => void read(shown.version.id!)} />
        : needsConsent && <ReviewConsent label={DEPLOY_TO_TRACKING_MACHINES_CONSENT} checked={accepted} disabled={restoring} onChange={setAccepted} />}
      {reason && <p className="skill-version-reason" id={reasonId}>{reason}</p>}
      <button type="button" className="btn" disabled={restoring} onClick={onClose}>Cancel</button>
      <BusyButton className="btn primary" busy={restoring} progress={`Restoring ${name}…`}
        disabled={!restorable || conflict || (needsConsent && !accepted)}
        aria-describedby={reason ? reasonId : undefined} onClick={() => void restore()}>
        {selected ? `Restore ${name}` : "Restore Version"}
      </BusyButton>
    </>}>
    {listStep && <div className="skill-version-pane list">{list}</div>}
    {detailStep && <div className="skill-version-pane detail" ref={detailRef}>{detail}</div>}
  </Modal>;
}
