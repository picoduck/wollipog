import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * #1949: a ratchet on buttons that swap their label for a progress word.
 *
 * `busy ? "Installing…" : "Install and Restart"` makes the button change width as the word changes,
 * so its neighbours shift, and it stops naming the action that is running. docs/design-system.md
 * §3.1 keeps the label and shows a spinner instead; `BusyButton` (components/ui/BusyButton.tsx) is
 * that treatment. The sites below predate it. Each area epic removes its own as it rebuilds the
 * screen, rather than one change rewriting screens that are about to be rewritten again.
 *
 * The unit is an OCCURRENCE per file, compared exactly, as in choice-adoption.test.ts: a new site
 * fails, and removing one fails until its number here comes down in the same change, so the count
 * only goes down and every change to it is in the diff.
 *
 * WHAT THIS RECOGNISES. A ternary branch that is a quoted Title Case phrase whose first word ends in
 * "ing" and which ends in an ellipsis: `? "Saving…"`, `? "Signing In…"`, `? 'Loading More…'`.
 * Sentence-case prose (`? "Loading saved instances…"`) is a status line, not a button label, and is
 * not counted. It reads text rather than a syntax tree, so a label built another way (JSX text after
 * a spinner, a helper that returns the word) is invisible to it; the count is a floor, not a census.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

const MINOR_WORD = "a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with";
/** `(?<!\?)` so a `??` fallback is not a ternary branch. */
export const LABEL_SWAP = new RegExp(
  `(?<!\\?)\\?\\s*(["'\`])[A-Z][A-Za-z-]*ing(?:\\s+(?:[A-Z][A-Za-z-]*|${MINOR_WORD}))*(?:…|\\.\\.\\.)\\1`,
  "g",
);

/** The inventory, exact: production file → label-swapping sites it still has. */
const BASELINE: Readonly<Record<string, number>> = {
  "App.tsx": 2,
  "components/AccessScopeControls.tsx": 1,
  "components/AddBoxDialog.tsx": 1,
  "components/AgentSessionDiscoveryDialog.tsx": 3,
  "components/AgentsPanel.tsx": 1,
  "components/ArtifactPreview.tsx": 1,
  "components/AuthenticationRecoveryPanel.tsx": 2,
  "components/AutomationsView.tsx": 2,
  "components/BackgroundWorkPanel.tsx": 2,
  "components/Board.tsx": 1,
  "components/BrowserPanel.tsx": 1,
  "components/ConversationHandoffDialog.tsx": 1,
  "components/CreateProjectDialog.tsx": 1,
  "components/FilesPanel.tsx": 3,
  "components/GitDiffViewer.tsx": 1,
  "components/GovernanceHistoryPanel.tsx": 1,
  "components/InstancesPanel.tsx": 1,
  "components/NewPodDialog.tsx": 1,
  "components/NewRunDialog.tsx": 1,
  "components/NewSessionDialog.tsx": 1,
  "components/OfflineBanner.tsx": 1,
  "components/OnboardRunnerDialog.tsx": 3,
  "components/OrchestratorSettingsPanel.tsx": 1,
  "components/OutboundEventSubscriptions.tsx": 1,
  "components/PendingPromptBubbles.tsx": 3,
  "components/PeopleDevicesPanel.tsx": 4,
  "components/PodsView.tsx": 9,
  "components/ProjectChildDefaults.tsx": 1,
  "components/ProjectLocationDialog.tsx": 2,
  "components/ProjectSplitMenu.tsx": 1,
  "components/ProjectsView.tsx": 5,
  "components/ProviderAccountsSection.tsx": 2,
  "components/ProviderLoginCard.tsx": 1,
  "components/RenameSessionDialog.tsx": 1,
  "components/ReviewPanel.tsx": 4,
  "components/RunnersView.tsx": 11,
  "components/RunsView.tsx": 2,
  "components/SaveBar.tsx": 1,
  "components/SessionApproval.tsx": 4,
  "components/SessionDetail.tsx": 9,
  "components/SettingsView.tsx": 6,
  "components/ShellDock.tsx": 1,
  "components/SideChatPanel.tsx": 3,
  "components/SkillAssignmentDialog.tsx": 1,
  "components/SkillAssignmentMatrix.tsx": 1,
  "components/SkillGitImportDialog.tsx": 2,
  "components/SkillMachineImportDialog.tsx": 1,
  "components/SkillOrphanedCopies.tsx": 1,
  "components/SkillsView.tsx": 2,
  "components/SnoozeDialog.tsx": 1,
  "components/SwitchAccountDialog.tsx": 1,
  "components/UsageView.tsx": 4,
  "components/WorktreeRecoveryCard.tsx": 3,
  "components/WorktreeSetupNotice.tsx": 1,
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // `src/e2e` is Playwright harness markup, reachable only from a harness page.
    if (entry === "e2e" && statSync(path).isDirectory()) continue;
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

/** Comments removed, since an explanation that quotes a forbidden label is not a label. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*/g, "$1");
}

export function countLabelSwaps(source: string): number {
  return (withoutComments(source).match(LABEL_SWAP) ?? []).length;
}

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const path of sourceFiles(SRC)) {
    const count = countLabelSwaps(readFileSync(path, "utf8"));
    if (count) found.set(path.slice(SRC.length).replace(/\\/g, "/"), count);
  }
  return found;
}

test("the label-swapping sites match the inventory exactly", () => {
  const found = scan();
  const expected = new Map(Object.entries(BASELINE));

  const unexpected = [...found].filter(([file]) => !expected.has(file)).map(([file, count]) => `${file} × ${count}`);
  const grown = [...expected]
    .filter(([file, count]) => (found.get(file) ?? 0) > count)
    .map(([file, count]) => `${file}: ${found.get(file)} now, ${count} recorded`);
  assert.deepEqual([...unexpected, ...grown], [],
    "a button swaps its label for a progress word; keep the label and use BusyButton (docs/design-system.md §3.1)");

  const stale = [...expected]
    .filter(([file, count]) => (found.get(file) ?? 0) < count)
    .map(([file, count]) => `${file}: ${found.get(file) ?? 0} now, ${count} recorded`);
  assert.deepEqual(stale, [], "a site was removed without lowering its number here; lower it in the same change");
});

test("the scanner sees label swaps and nothing else", () => {
  const counted = [
    'busy ? "Saving…" : "Save"',
    "busy ? 'Installing...' : 'Install'",
    'pending ? "Signing In…" : "Sign In"',
    'loading ? "Loading More Workers…" : "Load More Workers"',
    'setupRetryPending ? "Retrying Setup…" : "Retry Setup"',
    'busy ? "Checking for Missed Activity…" : ""',
  ];
  for (const source of counted) assert.equal(countLabelSwaps(source), 1, source);

  const ignored = [
    'progress ?? "Working…"',
    'phase === "loading" ? "Loading saved Wollipog instances…" : detail',
    'busy ? "Save" : "Saved"',
    '// busy ? "Saving…" : "Save"',
    '/* busy ? "Saving…" : "Save" */',
    'label: "Retrying…"',
  ];
  for (const source of ignored) assert.equal(countLabelSwaps(source), 0, source);
});
