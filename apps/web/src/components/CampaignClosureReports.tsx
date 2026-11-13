import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { Modal } from "./common.js";

type Report = Awaited<ReturnType<ApiClient["campaignClosureReports"]>>["reports"][number];
const labels: Record<string, string> = {
  landed: "Unapproved Issue Closures",
  unverified: "Merge Could Not Be Verified",
  not_dequeued: "Merge Could Not Be Dequeued",
};

/** Human-only receipts remain readable after acknowledgement and never restart a root. */
export function CampaignClosureReports() {
  const api = useApi();
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const result = await api.campaignClosureReports();
        if (active) setReports(result.reports);
      } catch { /* Older servers have no report route; keep the session Inbox usable. */ }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api]);
  const acknowledge = useCallback(async (report: Report) => {
    setBusy(report.occurrenceId); setError("");
    try {
      await api.acknowledgeCampaignClosureReport(report.occurrenceId, report.kind);
      const result = await api.campaignClosureReports();
      setReports(result.reports);
    } catch { setError("The report could not be acknowledged. Try again."); }
    finally { setBusy(null); }
  }, [api]);
  if (!reports.length) return null;
  const current = reports.find(report => report.occurrenceId + report.kind === selected);
  return <section aria-label="Campaign Reports">
    <h2>Campaign Reports</h2>
    {reports.map(report => <div key={report.occurrenceId + report.kind}>
      <button className="btn sm" onClick={() => setSelected(report.occurrenceId + report.kind)}>{labels[report.kind] ?? "Merge Report"}</button>
      {report.acknowledgedAt ? <span> Acknowledged</span> : <span> Needs Acknowledgement</span>}
      <p>{report.campaignTitle ?? report.campaignId}</p>
      <p>{report.repository && report.pullRequest ? `${report.repository} PR #${report.pullRequest}` : "Pull Request Unavailable"}
        {report.issues.length ? ` · ${report.issues.join(", ")}` : " · No Issues Identified"}</p>
    </div>)}
    {current && <Modal title={labels[current.kind] ?? "Merge Report"} onClose={() => setSelected(null)}
      footer={current.acknowledgedAt ? <p role="status">Acknowledged</p>
        : <button className="btn primary" disabled={busy !== null} onClick={() => void acknowledge(current)}>Acknowledge</button>}>
      <p>{current.question}</p>
      <pre className="campaign-closure-report-material">{current.material}</pre>
      <p>The campaign’s root has ended. Review these issues on the forge yourself; acknowledging this report takes no action on them.</p>
    {error && <p role="alert">{error}</p>}
    </Modal>}
  </section>;
}
