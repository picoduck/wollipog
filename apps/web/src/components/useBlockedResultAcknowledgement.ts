import { useCallback, useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { blockedResultAcknowledgementTargets } from "../background-delivery-status.js";
import { useFeedback } from "./FeedbackProvider.js";

/** Both entry points send the exact snapshots visible on this render. The server's session update
 * clears every surface, including other dashboards; its response also settles this panel locally. */
export function useBlockedResultAcknowledgement(session: SessionView) {
  const api = useApi();
  const { showToast } = useFeedback();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const targets = blockedResultAcknowledgementTargets(session);
  const key = (parentTurnId: string, revision: string) => JSON.stringify([session.id, parentTurnId, revision]);
  const isAcknowledged = useCallback((parentTurnId: string, revision: string) =>
    acknowledged.has(JSON.stringify([session.id, parentTurnId, revision])), [acknowledged, session.id]);
  return {
    busy,
    acknowledged,
    available: targets.some((target) => !isAcknowledged(target.parentTurnId, target.revision)),
    isAcknowledged,
    acknowledge: () => {
      if (pending.current || targets.length === 0) return;
      pending.current = true;
      setBusy(true);
      void api.acknowledgeBackgroundBlockedResults(session.id, targets).then((updated) => {
        const resolved = (updated.backgroundDeliveries ?? []).flatMap((delivery) =>
          delivery.blockedResultAcknowledgedAt != null && delivery.blockedResultRevision
            ? [key(delivery.parentTurnId, delivery.blockedResultRevision)] : []);
        setAcknowledged((current) => new Set([...current, ...resolved]));
        showToast(resolved.length ? "Blocked-result alerts acknowledged." : "Background results changed. Review the current alerts.",
          { tone: resolved.length ? "success" : "info" });
      }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "The blocked-result alerts could not be acknowledged.", { tone: "error" });
      }).finally(() => {
        pending.current = false;
        setBusy(false);
      });
    },
  };
}
