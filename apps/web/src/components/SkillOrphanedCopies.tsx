import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import {
  invocationLabel,
  omittedKeptAsideCopies,
  orphanedCopyKey,
  reportedOrphanedCopies,
  type OrphanedSkillCopy,
  type RunnerSkillsResponse,
} from "../skills.js";

/** Whether this machine's runner can act on the copy right now. */
export function canResolveOrphanedCopy(runner: RunnerView, copy: OrphanedSkillCopy): boolean {
  return runner.status === "online" &&
    runnerSupportsProtocol(runner.protocolVersion, copy.kind === "kept_aside" ? "skillKeptAsideCopies" : "skillDrift");
}

/** A kept-aside copy that is neither readable nor fingerprinted has nothing a discard could be fenced on. */
export function orphanedCopyDiscardable(copy: OrphanedSkillCopy): boolean {
  return copy.kind === "deleted_skill" || !!copy.observedDigest || !!copy.observedFingerprint;
}

function copyDetail(copy: OrphanedSkillCopy): string | undefined {
  if (copy.kind === "kept_aside") return copy.detail;
  const base = copy.held
    ? "This skill was deleted from the library while this machine held an edited copy, so its links still serve the copy."
    : "This skill was deleted from the library while this machine kept an edited copy. No link serves it.";
  return copy.observedDigest
    ? base
    : `${base} The copy cannot be read as skill content, so discarding it moves it aside first.`;
}

/** Every orphaned edited copy, grouped by machine, independent of any library skill. */
export function SkillOrphanedCopies({ runners, machineLabels, machineSkills, busy, syncingRunnerId, onSync, onReview, onDiscard }: {
  runners: RunnerView[];
  machineLabels: ReadonlyMap<string, string>;
  machineSkills: Record<string, RunnerSkillsResponse>;
  busy: boolean;
  syncingRunnerId: string | null;
  onSync: (runnerId: string) => void;
  onReview: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
  onDiscard: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
}) {
  return (
    <section className="skills-section" aria-label="Orphaned Copies">
      <h3>Orphaned Copies</h3>
      <p className="skills-hint">
        Edited skill copies that a machine kept but no library skill shows: copies a restore kept aside, and edited copies
        of skills deleted from the library. Review and import a copy to keep it in the library, or discard it.
      </p>
      {runners.length === 0 && <p className="skills-hint">No machines are connected.</p>}
      {runners.map((runner) => {
        const machine = machineSkills[runner.runnerId];
        const copies = reportedOrphanedCopies(machine);
        const omitted = omittedKeptAsideCopies(machine);
        const keptAsideUnsupported = machine?.keptAsideReporting === "unsupported";
        return (
          <article className="skills-machine" key={runner.runnerId} aria-label={machineLabels.get(runner.runnerId) ?? runner.runnerId}>
            <div className="skills-machine-head">
              <strong>{machineLabels.get(runner.runnerId) ?? runner.runnerId}</strong>
              <button
                type="button"
                className="btn sm"
                disabled={runner.status !== "online" || syncingRunnerId !== null}
                onClick={() => onSync(runner.runnerId)}
              >
                {syncingRunnerId === runner.runnerId ? "Syncing…" : "Sync Now"}
              </button>
            </div>
            {!machine && <p className="skills-hint">Skills status has not loaded.</p>}
            {machine?.loadError && <p className="skills-hint">{machine.loadError}</p>}
            {machine && !machine.loadError && copies.length === 0 && omitted === 0 && (
              <p className="skills-hint">{keptAsideUnsupported
                ? "No edited copies of deleted skills are reported."
                : "No orphaned copies are reported."}</p>
            )}
            {keptAsideUnsupported && (
              <p className="skills-hint">This runner version cannot report copies a restore kept aside. Update it to list them here.</p>
            )}
            {copies.length > 0 && (
              <ul className="skills-orphans">
                {copies.map((copy) => {
                  const actionable = !busy && canResolveOrphanedCopy(runner, copy);
                  const detail = copyDetail(copy);
                  return (
                    <li key={orphanedCopyKey(copy)}>
                      <div className="skills-orphan-head">
                        <strong>{copy.name ?? "Unidentified Copy"}</strong>
                        <span className="status-badge st-input">{copy.kind === "kept_aside" ? "Kept Aside" : "Deleted Skill"}</span>
                      </div>
                      <dl className="skills-orphan-facts">
                        <div><dt>Invocation</dt><dd>{copy.variant ? invocationLabel(copy.variant) : "Unknown"}</dd></div>
                        <div><dt>Version</dt><dd>{copy.digest ? copy.digest.slice(0, 12) : "Unknown"}</dd></div>
                        {copy.kind === "kept_aside" && (
                          <div><dt>Kept Aside</dt><dd>{copy.keptAsideAt ? new Date(copy.keptAsideAt).toLocaleString() : "Unknown"}</dd></div>
                        )}
                        <div><dt>Content</dt><dd>{copy.observedDigest ? "Readable" : "Unreadable"}</dd></div>
                        {copy.kind === "kept_aside" && (
                          <div className="skills-orphan-entry"><dt>Store Entry</dt><dd><code>.drift-{copy.id}</code></dd></div>
                        )}
                      </dl>
                      {detail && <p className="skills-hint">{detail}</p>}
                      <div className="skills-drift-actions">
                        <button
                          type="button"
                          className="btn sm"
                          disabled={!actionable || !copy.observedDigest}
                          onClick={() => onReview(runner, copy)}
                        >
                          Review and Import
                        </button>
                        <button
                          type="button"
                          className="btn danger sm"
                          disabled={!actionable || !orphanedCopyDiscardable(copy)}
                          onClick={() => onDiscard(runner, copy)}
                        >
                          Discard Copy
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {omitted > 0 && (
              <p className="skills-hint">
                {omitted === 1 ? "1 more kept-aside copy is" : `${omitted} more kept-aside copies are`} not listed.
                Resolve listed copies, or remove copies on the machine, to list the rest.
              </p>
            )}
            {runner.status === "online" && copies.some((copy) => !canResolveOrphanedCopy(runner, copy)) && (
              <p className="skills-hint">Update this machine's runner to resolve these copies here.</p>
            )}
          </article>
        );
      })}
    </section>
  );
}
