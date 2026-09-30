import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { CLOSE_WOULD_STOP_WORK, DesktopCloseGuard, type CloseGuardShell } from "../components/DesktopCloseGuard.js";
import { createCloseGuardLinks, type CloseGuardSession } from "../desktop-close-guard.js";
import "../styles.css";

/**
 * The desktop close confirmation (#1965, docs/design-system.md §7.4) in a real browser, with a fake
 * desktop runtime in place of the Tauri shell, because the webview itself cannot be screenshotted in CI.
 *
 * The shell holds a close and emits its event once the guard is listening. `?state=named` (the
 * default) sends two session ids the loaded local instance knows; `?state=more` adds one it does not,
 * counted in "and 1 more"; `?state=approval` sends an idle session with a pending approval beside a
 * running one (#2057); `?state=unknown` sends a count of 0, which is the shell saying it could not
 * check; `?state=count` sends the bare number an older shell sends. `?theme=light` switches theme.
 * Chosen by query string so every state is a clean reload; the page records what the guard did.
 */

const SESSIONS: Record<string, CloseGuardSession> = {
  s_rounding: { title: "Fix the half-cent rounding bug in invoice totals before the quarterly close", status: "running", pendingApproval: null },
  s_migration: { title: "Review the migration plan", status: "input_required", pendingApproval: null },
  s_release_notes: {
    title: "Tidy the release notes",
    status: "idle",
    pendingApproval: { requestId: "r_release_notes", title: "Run pnpm test", options: [{ optionId: "allow", name: "Allow" }] },
  },
};

const PAYLOADS: Record<string, unknown> = {
  named: { count: 2, sessionIds: ["s_rounding", "s_migration"] },
  more: { count: 3, sessionIds: ["s_rounding", "s_migration", "s_elsewhere"] },
  approval: { count: 2, sessionIds: ["s_release_notes", "s_rounding"] },
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
