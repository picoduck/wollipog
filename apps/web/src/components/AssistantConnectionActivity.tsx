import React, { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import { assistantOperationTitle, type AssistantActivity } from "../assistant-connections.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { SettingsGroup, StaticRow } from "./ui/SettingsRows.js";
import { useIsMobile } from "./useIsMobile.js";

export function AssistantConnectionActivity({ id }: { id: string }) {
  const api = useApi();
  const phone = useIsMobile();
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api.assistantConnectionActivity(id).then(result => {
      if (!cancelled) setActivity(result.activity);
    }, cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Couldn't load connection activity.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, id, refresh]);

  return (
    <SettingsGroup title="Activity" intro="Shows the latest 100 actions. Credentials and tool arguments are excluded."
      action={<button className="btn sm" type="button" disabled={loading} onClick={() => {
        setError("");
        setLoading(true);
        setRefresh(attempt => attempt + 1);
      }}>Refresh</button>}
      notice={error && <Notice tone="danger" role="alert" compact>{error}</Notice>}>
      {activity?.length ? (
        <div className="assistant-activity-scroll" role="region" aria-label="Recent Actions" tabIndex={0}>
          <table className="assistant-activity-table" role="table" aria-label="Connection Activity">
            <thead role="rowgroup" className={phone ? "sr-only" : undefined}>
              <tr role="row"><th role="columnheader" scope="col">Operation</th><th role="columnheader" scope="col">Target</th><th role="columnheader" scope="col">Outcome</th><th role="columnheader" scope="col">When</th></tr>
            </thead>
            <tbody role="rowgroup">{activity.map((item, index) => (
              <tr key={index} role="row">
                <td role="cell">{assistantOperationTitle(item.operation)} <code>{item.operation}</code></td>
                <td role="cell"><span className="assistant-activity-target" title={item.targetLabel}>{item.targetLabel}</span></td>
                <td role="cell"><StatusBadge label={titleCaseLabel(item.outcome)} tone={item.outcome === "succeeded" ? "success" : item.outcome === "refused" ? "warning" : "danger"} /></td>
                <td role="cell">
                  <time dateTime={new Date(item.created_at).toISOString()} title={new Date(item.created_at).toLocaleString()}>
                    {relativeTime(item.created_at)}
                  </time>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : loading ? <StaticRow title="Loading Activity" /> : !error && <StaticRow title="No Activity" />}
    </SettingsGroup>
  );
}
