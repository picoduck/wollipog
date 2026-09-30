import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { CLOSE_WOULD_STOP_WORK, DesktopCloseGuard, type CloseGuardShell } from "../components/DesktopCloseGuard.js";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { createCloseGuardLinks, type CloseGuardSession } from "../desktop-close-guard.js";
import "../styles.css";

/**
 * The desktop close confirmation (#1965, docs/design-system.md §7.4) in a real browser, with a fake
 * desktop runtime in place of the Tauri shell, because the webview itself cannot be screenshotted in CI.
 *
 * The shell holds a close and emits its event once the guard is listening. `?state=named` (the
 * default) sends two session ids the loaded local instance knows; `?state=more` adds one it does not,
 * counted in "and 1 more"; `?state=approval` sends an idle session with a pending approval beside a
 * running one (#2057); `?state=ownership` sends sessions listed for requests only the Orchestrator
 * owns, one settled and one in flight, beside a campaign with requests the person owns, an ordinary
 * approval and a child agent's approval the person must answer (#2100); `?state=unknown` sends a count of 0, which is the shell saying it could not
 * check; `?state=count` sends the bare number an older shell sends. `?theme=light` switches theme.
 * Chosen by query string so every state is a clean reload; the page records what the guard did.
 */

const approval = (requestId: string, extra: Partial<PendingApproval> = {}): PendingApproval =>
  ({ requestId, title: "Run pnpm test", options: [{ optionId: "allow", name: "Allow" }], ...extra });

const ownedBy = (requestId: string, owner: "human" | "orchestrator"): CloseGuardSession["pendingRequestOwners"] => ({
  human: owner === "human" ? 1 : 0,
  orchestrator: owner === "orchestrator" ? 1 : 0,
  requests: [{ requestId, owner }],
});

const SESSIONS: Record<string, CloseGuardSession> = {
  s_rounding: { title: "Fix the half-cent rounding bug in invoice totals before the quarterly close", status: "running", pendingApproval: null },
  s_migration: { title: "Review the migration plan", status: "input_required", pendingApproval: null },
  s_release_notes: { title: "Tidy the release notes", status: "idle", pendingApproval: approval("r_release_notes") },
  s_merge_cache: {
    title: "Merge the cache fix",
    status: "idle",
    pendingApproval: approval("r_merge_cache"),
    pendingRequestOwners: ownedBy("r_merge_cache", "orchestrator"),
  },
  s_rollout: {
    title: "Draft the rollout checklist",
    status: "running",
    pendingApproval: approval("r_rollout"),
    pendingRequestOwners: ownedBy("r_rollout", "orchestrator"),
  },
  s_notices: {
    title: "Ship the notices epic",
    status: "running",
    pendingApproval: null,
    orchestratorCampaign: { pendingRequests: { human: 2, orchestrator: 1 } } as SessionView["orchestratorCampaign"],
  },
  s_lockfile: {
    title: "Audit the lockfile",
    status: "running",
    pendingApproval: approval("r_lockfile", { ownerToolUseId: "toolu_lockfile" }),
    pendingRequestOwners: ownedBy("r_lockfile", "human"),
  },
};

const PAYLOADS: Record<string, unknown> = {
  named: { count: 2, sessionIds: ["s_rounding", "s_migration"] },
  more: { count: 3, sessionIds: ["s_rounding", "s_migration", "s_elsewhere"] },
  approval: { count: 2, sessionIds: ["s_release_notes", "s_rounding"] },
  ownership: { count: 5, sessionIds: ["s_merge_cache", "s_rollout", "s_notices", "s_release_notes", "s_lockfile"] },
  unknown: { count: 0, sessionIds: [] },
  count: 2,
};

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const payload = PAYLOADS[params.get("state") ?? "named"] ?? PAYLOADS.named;
  const [quits, setQuits] = useState(0);
  const [shown, setShown] = useState(0);
  const [shell] = useState<CloseGuardShell>(() => ({
    isTauri: () => true,
    listen: async (event, handler) => {
      // The shell emits when it holds a close, which here is as soon as the guard is listening.
      if (event === CLOSE_WOULD_STOP_WORK) queueMicrotask(() => handler(payload));
      return () => undefined;
    },
    quit: async () => { setQuits((count) => count + 1); },
  }));
  const [links] = useState(() => {
    const registry = createCloseGuardLinks();
    registry.provide({
      session: (id) => SESSIONS[id] ?? null,
      showSessions: () => setShown((count) => count + 1),
    });
    return registry;
  });
  return (
    <FeedbackProvider>
      <DesktopCloseGuard desktop={shell} links={links} />
      {/* Read by the spec, kept out of the captured page. */}
      <div className="sr-only">
        <output data-testid="quits">{quits}</output>
        <output data-testid="shown">{shown}</output>
      </div>
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
