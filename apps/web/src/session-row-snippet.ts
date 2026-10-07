import { plainTextPreview, sessionAttentionBreakdown, type SessionView } from "@wollipog/protocol";

/**
 * What a wide Sessions row says after its title (#2218, docs/design-system.md §6.3): what the
 * session wants. The top request the person owns, by the same ranking as the row's badge, else the
 * latest agent message, both as one line of plain text. Empty when there is neither.
 */
export function sessionRowSnippet(
  session: Pick<SessionView, "status" | "pendingApproval" | "attentionOwners" | "preview"> &
    Partial<Pick<SessionView, "orchestratorCampaign" | "pendingRequestOwners">>,
): string {
  const request = sessionAttentionBreakdown(session)[0]?.requests[0];
  return plainTextPreview(request?.title) || plainTextPreview(session.preview);
}
