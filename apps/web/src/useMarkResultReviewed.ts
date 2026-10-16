import { useCallback } from "react";
import { useApi } from "./api-context.js";
import { useStoreActions } from "./store.js";
import { useFeedback } from "./components/FeedbackProvider.js";

/** Menu and keyboard actions acknowledge only the result the person acted on. */
export function useMarkResultReviewed() {
  const api = useApi();
  const { loadSession } = useStoreActions();
  const { showToast } = useFeedback();
  return useCallback((sessionId: string, revision: string) => {
    void api.markResultReviewed(sessionId, revision).then(({ acknowledged, session }) => {
      loadSession(session);
      if (!acknowledged) showToast("A newer result is waiting for review.");
    }).catch((cause: unknown) => showToast((cause as Error).message, { tone: "error" }));
  }, [api, loadSession, showToast]);
}
