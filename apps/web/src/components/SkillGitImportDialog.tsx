import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  gitCandidateConsequence,
  gitCandidateCounts,
  gitFolderError,
  gitHeldBranchNotice,
  gitHeldCommitFailure,
  gitImportLabel,
  gitNextCheckText,
  gitPreviewFailure,
  gitRefError,
  gitRefLabel,
  gitRepositoryError,
  gitSourceFieldError,
  shortCommit,
  type SkillGitField,
} from "../skill-git-import.js";
import type { SkillGitAutoUpdate, SkillGitPreview, SkillGitSource, SkillVersionSummary } from "../skills.js";
import { FieldError } from "./FieldError.js";
import { useFeedback } from "./FeedbackProvider.js";
import { BranchIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { deployToAssignmentsConsent, isDeploymentImpactConflict, ReviewConflict, ReviewConsent } from "./ReviewConsent.js";
import { SKILL_DIFF_PANE_CLASS } from "./SkillFileDiff.js";
import { SkillReviewChanges, SkillReviewFacts, skillReviewSafetyNote } from "./SkillReviewParts.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** Check for Updates and Review Update…: the skill whose recorded source the dialog checks. */
export interface SkillGitUpdateCheck {
  skillName: string;
  source: SkillGitSource;
  autoUpdate?: SkillGitAutoUpdate;
  /** Review Update… on a held update: the commit its notice names. The review reads exactly that
   * commit, not the branch's head, which may have moved on since the hold (#2280). */
  heldCommit?: string;
}

type Fields = Record<SkillGitField, string>;

/**
 * The preview request still running, superseded or not, from this dialog or one closed a moment
 * ago: the server reads one source at a time and refuses a second with 429, so a newer request
 * waits for it to settle. Module-wide because closing and reopening the dialog does not stop it.
 */
let runningDiscovery: Promise<unknown> | null = null;
/** The server abandons a discovery after 90s; a request still unsettled well past that is a lost
 * connection, and waiting on it would leave every later dialog finding forever. */
const DISCOVERY_WAIT_MS = 100_000;

/**
 * Import from Git (#1983), two steps in one `.modal.lg` and a full-height sheet on phones.
 *
 * Step one is the source: Repository, then Branch or Tag and Folder side by side. Find Skills reads
 * an immutable preview of it. Step two reviews that preview: a strip naming the source with Change
 * Source (back to step one, every value kept), one choice row per skill found, and the shown skill's
 * files beside the list (below it on a phone). Its checkbox chooses what to import; the rest of the
 * row only shows its files.
 *
 * Opened from a skill (`check`), it starts on step two for that skill's recorded source, and says
 * so when nothing changed. The preview and import requests are the same either way, and the server
 * keeps every check: credential-free addresses, the update acceptance and the deployment fence.
 */
export function SkillGitImportDialog({ onClose, onImported, check, libraryVersions }: {
  onClose: () => void;
  onImported: () => Promise<void>;
  check?: SkillGitUpdateCheck;
  /** The library's latest version of each skill by name, so an update names what it replaces. */
  libraryVersions?: ReadonlyMap<string, SkillVersionSummary | null | undefined>;
}) {
  const api = useApi();
  const { showToast } = useFeedback();
  const ids = useId();
  const [fields, setFields] = useState<Fields>({
    url: check?.source.url ?? "",
    // The server records the default branch as HEAD; the field leaves it empty.
    ref: check && check.source.ref !== "HEAD" ? check.source.ref : "",
    folder: check?.source.subdirectory ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Fields>>({});
  const [edited, setEdited] = useState<Partial<Record<SkillGitField, boolean>>>({});
  const [step, setStep] = useState<"source" | "review">(check ? "review" : "source");
  /** The source the shown preview (or the one being read) came from, for the strip. */
  const [reviewed, setReviewed] = useState<Fields>(fields);
  /** The held commit the shown preview (or the one being read) is of; null reads the ref's head.
   * Review Newer Commit and Change Source drop it for good. */
  const [held, setHeld] = useState<string | null>(check?.heldCommit ?? null);
  const [finding, setFinding] = useState(Boolean(check));
  const [preview, setPreview] = useState<SkillGitPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The skill whose import was refused because its assignments changed after the preview (#2129). */
  const [conflict, setConflict] = useState<string | null>(null);
  /** Opened from a skill, the preview found that skill and nothing that differs from the library.
   * Decided when the preview arrives, so imports that remove rows later never turn a review (or
   * its failure) into this state. */
  const [upToDate, setUpToDate] = useState(false);

  const fieldRefs = { url: useRef<HTMLInputElement>(null), ref: useRef<HTMLInputElement>(null), folder: useRef<HTMLInputElement>(null) };
  /** The control that takes focus when a commit removes the focused one: this state's first. */
  const anchorRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  const focusField = useRef<SkillGitField | null>(null);
  /** Each preview request's number; a result for an older one is discarded, not shown. */
  const generation = useRef(0);
  const closed = useRef(false);
  const previewRef = useRef<SkillGitPreview | null>(null);
  previewRef.current = preview;

  const discard = (previewId: string) => { void api.discardGitSkillPreview(previewId).catch(() => {}); };
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; };
  }, []);

  // A commit that removes the focused control (a step change, an imported row, the Up to Date
  // state replacing the primary) drops focus on <body>, outside the dialog. Focus that was inside
  // moves to this state's anchor; focus that is still somewhere is never moved.
  useEffect(() => {
    const inside = (target: EventTarget | null) => {
      const panel = bodyRef.current?.closest("[role='dialog']");
      return Boolean(panel && target instanceof Node && panel.contains(target));
    };
    // Modal focuses its first field in a child effect, before this listener exists, so the focus
    // already inside counts too: typing there and pressing Enter fires no focusin.
    focusInside.current = inside(document.activeElement);
    const onFocusIn = (event: FocusEvent) => { focusInside.current = inside(event.target); };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  useEffect(() => {
    const field = focusField.current;
    if (field) {
      focusField.current = null;
      fieldRefs[field].current?.focus();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!focusInside.current || (active && active !== document.body && active.isConnected)) return;
      anchorRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  });

  const busy = finding || importing;
  const close = () => {
    if (importing) return;
    closed.current = true;
    generation.current++;
    if (previewRef.current) discard(previewRef.current.previewId);
    onClose();
  };

  const validate = (name: SkillGitField, value: string) =>
    name === "url" ? gitRepositoryError(value) : name === "ref" ? gitRefError(value) : gitFolderError(value);
  const setField = (name: SkillGitField, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setEdited((current) => ({ ...current, [name]: true }));
    // An error showing clears as soon as the value is valid (§8.5).
    if (fieldErrors[name]) setFieldErrors((current) => ({ ...current, [name]: validate(name, value) ?? undefined }));
  };

  /**
   * Read a preview of the source. From step one, Find Skills stays busy there until the preview
   * arrives, and a failure stays there too; from step two (opened from a skill, Try Again, or
   * Preview Again after a conflict, which keeps what was checked) the review shows the read.
   * `commit` reads that held commit instead of the ref's head.
   */
  const find = async (again = false, commit = held) => {
    const errors: Partial<Fields> = {};
    for (const name of ["url", "ref", "folder"] as const) {
      const message = validate(name, fields[name]);
      if (message) errors[name] = message;
    }
    setFieldErrors(errors);
    const invalid = (["url", "ref", "folder"] as const).find((name) => errors[name]);
    if (invalid) {
      setHeld(null);
      setStep("source");
      focusField.current = invalid;
      return;
    }
    const request = ++generation.current;
    // The server trims the address only; a branch or folder is taken as written.
    const source = { url: fields.url.trim(), ref: fields.ref, folder: fields.folder };
    const keep = again ? checked : [];
    setReviewed(source);
    setHeld(commit);
    setFinding(true);
    setFailure(null); setError(null); setConflict(null); setAccepted(false); setUpToDate(false);
    if (previewRef.current) discard(previewRef.current.previewId);
    setPreview(null);
    const current = () => request === generation.current && !closed.current;
    try {
      while (runningDiscovery) {
        const waited = runningDiscovery;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          waited.catch(() => undefined),
          new Promise((resolve) => { timer = setTimeout(resolve, DISCOVERY_WAIT_MS); }),
        ]);
        clearTimeout(timer);
        if (runningDiscovery === waited) runningDiscovery = null;
        if (!current()) return;
      }
      const reading = api.previewGitSkills({ url: source.url, ref: source.ref, subdirectory: source.folder, ...(commit ? { commit } : {}) });
      runningDiscovery = reading;
      void reading.catch(() => undefined).finally(() => { if (runningDiscovery === reading) runningDiscovery = null; });
      const next = await reading;
      if (!current()) { discard(next.previewId); return; }
      // A control plane that can't read one commit returns the head: importing it would skip the
      // review the hold asked for, so it is refused like an unreadable commit.
      if (commit && next.candidates.some((entry) => entry.commit !== commit)) {
        discard(next.previewId);
        setFailure(gitHeldCommitFailure(commit));
        return;
      }
      const paths = new Set(next.candidates.map((entry) => entry.path));
      const initial = again ? keep.filter((path) => paths.has(path))
        : check ? next.candidates.filter((entry) => entry.name === check.skillName && entry.disposition === "update").map((entry) => entry.path)
          : [];
      setPreview(next);
      setUpToDate(Boolean(check && next.candidates.some((entry) => entry.name === check.skillName) &&
        next.candidates.every((entry) => entry.disposition === "identical")));
      setChecked(initial);
      setShown((shownPath) => shownPath && paths.has(shownPath) ? shownPath : initial[0] ?? next.candidates[0]?.path ?? null);
      setStep("review");
    } catch (cause) {
      if (!current()) return;
      const message = (cause as Error).message;
      const field = gitSourceFieldError(message, source.url);
      if (field) {
        // The server refused one field: it shows under that field, as the same rule would on blur.
        setFieldErrors({ [field.field]: field.message });
        setStep("source");
        focusField.current = field.field;
      } else setFailure(gitPreviewFailure(message));
    } finally {
      if (request === generation.current) setFinding(false);
    }
  };

  // Opened from a skill, the dialog starts on the review of its recorded source.
  const started = useRef(false);
  useEffect(() => {
    if (!check || started.current) return;
    started.current = true;
    void find();
  });

  const changeSource = () => {
    generation.current++;
    setHeld(null);
    if (previewRef.current) discard(previewRef.current.previewId);
    setPreview(null); setFinding(false); setFailure(null); setError(null); setConflict(null);
    setChecked([]); setAccepted(false); setUpToDate(false);
    setStep("source");
    focusField.current = "url";
  };

  const candidates = preview?.candidates ?? [];
  const checkedCandidates = candidates.filter((entry) => checked.includes(entry.path));
  const deployedAssignments = checkedCandidates.filter((entry) => entry.disposition === "update")
    .reduce((sum, entry) => sum + entry.assignmentCount, 0);
  const needsConsent = deployedAssignments > 0;
  const shownCandidate = candidates.find((entry) => entry.path === shown) ?? null;

  const submit = async () => {
    if (!preview || !checkedCandidates.length || conflict !== null || (needsConsent && !accepted)) return;
    setImporting(true); setError(null);
    const done: string[] = [];
    let name: string | undefined;
    let failed = false;
    try {
      for (const candidate of checkedCandidates) {
        name = candidate.name;
        // Updates with no assignments deploy nothing, so reviewing them is the acceptance.
        await api.importGitSkill({ previewId: preview.previewId, path: candidate.path, acceptUpdate: needsConsent ? accepted : true,
          ...(candidate.deploymentImpact ? { expectedDeploymentImpact: candidate.deploymentImpact } : {}) });
        done.push(candidate.name);
        setChecked((current) => current.filter((path) => path !== candidate.path));
        setPreview((current) => current && { ...current, candidates: current.candidates.filter((entry) => entry.path !== candidate.path) });
        setShown((current) => current === candidate.path ? null : current);
      }
    } catch (cause) {
      failed = true;
      if (isDeploymentImpactConflict(cause)) { setConflict(name ?? null); setAccepted(false); }
      else setError((cause as Error).message);
    }
    try { await onImported(); } catch (cause) { failed = true; setError((cause as Error).message); }
    if (closed.current) return;
    setImporting(false);
    if (done.length) {
      showToast(done.length === 1 ? `Imported ${done[0]}` : `Imported ${done.length} skills`, { tone: "success" });
    }
    if (!failed) {
      closed.current = true;
      // Skills left unchecked keep the preview alive on the server until it is discarded.
      discard(preview.previewId);
      onClose();
    }
  };

  const setAnchor = (element: HTMLElement | null) => { if (element) anchorRef.current = element; };
  const reasonId = `${ids}-reason`;
  const diffId = `${ids}-diff`;

  const field = (name: SkillGitField, label: string, helper: string, placeholder: string) => {
    const id = `${ids}-${name}`;
    const describedBy = `${id}-helper`;
    return <div className="field">
      <div className="field-head"><label htmlFor={id}>{label}</label></div>
      <input ref={(element) => {
        fieldRefs[name].current = element;
        if (name === "url") setAnchor(element);
      }} id={id} value={fields[name]} placeholder={placeholder}
        // Read-only rather than disabled while Find Skills runs, so a field pressed Enter in keeps focus.
        readOnly={finding} autoComplete="off" spellCheck={false} autoCapitalize="off"
        aria-invalid={fieldErrors[name] ? true : undefined} aria-describedby={describedBy}
        onChange={(event) => setField(name, event.target.value)}
        onBlur={(event) => {
          if (edited[name]) setFieldErrors((current) => ({ ...current, [name]: validate(name, event.target.value) ?? undefined }));
        }} />
      {fieldErrors[name]
        ? <FieldError id={describedBy}>{fieldErrors[name]}</FieldError>
        : <p className="field-helper" id={describedBy}>{helper}</p>}
    </div>;
  };

  const sourceStep = <form className="form" noValidate onSubmit={(event) => {
    event.preventDefault();
    // Enter again while Find Skills runs is the busy primary's click: refused, as the server
    // reads one source at a time.
    if (!finding) void find();
  }}>
    {field("url", "Repository", "owner/repository on GitHub, or an HTTPS or SSH address.", "e.g. org/skills")}
    <div className="field-row">
      {field("ref", "Branch or Tag", "Leave empty for the default branch.", "e.g. main")}
      {field("folder", "Folder (Optional)", "Look for skills only in this folder.", "e.g. .agents/skills")}
    </div>
    {/* Enter in a field submits; the visible Find Skills is the footer's primary (§7.3). */}
    <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
    {failure && <State variant="error" title="Couldn't Read the Repository">{failure}</State>}
  </form>;

  const commit = candidates[0]?.commit ?? held;
  const strip = <div className="skill-git-strip">
    <SkillReviewFacts facts={[
      { label: "Repository", value: reviewed.url },
      { label: "Branch or Tag", value: gitRefLabel(reviewed.ref) },
      ...(finding || commit ? [{ label: "Commit", value: commit ? <span className="mono">{shortCommit(commit)}</span> : null }] : []),
    ]} />
    <button ref={setAnchor} type="button" className="btn sm" disabled={importing} onClick={changeSource}>Change Source</button>
  </div>;

  const nextCheck = upToDate ? gitNextCheckText(check?.autoUpdate, Date.now()) : null;
  // Reading the branch's head is a new review, so nothing checked or accepted for the held commit carries over.
  const reviewLatest = () => void find(false, null);
  const branchNotice = held && preview && !finding ? gitHeldBranchNotice(reviewed.ref, held, preview.refCommit) : null;
  const branch = branchNotice && <div className="skill-git-message skill-git-branch">
    <Notice as="section" tone="info" title={branchNotice.title} ariaLabel={branchNotice.title}
      actions={branchNotice.newer
        ? <button type="button" className="btn sm" disabled={importing} onClick={reviewLatest}>Review Newer Commit</button>
        : undefined}>
      <p>{branchNotice.body}</p>
    </Notice>
  </div>;
  const review = upToDate && preview
    ? <>
      <State icon={<BranchIcon size={24} />} title={`${check!.skillName} Is Up to Date`} headingLevel={3} compact>
        <p>Commit <span className="mono">{shortCommit(candidates[0]!.commit)}</span> on {reviewed.ref || "the default branch"} has the same files as the library.</p>
        {nextCheck && <p>{nextCheck}</p>}
      </State>
      {branch}
    </>
    : <>
      {strip}
      {branch}
      {failure
        ? <div className="skill-git-message">
          <State variant="error" title={held ? "Couldn't Read the Held Commit" : "Couldn't Read the Repository"}
            actions={<>
              <button type="button" className="btn sm" onClick={() => void find()}>Try Again</button>
              {held && <button type="button" className="btn sm" onClick={reviewLatest}>Review Latest Commit</button>}
            </>}>{failure}</State>
        </div>
        : finding
          ? <div className="skill-git-panes">
            <div className="skill-git-pane list skill-git-loading" role="status">
              <span className="sr-only">Finding skills…</span>
              <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
            </div>
          </div>
          : preview && candidates.length === 0
            ? <div className="skill-git-message">
              <State title="No Skills Found" headingLevel={3} compact>
                {reviewed.folder
                  ? <>No folder under <span className="mono">{reviewed.folder}</span> has a SKILL.md file. Change the source to look somewhere else.</>
                  : "No folder in this repository has a SKILL.md file. Change the source to look somewhere else."}
              </State>
            </div>
            : preview && <div className="skill-git-panes">
              <div className="skill-git-pane list">
                <h3 className="skill-git-title">{candidates.length === 1 ? "1 Skill Found" : `${candidates.length} Skills Found`}</h3>
                <ChoiceRows multiple label="Skills Found"
                  options={candidates.map((candidate) => ({
                    value: candidate.path,
                    title: candidate.name,
                    description: gitCandidateConsequence(candidate, libraryVersions?.get(candidate.name)),
                    meta: gitCandidateCounts(candidate),
                    disabled: importing,
                  }))}
                  value={checked}
                  onChange={(path) => {
                    setAccepted(false);
                    setChecked((current) => current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]);
                  }}
                  show={{ value: shown, onShow: setShown, controls: diffId }} />
              </div>
              <div className={`skill-git-pane review ${SKILL_DIFF_PANE_CLASS}`} id={diffId}>
                {shownCandidate
                  ? <SkillReviewChanges key={shownCandidate.path}
                    title={shownCandidate.disposition === "new" ? `Files in ${shownCandidate.name}` : `Changes in ${shownCandidate.name}`}
                    note={skillReviewSafetyNote("importing")}
                    files={{ previous: shownCandidate.previousFiles, current: shownCandidate.files, executablePaths: shownCandidate.executablePaths }}
                    loading="" />
                  : <p className="skill-git-note">Choose a skill to see its files.</p>}
              </div>
            </div>}
      {error && <div className="skill-git-message"><State variant="error" title="Couldn't Import">{error}</State></div>}
    </>;

  const reason = step === "review" && !finding && !failure && preview && !upToDate && conflict === null
    // An unchecked consent beside the primary is its own reason.
    && candidates.length > 0 && !checkedCandidates.length ? "Check a skill to import it." : null;
  const primaryBlocked = step === "source" ? finding
    : finding || !preview || !checkedCandidates.length || conflict !== null || (needsConsent && !accepted);

  return <Modal title={check ? held ? "Review Held Update" : "Check for Updates" : "Import from Git"} size="lg" phoneSheet="full"
    className={`skill-review skill-git-import${step === "review" && !upToDate ? " is-review" : ""}`}
    description={step === "source" ? "Find the skills in a repository, then review every file before importing." : undefined}
    onClose={close} footer={<>
      {step === "review" && (conflict !== null
        ? <ReviewConflict name={conflict} busy={busy} onPreviewAgain={() => void find(true)} />
        : needsConsent && <ReviewConsent label={deployToAssignmentsConsent(deployedAssignments)} checked={accepted} disabled={importing} onChange={setAccepted} />)}
      {reason && <p className="skill-git-reason" id={reasonId}>{reason}</p>}
      <button ref={upToDate ? setAnchor : undefined} className="btn" type="button" disabled={importing} onClick={close}>{upToDate ? "Done" : "Cancel"}</button>
      {!upToDate && <BusyButton className="btn primary" busy={step === "source" ? finding : importing}
        progress={step === "source" ? "Finding skills…" : "Importing…"}
        aria-disabled={primaryBlocked && !(step === "source" ? finding : importing) ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => {
          if (primaryBlocked) return;
          if (step === "source") void find();
          else void submit();
        }}>
        {step === "source" ? "Find Skills" : gitImportLabel(checkedCandidates.length, Boolean(check))}
      </BusyButton>}
    </>}>
    <div ref={bodyRef} className="skill-git-body">
      {step === "source" ? sourceStep : review}
    </div>
  </Modal>;
}
