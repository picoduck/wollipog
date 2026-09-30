import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunnerView, SessionView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider, useFeedback } from "../components/FeedbackProvider.js";
import { ProjectSplitMenu } from "../components/ProjectSplitMenu.js";
import { lifecycleConflictPresentation } from "../components/RunnersView.js";
import type { InboxSplit } from "../inbox.js";
import { statusMeta } from "../status-meta.js";
import "../styles.css";

/**
 * Confirmation detail rows, cancel labels and secondary actions (#1950, docs/design-system.md §7.4)
 * in a real browser, where row height, truncation and footer widths are layout.
 *
 * `?surface=update` (the default) opens "Interrupt Sessions and Update" exactly as the machine card
 * builds it from the server's conflict: nine interrupted sessions, seven of them listed. Five rows
 * show and "and 4 more" counts the rest. `?surface=adopt` opens the same conflict under the longest
 * confirm label the product has, "Interrupt Sessions and Adopt Legacy Data" (#2050).
 * `?surface=secondary` opens a confirmation that names its safe choice and offers a harmless extra
 * action. `?surface=project-archive` renders a Command Inbox project split's actions menu over seven
 * sessions; the spec opens "Archive and Stop Sessions" from it (#2051), or "Archive Sessions" with
 * `&variant=archive`. `?theme=light` switches theme. Chosen by query string so every state is a clean reload;
 * the page records what the confirmation resolved to.
 */

const activeSessions = new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", {
  activeSessionCount: 9,
  activeSessions: [
    { title: "Fix the half-cent rounding bug in invoice totals before the quarterly close", status: "running" },
    { title: "Review the migration plan", status: "input_required" },
    { title: "Draft release notes for 0.30", status: "idle" },
    { title: "Investigate flaky snooze typeahead test", status: "running" },
    { title: "Refactor the runner update path", status: "starting" },
    { title: "Upgrade the Playwright browsers", status: "idle" },
    { title: "Audit stylesheet debt", status: "queued" },
  ],
});

const RUNNING_TITLES = [
  "Fix the half-cent rounding bug in invoice totals before the quarterly close",
  "Investigate flaky snooze typeahead test",
];

const PROJECT_SESSIONS: Array<[string, Partial<SessionView>]> = [
  ["Fix the half-cent rounding bug in invoice totals before the quarterly close", { status: "running" }],
  ["Review the migration plan", { status: "input_required" }],
  ["Draft release notes for 0.30", { status: "idle" }],
  ["Approve the schema change", {
    status: "input_required",
    pendingApproval: { requestId: "request-1", title: "Run Bash", options: [] },
  }],
  ["Investigate flaky snooze typeahead test", { status: "running" }],
  ["Upgrade the Playwright browsers", { status: "queued" }],
  ["Audit stylesheet debt", { status: "idle" }],
];

const projectSplit: InboxSplit = {
  key: '["runner-1","workspace-1"]',
  kind: "project",
  name: "Invoicing",
  project: { kind: "legacy", runnerId: "runner-1", workspaceId: "workspace-1" },
  sessions: PROJECT_SESSIONS.map(([title, overrides], index) => ({
    id: `session-${index + 1}`,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Invoicing",
    title,
    status: "idle",
    archived: false,
    updatedAt: 1,
    lastEventAt: 1,
    pendingApproval: null,
    ...overrides,
  }) as SessionView),
  count: PROJECT_SESSIONS.length,
  blockedCount: 0,
  stalledCount: 0,
};

const projectRunner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner",
  os: "linux",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [{ id: "workspace-1", name: "Invoicing", path: "/repos/invoicing" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 999,
};

function Confirm({ surface }: { surface: string }) {
  const { confirm } = useFeedback();
  const [outcome, setOutcome] = useState("pending");
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const request = (() => {
      if (surface === "secondary") {
        return confirm({
          title: "Quit Wollipog",
          message: "Quitting stops the 2 sessions running on this computer. You can resume them when Wollipog opens again.",
          // Session titles are the user's own text, so the rows take them as data.
          detailRows: RUNNING_TITLES.map((label) => ({ label, status: statusMeta("session", "running") })),
          confirmLabel: "Quit Wollipog",
          cancelLabel: "Keep Open",
          secondaryAction: { label: "Show Sessions", run: () => setShown((count) => count + 1) },
          tone: "danger",
        });
      }
      if (surface === "adopt") {
        const conflict = lifecycleConflictPresentation(activeSessions, "adopt");
        return confirm({
          title: "Interrupt Sessions and Adopt Legacy Data",
          message: conflict.message,
          detailRows: conflict.detailRows,
          detailRowsOverflow: conflict.detailRowsOverflow,
          confirmLabel: "Interrupt Sessions and Adopt Legacy Data",
          tone: "danger",
        });
      }
      const conflict = lifecycleConflictPresentation(activeSessions, "update");
      return confirm({
        title: "Interrupt Sessions and Update",
        message: conflict.message,
        detailRows: conflict.detailRows,
        detailRowsOverflow: conflict.detailRowsOverflow,
        confirmLabel: "Interrupt Sessions and Update",
        tone: "danger",
      });
    })();
    void request.then((value) => setOutcome(String(value)));
  }, [confirm, surface]);
  // Read by the spec, kept out of the captured page.
  return (
    <div className="sr-only">
      <output data-testid="outcome">{outcome}</output>
      <output data-testid="shown">{shown}</output>
    </div>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const surface = params.get("surface") ?? "update";
  if (surface === "project-archive") {
    // Without Stop-before-archive support the same split offers plain "Archive Sessions". The tab
    // group reveals the trigger on hover, as in the Command Inbox tab strip.
    return (
      <ApiProvider>
        <FeedbackProvider>
          <div className="inbox-tab-group">
            <span>Invoicing</span>
            <ProjectSplitMenu split={projectSplit} runner={projectRunner}
              stopBeforeArchiveSupported={params.get("variant") !== "archive"}
              pinned={false} onPinnedChange={() => undefined} onNewSession={() => undefined} />
          </div>
        </FeedbackProvider>
      </ApiProvider>
    );
  }
  return (
    <FeedbackProvider>
      <Confirm surface={surface} />
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
