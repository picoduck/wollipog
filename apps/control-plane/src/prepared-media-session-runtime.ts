import type { CreateSessionRequest } from "@wollipog/protocol";
import type { EvidenceReviewerTarget, ReviewerAdmissionContext, VideoProfileLiveProof } from "./evidence-review-worker.js";
import type { PreparedMediaIdentity } from "./prepared-media-sessions.js";

/** Server-owned resolver. No public JSON, native code-job or agent message supplies configuration,
 * human authority, live proof, namespace claims or a fake Session. Runtime registration remains
 * absent until actual scope/budget integration and inspected live proof support the profile. */
export interface PreparedMediaSessionRuntime {
  resolve(identity: PreparedMediaIdentity, subject: PreparedMediaSubject): {
    request: CreateSessionRequest;
    context: ReviewerAdmissionContext;
    target: EvidenceReviewerTarget;
    liveProof: VideoProfileLiveProof | null;
    /** Private server lookup of a durable Human-only validation permit. Not request JSON. */
    operatorValidation?: { permitId: string };
  } | null;
}
export interface PreparedMediaSubject { occurrenceId: string; evidenceId: string }

export const MEDIA_SESSION_PURPOSE_ERROR =
  "This media review Session can run only its original admitted review command.";
