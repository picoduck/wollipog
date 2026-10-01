import { useEffect, useId, useMemo, useRef, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import { relativeTime } from "../format.js";
import { machineOptionLabels } from "../runners.js";
import { skillFromPayload, skillVersionLabel, skillVersionNote, type MachineSkillVersionPreview } from "../skills.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { ReviewConsent, switchAgentsConsent } from "./ReviewConsent.js";
import { SkillReviewChanges, skillReviewSafetyNote } from "./SkillReviewParts.js";
import { SkillVersionListEnd, useSkillVersionPages } from "./SkillVersionPages.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select, type ChoiceRowOption } from "./ui/ChoiceControls.js";

/** Why Save Version is disabled while the machine's own version is chosen (§7.3). */
export const UNCHANGED_VERSION_REASON = "Choose a different version to save.";
/** How long a choice settles before its changes are read, so arrowing through the list reads one. */
export const MACHINE_VERSION_PREVIEW_DELAY_MS = 250;
/** Track Latest's value in the choice list; a pin's value is its version id. */
const TRACK_LATEST = "";

/**
 * Machine Version (#1984): which version of a skill one machine runs. A full-width Machine select,
 * then every choice as a radio row, Track Latest and then each version to pin, with the machine's own
 * marked Current. Choosing a different one reads what it changes on its own, so there is no Preview
 * step; saving the choice already in force is disabled with the reason.
 */
export function SkillMachineVersionDialog({ skillId, runners, machineLabels, initialRunnerId, onClose, onSaved }: {
  skillId: string;
  runners: RunnerView[];
  /** The page's machine names; the dialog derives its own when absent. */
  machineLabels?: ReadonlyMap<string, string>;
  initialRunnerId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const compatible = runners.filter((runner) => runnerSupportsProtocol(runner.protocolVersion, "agentSkills"));
  const labels = useMemo(() => machineLabels ?? machineOptionLabels(runners), [machineLabels, runners]);
  const [runnerId, setRunnerId] = useState(compatible.some(runner => runner.runnerId === initialRunnerId) ? initialRunnerId! : compatible[0]?.runnerId ?? "");
  const machineName = labels.get(runnerId) ?? "This machine";
  const pages = useSkillVersionPages(skillId);
  const { versions } = pages;
  const byId = useMemo(() => new Map(versions.flatMap((version) => version.id ? [[version.id, version] as const] : [])), [versions]);

  /** The version the machine is pinned to, or null while it tracks the latest; undefined until read. */
  const [currentPin, setCurrentPin] = useState<string | null | undefined>(undefined);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [choice, setChoice] = useState(TRACK_LATEST);
  /** Agents on the machine that run this skill; null when the machine's skills could not be read. */
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ key: string; value: MachineSkillVersionPreview } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);
  /** Bumped by Retry and Preview Again to read the same choice afresh. */
  const [previewNonce, setPreviewNonce] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setCurrentPin(undefined); setPolicyError(null); setChoice(TRACK_LATEST); setPreview(null); setPreviewError(null); setAccepted(false);
    if (!runnerId) return;
    api.getMachineSkillVersionPolicy(skillId, runnerId).catch(async cause => {
      // Older control planes expose policy only through the existing, equally scoped preview.
      // Do not fall back for server/network errors or infer a tracking default from failure.
      if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
      return { policy: (await api.previewMachineSkillVersion(skillId, runnerId, null)).policy };
    }).then(result => {
      if (!active) return;
      const pin = result.policy?.versionId ?? null;
      setCurrentPin(pin); setChoice(pin ?? TRACK_LATEST);
    }).catch(cause => { if (active) setPolicyError(`The machine's current version couldn't be loaded: ${(cause as Error).message}`); });
    return () => { active = false; };
  }, [api, skillId, runnerId]);

  // The agents this machine deploys the skill to, for the consent's count. A failure leaves the
  // count unknown, which still asks for consent rather than assuming nothing runs there.
  useEffect(() => {
    let active = true;
    setAgentCount(null);
    if (!runnerId) return;
    void Promise.all([api.getSkill(skillId), api.runnerSkills(runnerId)]).then(([skill, machine]) => {
      const name = skillFromPayload(skill)?.name;
      if (!active || !name || machine.loadError) return;
      setAgentCount(new Set(machine.desired.find((entry) => entry.name === name)?.targets.map((target) => target.agentId) ?? []).size);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, skillId, runnerId]);

  // A pin older than the versions read so far is read page by page, so its row can name it.
  const pinMissing = !!currentPin && !byId.has(currentPin);
  useEffect(() => {
    if (pinMissing && pages.cursor && !pages.loading && !pages.loadingMore && !pages.error) void pages.loadMore();
  }, [pinMissing, pages.cursor, pages.loading, pages.loadingMore, pages.error, pages.loadMore]);

  const loaded = currentPin !== undefined;
  const unchanged = loaded && choice === (currentPin ?? TRACK_LATEST);
  const key = `${runnerId}\n${choice}`;
  // Choosing reads what the choice changes once it settles; only the newest read is kept.
  useEffect(() => {
    if (!loaded || unchanged || !runnerId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      api.previewMachineSkillVersion(skillId, runnerId, choice || null).then((value) => {
        if (!active) return;
        setPreview({ key, value });
        // The preview reports the machine's version as it is now, which another person may have changed.
        setCurrentPin(value.policy?.versionId ?? null);
      }).catch((cause) => { if (active) setPreviewError({ key, message: (cause as Error).message }); });
    }, MACHINE_VERSION_PREVIEW_DELAY_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, skillId, runnerId, choice, loaded, unchanged, key, previewNonce]);

  const choose = (value: string) => {
    if (saving || value === choice) return;
    setChoice(value); setPreview(null); setPreviewError(null); setAccepted(false); setError(null); setOutcome(null);
  };
  const chooseRunner = (value: string) => {
    if (saving || value === runnerId) return;
    setError(null); setOutcome(null);
    setRunnerId(value);
  };
  const previewAgain = () => { setPreview(null); setPreviewError(null); setAccepted(false); setError(null); setPreviewNonce((n) => n + 1); };

  const shown = !unchanged && preview?.key === key ? preview.value : null;
  const failure = !unchanged && previewError?.key === key ? previewError.message : null;
  const chosenVersion = choice ? byId.get(choice) : undefined;
  const chosenName = choice ? skillVersionLabel(chosenVersion ?? (shown?.proposedVersion))?.text ?? "the pinned version" : null;
  // Saving changes what runs on the machine only when the proposed content differs from what it runs
  // now (without both digests, assume it does), and only if some agent there runs the skill.
  const sameContent = !!shown?.proposedVersion.digest && shown.proposedVersion.digest === shown.currentVersion?.digest;
  const needsConsent = !!shown && !sameContent && agentCount !== 0;

  const save = async () => {
    if (!shown || unchanged || (needsConsent && !accepted)) return;
    setSaving(true); setError(null);
    try {
      await api.setMachineSkillVersion(skillId, runnerId, { versionId: choice || null, expectedRevision: shown.policy?.revision ?? null, expectedLatestVersionId: shown.expectedLatestVersionId });
    } catch (cause) {
      setPreview(null); setAccepted(false); setError((cause as Error).message);
      setSaving(false);
      return;
    }
    setCurrentPin(choice || null); setPreview(null); setAccepted(false);
    setOutcome(`${machineName} ${chosenName ? `runs ${chosenName}` : "tracks the latest version"} now. An offline machine switches when it reconnects.`);
    try { await onSaved(); } catch { setError("The version was saved, but the Skills page didn't refresh. Reopen it to refresh."); }
    setSaving(false);
  };

  const options: ChoiceRowOption<string>[] = [
    { value: TRACK_LATEST, title: "Track Latest", description: "Always runs the newest library version.",
      status: loaded && currentPin === null ? <span className="status t-neutral no-dot">Current</span> : undefined },
    ...versions.flatMap((version): ChoiceRowOption<string>[] => {
      if (!version.id) return [];
      const note = skillVersionNote(version, byId);
      const date = version.createdAt !== undefined ? relativeTime(version.createdAt) : null;
      return [{
        value: version.id,
        title: `Pin to ${skillVersionLabel(version)?.text ?? "This Version"}`,
        description: [note === undefined ? null : note ?? "No note", date].filter(Boolean).join(" · ") || undefined,
        status: version.id === currentPin ? <span className="status t-neutral no-dot">Current</span> : undefined,
      }];
    }),
    // A pin the list never reached (the history ended, or a read failed) still shows, unnamed.
    ...(currentPin && pinMissing && !pages.cursor && !pages.loading && !pages.loadingMore ? [{
      value: currentPin, title: "Pin to an Earlier Version", description: "The version this machine is pinned to.",
      status: <span className="status t-neutral no-dot">Current</span>,
    }] : []),
  ];

  const reasonId = useId();
  const reason = unchanged ? UNCHANGED_VERSION_REASON : null;
  const changesTitle = chosenName ? `Changes If You Pin to ${chosenName}` : "Changes If You Track Latest";

  return <Modal title="Machine Version" size="lg" className="skill-machine-version"
    description="Every agent on a machine runs the same version of a skill."
    onClose={() => { if (!saving) onClose(); }} footer={<>
      {needsConsent && <ReviewConsent label={switchAgentsConsent(agentCount, chosenName ?? "the latest version")}
        checked={accepted} disabled={saving} onChange={setAccepted} />}
      {reason && <p className="skill-version-reason" id={reasonId}>{reason}</p>}
      <button className="btn" type="button" disabled={saving} onClick={onClose}>Cancel</button>
      <BusyButton className="btn primary" busy={saving} progress="Saving the version…"
        disabled={!shown || unchanged || (needsConsent && !accepted)}
        aria-describedby={reason ? reasonId : undefined} onClick={() => void save()}>Save Version</BusyButton>
    </>}>
    <label className="field"><span>Machine</span>
      <Select label="Machine" value={runnerId || null} placeholder="Choose a Machine" disabled={saving || !compatible.length}
        options={compatible.map((runner) => ({ value: runner.runnerId, label: labels.get(runner.runnerId) ?? runner.runnerId }))}
        onChange={chooseRunner} />
    </label>
    {!compatible.length
      ? <p className="skill-version-note">No compatible machines are available. Connect or update a machine to choose the version it runs.</p>
      : policyError ? <Notice tone="danger" role="alert">{policyError}</Notice>
      : <section className="skill-machine-version-choices" aria-label="Versions">
        {!loaded || pages.loading
          ? <div className="skill-version-loading" role="status">
            <span className="sr-only">Loading versions…</span>
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
          : <>
            <ChoiceRows<string> label="Version" value={choice} options={options.map((option) => saving ? { ...option, disabled: true } : option)} onChange={choose} />
            {pages.error && versions.length === 0
              ? <Notice tone="danger" title="Couldn't Load Versions"
                actions={<button className="btn sm" type="button" onClick={() => void pages.reload()}>Retry</button>}>{pages.error}</Notice>
              : <SkillVersionListEnd pages={pages} />}
          </>}
      </section>}
    {outcome && <Notice tone="success" role="status">{outcome}</Notice>}
    {loaded && !unchanged && <SkillReviewChanges
      title={changesTitle}
      note={skillReviewSafetyNote("saving")}
      collapsed
      files={shown ? { previous: shown.currentVersion?.files ?? [], current: shown.proposedVersion.files ?? [] } : null}
      loading={chosenName ? `Reading ${chosenName}…` : "Reading the latest version…"}
      failure={failure && <Notice tone="danger" title="Couldn't Read the Changes"
        actions={<button className="btn sm" type="button" onClick={previewAgain}>Retry</button>}>{failure}</Notice>} />}
    {error && <Notice tone="danger" role="alert"
      actions={!unchanged ? <button className="btn sm" type="button" disabled={saving} onClick={previewAgain}>Preview Again</button> : undefined}>{error}</Notice>}
  </Modal>;
}
