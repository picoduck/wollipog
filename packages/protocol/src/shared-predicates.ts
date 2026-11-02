import type { AgentDriverKind, ExecutionTargetRef } from "./index.js";

/** Return an absolute browser-safe external link, or null for untrusted schemes/invalid URLs. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Map a session driver to its managed account provider, when supported. */
export function providerForDriver(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

/** Whether a target can see skills and commands in the Machine's host home. */
export function targetHasHostHome(adapter: ExecutionTargetRef["adapter"] | undefined): boolean {
  return adapter !== "container" && adapter !== "cloud";
}
