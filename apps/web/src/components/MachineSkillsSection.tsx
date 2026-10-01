import React, { useRef, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { accountLabelText } from "../personal-identifiers.js";
import {
  normalizeRemovalReporting,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  type RunnerSkillsResponse,
} from "../skills.js";
import { ChevronRightIcon } from "./Icons.js";

/**
 * Skills on This Machine, in the machine's details in Connections (#1981): what the machine itself
 * reports about skills rather than any one skill. Its unmanaged skills, and every link removal it
 * reported, including those of skills the library no longer has. Read when first opened.
 */
export function MachineSkillsSection({ runner }: { runner: RunnerView }) {
  const api = useApi();
  const [state, setState] = useState<RunnerSkillsResponse | "error" | null>(null);
  const [loading, setLoading] = useState(false);
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
  const accountLabel = (providerAccountId: string) => accountLabelText(
    runner.providerAccounts?.find((account) => account.id === providerAccountId)?.label ?? "Provider Account",
  );
  const agentName = (agentId: string) => runner.agents.find((agent) => agent.id === agentId)?.name || agentId;
  const reportedAt = loaded?.reported?.removalsUpdatedAt ?? loaded?.reported?.updatedAt;

  return (
    <details
      className="runner-agents disclosure machine-skills"
      onToggle={(event) => { if (event.currentTarget.open) load(); }}
    >
      <summary>
        <ChevronRightIcon className="disclosure-chevron" />
        <span className="runner-agents-label">Skills on This Machine</span>
      </summary>
      <div className="runner-agents-body">
        {loading && state === null && <p className="hint">Loading…</p>}
        {state === "error" && (
          <p className="hint" role="alert">Skills status could not be loaded. Close and reopen this section to try again.</p>
        )}
        {loaded && !loaded.reported && <p className="hint">This machine hasn't reported its skills yet.</p>}
        {loaded?.reported && unmanaged.length === 0 && (
          <p className="hint">This machine reports no unmanaged skills.</p>
        )}
        {unmanaged.length > 0 && (
          <div className="machine-skills-group">
            <h5>Unmanaged Skills</h5>
            <ul>
              {unmanaged.map((entry) => (
                <li key={`${entry.providerAccountId ?? "legacy"}:${entry.agentId}:${entry.name}`}>
                  <strong>{entry.name}</strong>
                  {entry.providerAccountId && <span className="muted"> · {accountLabel(entry.providerAccountId)}</span>}
                  <span className="muted"> · {agentName(entry.agentId)}</span>
                  {entry.description && <span className="muted"> — {entry.description}</span>}
                </li>
              ))}
            </ul>
            <p className="hint">
              These skills live on the machine but are not managed here. Use Import from Machine to preview or import a snapshot. On a compatible Linux runner, an identical assigned version can then be adopted with an explicit recovery-aware confirmation.
            </p>
          </div>
        )}
        {loaded?.reported && (removals.length > 0 || removalReporting !== "unknown") && (
          <div className="machine-skills-group">
            <h5>Recent Link Removals</h5>
            {removalReporting === "unsupported" && (
              <p className="hint">This runner version cannot report new managed link removals.</p>
            )}
            {removalReporting === "supported" && removals.length === 0 && (
              <p className="hint">No managed link removals have been reported.</p>
            )}
            {removals.length > 0 && (
              <>
                <p className="hint">Reported {reportedAt === undefined ? "—" : new Date(reportedAt).toLocaleString()}</p>
                <ul>
                  {removals.map((entry, index) => (
                    <li key={`${entry.path}:${entry.reason}:${index}`}>
                      <strong>{entry.path}</strong>
                      {entry.providerAccountId && <span className="muted"> · {accountLabel(entry.providerAccountId)}</span>}
                      <span className="muted"> — {entry.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
