import type { SessionMeta } from "./session-store.js";

/** The provider coordinate that an explicit Restart preserves. Shared by launch and advertising. */
export function restartResumeId(meta: Pick<SessionMeta, "driver" | "agentSessionId">): string | undefined {
  return meta.agentSessionId &&
    (meta.driver === "claude-code" || meta.driver === "codex-app-server" || meta.driver === "pi")
    ? meta.agentSessionId : undefined;
}
