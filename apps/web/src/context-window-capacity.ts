import type { AgentModel, SessionView } from "@wollipog/protocol";
import { advertisedContextWindow } from "./context-window-options.js";

export type ContextWindowCapacity =
  | {
    known: false;
    capacity: null;
    source: null;
    served: null;
    advertised: null;
  }
  | {
    known: true;
    capacity: number;
    source: "served" | "catalog";
    served: number | null;
    advertised: number | null;
  };

function positiveCapacity(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Resolve the one context-window capacity used by both status-strip seat allocation and the
 * meter. A live provider report wins; until one arrives, the selected catalog entry supplies the
 * capacity, with the provider's default entry as the existing fallback when no selection matches.
 */
export function resolveContextWindowCapacity(
  session: Pick<SessionView, "contextWindow" | "model">,
  models: AgentModel[],
): ContextWindowCapacity {
  const selected = models.find((model) => model.id === session.model);
  const catalogModel = selected ?? models.find((model) => model.default);
  const served = positiveCapacity(session.contextWindow);
  const advertised = advertisedContextWindow(models, session.model ?? catalogModel?.id);

  if (served !== null) {
    return { known: true, capacity: served, source: "served", served, advertised };
  }

  const catalog = positiveCapacity(catalogModel?.contextWindow);
  if (catalog !== null) {
    return { known: true, capacity: catalog, source: "catalog", served: null, advertised };
  }

  return { known: false, capacity: null, source: null, served: null, advertised: null };
}
