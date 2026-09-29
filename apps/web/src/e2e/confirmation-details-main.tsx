import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "../api.js";
import { FeedbackProvider, useFeedback } from "../components/FeedbackProvider.js";
import { lifecycleConflictPresentation } from "../components/RunnersView.js";
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
 * action. `?theme=light` switches theme. Chosen by query string so every state is a clean reload;
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
  return (
    <FeedbackProvider>
      <Confirm surface={params.get("surface") ?? "update"} />
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
