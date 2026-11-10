import { useEffect, useState } from "react";
import { runnerSupportsProtocol, type GitPrSummary, type GitRequestDiffInfo } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { safeExternalHref } from "../external-href.js";
import { GitDiffViewer } from "./GitDiffViewer.js";

/** A separate read-only snapshot: local file actions and local finding anchors do not apply. */
export function RequestDiff({ sessionId, pr, online, protocol, observation }: {
  sessionId: string;
  pr: GitPrSummary;
  online: boolean;
  protocol: number | null | undefined;
  observation: number;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<GitRequestDiffInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = runnerSupportsProtocol(protocol, "requestDiff");
  useEffect(() => {
    let current = true;
    setResult(null);
    setError(null);
    setBusy(false);
    if (!open || !online || !supported) return;
    setBusy(true);
    void api.git(sessionId, { action: "request_diff", requestUrl: pr.url }).then((data) => {
      if (!current) return;
      if (!data.requestDiff || data.requestDiff.requestUrl !== pr.url) {
        setError("The machine did not return a diff for this request.");
      } else setResult(data.requestDiff);
    }).catch(() => {
      if (current) setError("The request diff is unavailable or its revisions changed while loading. Reload or open the forge.");
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [api, sessionId, pr.url, pr.baseRef, pr.headRef, pr.state, open, online, supported, reload, observation]);
  const href = safeExternalHref(pr.url);
  return <details className="review-request-checks" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Request Diff</summary>
    {open && <>
      <p>The forge request’s own diff against its target revision. Local Branch changes are shown separately below.</p>
      {!supported ? <p>This machine does not support request diffs. Update it to view the diff here.</p>
        : !online ? <p>The machine is offline. Reconnect to read the request diff.</p>
        : <button type="button" className="btn sm" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload Request Diff</button>}
      {busy && <p role="status">Loading request diff…</p>}
      {error && <p role="alert">{error}</p>}
      {result && online && supported && <>
        <dl className="review-request-facts">
          <div><dt>Target</dt><dd>{result.baseRef} ({result.targetOid})</dd></div>
          <div><dt>Diff Base</dt><dd>{result.baseOid}</dd></div>
          <div><dt>Head</dt><dd>{result.headRef} ({result.headOid})</dd></div>
        </dl>
        <p>Snapshot read {new Date(result.readAt).toLocaleString()}. Reload to check for newer revisions.</p>
        {result.incomplete && <p role="status">This diff is incomplete. Some files or lines are unavailable; open the forge for the complete diff.</p>}
        <GitDiffViewer diff={result.diff} />
      </>}
      {href && <a className="link" href={href} target="_blank" rel="noreferrer">Open Request on Forge</a>}
    </>}
  </details>;
}
