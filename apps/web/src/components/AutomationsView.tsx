import { useCallback, useState } from "react";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import type { AutomationAction, AutomationSchedule } from "@wollipog/protocol";
import { AutomationsIcon } from "./Icons.js";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { OutboundEventSubscriptions } from "./OutboundEventSubscriptions.js";
import { PageHeader } from "./PageHeader.js";
import { destination } from "../navigation.js";
import { useAutomationPolling } from "./useAutomationPolling.js";

function actionSummary(action: AutomationAction): string {
  if (action.kind === "prompt_session") return `Prompt session ${action.sessionId}`;
  if (action.kind === "workflow_run") return `Workflow ${action.request.workflowId} on ${action.request.runnerId}`;
  return `Create ${action.request.agentId} session on ${action.request.runnerId}`;
}

/**
 * One automation on the list. Its heading button opens the automation's page (#2968), which holds
 * everything the card used to expand into; the list rows that replace these cards are #2969's.
 */
function AutomationCard({ item, onOpen }: { item: AutomationSchedule; onOpen: () => void }) {
  return (
    <article className="automation-card">
      <h3 className="automation-card-heading">
        <button type="button" className="automation-card-toggle" onClick={onOpen}>
          <span className="automation-card-summary">
            <span className="automation-card-name">{item.name}</span>
            <span className="automation-card-action">{actionSummary(item.action)}</span>
          </span>
          <span className="automation-card-meta">
            {item.targetHealth && <StatusBadge meta={statusMeta("automation", "target_unavailable")} />}
            <StatusBadge meta={statusMeta("automation", item.enabled ? "enabled" : "paused")} />
          </span>
        </button>
      </h3>
    </article>
  );
}

export function AutomationsView() {
  const api = useApi();
  const projects = useStoreSelector((state) => state.projects);
  const { navigate } = useStoreActions();
  const [items, setItems] = useState<AutomationSchedule[]>([]);
  /** The list has been read once; before that an empty list proves nothing (§12). */
  const [listLoaded, setListLoaded] = useState(false);

  // The list alone: each automation's history and triggers are read by its own page.
  const load = useCallback(async (current: () => boolean) => {
    const result = await api.automations();
    if (!current()) return;
    setItems(result.automations);
    setListLoaded(true);
  }, [api]);
  const { error } = useAutomationPolling(load);

  const openNewAutomation = () => navigate({ name: "automations", editor: { kind: "new" } });

  return (
    <section className="page">
      <PageHeader
        title={destination("automations").name}
        description={destination("automations").description}
        primary={{ label: "New Automation", onClick: openNewAutomation }}
      />
      {error && <div className="automation-error" role="alert">{error.message}</div>}

      <OutboundEventSubscriptions projects={[...projects.values()]} automations={items} />

      <div className="automation-list">
        {items.length === 0 && (listLoaded ? (
          <State
            icon={<AutomationsIcon />}
            title={`No ${destination("automations").name} Yet`}
            // This screen exposed an `h3` before the conversion, and heading navigation is how a
            // screen-reader user finds a section. Losing it is not a styling change.
            headingLevel={3}
            actions={
              <button type="button" className="btn primary" onClick={openNewAutomation}>
                New Automation
              </button>
            }
          >
            Create a finite, auditable schedule that runs while this control plane stays online.
          </State>
        ) : !error && <State variant="loading">Loading automations…</State>)}
        {items.map((item) => (
          <AutomationCard
            key={item.automationId}
            item={item}
            onOpen={() => navigate({ name: "automation", id: item.automationId })}
          />
        ))}
      </div>
    </section>
  );
}
