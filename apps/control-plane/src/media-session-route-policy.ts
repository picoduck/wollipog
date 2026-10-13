const prefix = "/api/sessions/:id/video-evidence-review/";
const mediaReads = new Set(["frame", "frames", "acknowledge", "acknowledge-frames", "verdict"]);
/** Match canonical Fastify route patterns only. This is a narrowing of the actual persisted
 * media Session credential, not a new credential/grant, and never a caller-selected role. */
export function mediaReviewerApiRouteAllowed(method: string, routePath: string): boolean {
  return method === "GET" && routePath === "/api/compatibility" ||
    method === "POST" && routePath.startsWith(prefix) && mediaReads.has(routePath.slice(prefix.length));
}
/** Human/parent lifecycle stop and archival remain available for verification/cleanup.
 * Generic prompts, restarts, config, TUI/shell launches and conversation forks are prohibited. */
export function mediaSessionMutationAllowed(method: string, routePath: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method) || mediaReviewerApiRouteAllowed(method, routePath) ||
    method === "POST" && ["/api/sessions/:id/stop", "/api/sessions/:id/archive",
      "/api/sessions/:id/background-jobs/:jobId/stop"].includes(routePath);
}
