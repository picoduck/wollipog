import { isOwnerQuestionRequest, pendingRequests, presentOwnerQuestionRequest, type PendingApproval, type SessionView } from "@wollipog/protocol";

/**
 * A session as its detail view presents it (#4270): each Owner Question card becomes a question
 * card, so the composer's Answer Mode and the request dock answer it like any agent question, with
 * its suggested options, Other and a free-text answer. The composer answers the session's first
 * request, so an Owner Question goes ahead of other cards that do not hold the session, never ahead
 * of one that does. A session without one is returned as it is.
 */
export function withPresentedOwnerQuestions<T extends Pick<SessionView, "pendingApproval">>(session: T): T {
  const requests = pendingRequests(session.pendingApproval);
  if (!requests.some((request) => isOwnerQuestionRequest(request))) return session;
  const presented = requests.map((request) => ({ request, shown: presentOwnerQuestionRequest(request) }));
  const question = (entry: { request: PendingApproval; shown: PendingApproval }) => entry.shown !== entry.request;
  const ordered = [
    ...presented.filter((entry) => !entry.request.async),
    ...presented.filter((entry) => entry.request.async && question(entry)),
    ...presented.filter((entry) => entry.request.async && !question(entry)),
  ].map((entry) => entry.shown);
  const [first, ...rest] = ordered;
  return { ...session, pendingApproval: { ...first!, ...(rest.length ? { additionalRequests: rest } : {}) } };
}
