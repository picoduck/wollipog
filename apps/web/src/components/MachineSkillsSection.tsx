import { useId, useRef, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { agentDisplayName } from "../agent-presentation.js";
import { useApi } from "../api-context.js";
import { relativeTime } from "../format.js";
import {
  normalizeRemovalReporting,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  type RunnerSkillsResponse,
} from "../skills.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";

/**
 * Skills on This Machine, in the machine's detail in Connections (#1981, #2989): what the machine
 * itself reports about skills rather than any one skill. A disclosure, closed until opened, which
 * reads the machine's latest report on every opening (§5.5); inside, its unmanaged skills and every
 * link removal it reported, including those of skills the library no longer has, as rows (§5.2)
 * whose account labels follow Hide Account Emails (§11.8). A failed read offers Retry (§12.4).
 */
export function MachineSkillsSection({ runner }: { runner: RunnerView }) {
  const api = useApi();
  const ids = useId().replace(/:/g, "");
  const [state, setState] = useState<RunnerSkillsResponse | "error" | null>(null);
  const [loading, setLoading] = useState(false);
  /** Counts openings and closings: each one starts a new reveal scope, so closing the disclosure
   * hides every account email revealed inside it. */
  const [revealEpoch, setRevealEpoch] = useState(0);
  /** Whether a read is running, so one opening never reads twice. */
  const reading = useRef(false);
  if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) return null;

  // Read on every opening, so what it shows is the machine's latest report; the last one stays on
  // screen while the next is read.
  const load = () => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    api.runnerSkills(runner.runnerId)
      .then((response) => setState({ ...response, removalReporting: normalizeRemovalReporting(response.removalReporting) }))
      .catch(() => setState("error"))
      .finally(() => {
        reading.current = false;
        setLoading(false);
      });
  };
  const loaded = state && typeof state === "object" ? state : null;
  const unmanaged = reportedUnmanagedSkills(loaded?.reported);
  const removals = reportedSkillLinkRemovals(loaded?.reported, null);
  const removalReporting = loaded?.removalReporting ?? "unknown";
  const account = (providerAccountId: string, key: string) => {
    const label = runner.providerAccounts?.find((item) => item.id === providerAccountId)?.label ?? "Provider Account";
    return (
      <AccountIdentifier identity={`${runner.runnerId}:${key}:${revealEpoch}`} value={label} label="Account Email" lead="Account"
        className="machine-skill-account" />
    );
  };
  const agentName = (agentId: string) => {
    const agent = runner.agents.find((item) => item.id === agentId);
    return agent ? agentDisplayName(agent) || agentId : agentId;
  };
  const reportedAt = loaded?.reported?.removalsUpdatedAt ?? loaded?.reported?.updatedAt;
  const unmanagedId = `machine-skills-unmanaged-${ids}`;
  const removalsId = `machine-skills-removals-${ids}`;

  return (
    <section className="section" aria-label="Skills on This Machine">
      <details className="disclosure machine-skills" onToggle={(event) => {
        setRevealEpoch((value) => value + 1);
        if (event.currentTarget.open) load();
      }}>
        <summary>
          <ChevronRightIcon className="disclosure-chevron" />
          <span>Skills on This Machine</span>
        </summary>
        <div className="disclosure-body">
          {loading && state === null && <p className="machine-section-state">Loading…</p>}
          {state === "error" && (
            <Notice tone="danger" compact role="alert" title="Couldn't Load Skills on This Machine"
              actions={<button type="button" className="btn sm" disabled={loading} onClick={load}>Retry</button>}>
              Wollipog couldn't read this machine's skills report.
            </Notice>
          )}
          {loaded && !loaded.reported && <p className="machine-section-state">This machine hasn&apos;t reported its skills yet.</p>}
          {loaded?.reported && unmanaged.length === 0 && (
            <p className="machine-section-state">This machine reports no unmanaged skills.</p>
          )}
          {unmanaged.length > 0 && (
            <div className="machine-skills-group">
              <h4 className="machine-skills-label" id={unmanagedId}>Unmanaged Skills</h4>
              <ul className="surface machine-skills-rows" aria-labelledby={unmanagedId}>
                {unmanaged.map((entry) => {
                  const key = `${entry.providerAccountId ?? "legacy"}:${entry.agentId}:${entry.name}`;
                  return (
                    <li key={key} className="row row-2">
                      <span className="row-body">
                        <span className="row-line">
                          <span className="row-title">{entry.name}</span>
                          <span className="machine-skill-meta">{agentName(entry.agentId)}</span>
                          {entry.providerAccountId && account(entry.providerAccountId, key)}
                        </span>
                        {entry.description && <span className="row-sub" title={entry.description}>{entry.description}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="section-note">
                These skills live on the machine but are not managed here. Use Import from Machine to preview or import a snapshot. On a compatible Linux runner, an identical assigned version can then be adopted with an explicit recovery-aware confirmation.
              </p>
            </div>
          )}
          {loaded?.reported && (removals.length > 0 || removalReporting !== "unknown") && (
            <div className="machine-skills-group">
              <div className="machine-skills-head">
                <h4 className="machine-skills-label" id={removalsId}>Recent Link Removals</h4>
                {removals.length > 0 && reportedAt !== undefined && (
                  <span className="machine-skills-reported">Reported {relativeTime(reportedAt)}</span>
                )}
              </div>
              {removalReporting === "unsupported" && (
                <p className="machine-section-state">This runner version cannot report new managed link removals.</p>
              )}
              {removalReporting === "supported" && removals.length === 0 && (
                <p className="machine-section-state">No managed link removals have been reported.</p>
              )}
              {removals.length > 0 && (
                <ul className="surface machine-skills-rows" aria-labelledby={removalsId}>
                  {removals.map((entry, index) => {
                    const key = `${entry.path}:${entry.reason}:${index}`;
                    return (
                      <li key={key} className="row row-2">
                        <span className="row-body">
                          <span className="row-line">
                            <span className="row-title machine-skill-path" title={entry.path}><bdi>{entry.path}</bdi></span>
                            {entry.providerAccountId && account(entry.providerAccountId, key)}
                          </span>
                          <span className="row-sub" title={entry.reason}>{entry.reason}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
