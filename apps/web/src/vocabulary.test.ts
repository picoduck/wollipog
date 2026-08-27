import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * docs/concepts-and-glossary.md fixes the domain vocabulary:
 *
 *   Machine   — the user-facing development host, represented in Wollipog by a Runner.
 *   Runner    — the service installed on that Machine. Implementation, not product surface.
 *   Workspace — a directory advertised by a Runner. Infrastructure.
 *   Location  — one exact (Machine, Workspace) pair, which is what a Project links to.
 *
 * The UI had drifted: the same object was called Machine on the Board, Runner in every creation
 * dialog, "box" in a tooltip, and Connections in the rail. These tests pin the places a user
 * *chooses* a host, which is where the wrong noun is most confusing.
 *
 * Deliberately narrow. "Runner" is legitimate elsewhere — the glossary keeps hostname, runner
 * version, and connection identifiers visible as diagnostic metadata on the Connections screen —
 * so a blanket ban would be wrong and would fail on correct code.
 */
const HOST_PICKERS: ReadonlyArray<[string, string]> = [
  ["./components/NewSessionDialog.tsx", "New Session"],
  ["./components/NewRunDialog.tsx", "New Multi-Agent Run"],
  ["./components/AutomationsView.tsx", "Automations"],
];

test("host pickers name the Machine, not the Runner that represents it", () => {
  for (const [path, screen] of HOST_PICKERS) {
    const source = read(path);
    assert.doesNotMatch(source, /<span>Runner<\/span>/,
      `${screen}: a field where the user picks a host must be labelled Machine`);
    assert.doesNotMatch(source, /<label>Runner</,
      `${screen}: a field where the user picks a host must be labelled Machine`);
    assert.match(source, /<span>Machine<\/span>|<label>Machine</,
      `${screen} should offer a Machine field`);
  }
});

test("New Session migration copy names the target and its App Server capabilities", () => {
  const source = read("./components/NewSessionDialog.tsx");
  assert.match(source, /Codex App Server supports interactive approvals and resumable conversations\./);
  assert.match(source, /Use \{suggestedAgentOption\.label\}/);
  assert.doesNotMatch(source, /Interactive \(Recommended\)|Use Recommended|Codex App Server is recommended/);
});

test("the example runner config uses the canonical Codex App Server name", () => {
  const config = JSON.parse(read("../../../runner.config.example.json")) as {
    agents?: Array<{ id?: string; name?: string; driver?: string }>;
  };
  const appServer = config.agents?.find((agent) => agent.driver === "codex-app-server");
  assert.ok(appServer, "the example should include a Codex App Server agent");
  assert.equal(appServer.id, "codex-app");
  assert.equal(appServer.name, "Codex App Server");
});

test("no user-facing string calls a Machine a box", () => {
  // "box" is the SSH-bootstrap implementation term. It appears throughout the protocol and the
  // control plane, which is correct; it must not reach a label, tooltip, or sentence a user reads.
  for (const path of [
    "./components/RunnersView.tsx",
    "./components/AddBoxDialog.tsx",
    "./components/InstancesPanel.tsx",
  ]) {
    const source = read(path);
    for (const match of source.matchAll(/(?:title|aria-label|placeholder)="([^"]*)"/g)) {
      assert.doesNotMatch(match[1]!, /\bbox(es)?\b/i,
        `${path}: user-visible text must say Machine, not "${match[1]}"`);
    }
  }
});

/**
 * CLAUDE.md: labels are Title Case; hint text, tooltips, and prose stay in sentence case.
 *
 * Asserted as exact expected strings rather than by heuristic. The previous version allowed "at
 * most one capitalised word after discarding acronyms and punctuation", which failed in both
 * directions: reverting to "PR Title" passed (PR is an acronym, "(Optional)" was discarded), while
 * legitimate copy like "Search Wollipog sessions" would have failed CI.
 */
const EXPECTED_PLACEHOLDERS: ReadonlyArray<[string, string]> = [
  ["./components/InboxView.tsx", "Search sessions"],
  ["./components/ProjectsView.tsx", "Search projects"],
  ["./components/ReviewPanel.tsx", "PR title"],
  ["./components/ReviewPanel.tsx", "PR description (optional)"],
];

test("known placeholders read as hint text, not labels", () => {
  for (const [path, expected] of EXPECTED_PLACEHOLDERS) {
    const source = read(path);
    assert.ok(source.includes(`placeholder="${expected}"`),
      `${path} should carry the placeholder "${expected}"`);
  }
});

/**
 * Tooltips are explicitly listed under sentence case in CLAUDE.md. An earlier revision of this PR
 * Title-Cased them, which was a straight misreading of the rule.
 */
const EXPECTED_TOOLTIPS: ReadonlyArray<[string, string]> = [
  ["./components/GitDiffViewer.tsx", "Add inline review finding"],
  ["./components/RunnersView.tsx", "Reconnect this machine"],
  ["./components/ShellDock.tsx", "Close shell"],
];

test("tooltips stay in sentence case", () => {
  for (const [path, expected] of EXPECTED_TOOLTIPS) {
    assert.ok(read(path).includes(`title="${expected}"`),
      `${path} should carry the tooltip "${expected}"`);
  }
});

test("signed-trigger instructions publish only the Wollipog wire generation", () => {
  const source = read("./components/AutomationsView.tsx");
  assert.match(source, /application\/vnd\.wollipog\.automation-trigger\+json/);
  for (const header of ["X-Wollipog-Timestamp", "X-Wollipog-Nonce", "X-Wollipog-Signature"]) {
    assert.ok(source.includes(header), `Automations should publish ${header}`);
  }
  assert.doesNotMatch(source, /X-MAM-|application\/vnd\.mam\.automation-trigger\+json/);
});

/**
 * A field labelled Machine has to SHOW the Machine. These selectors previously rendered runner ids
 * and hostnames, so renaming a Machine had no effect on them — the label asserted something the
 * control did not do.
 *
 * They render machineOptionLabels() rather than runnerDisplay(...).name directly: Machine names are
 * user-owned and not unique, so rendering the bare name turned two Machines both called "Build
 * Machine" into identical options, and picking the wrong one launches work against the wrong host.
 */
test("machine selectors render disambiguated Machine labels", () => {
  for (const path of [
    "./components/NewSessionDialog.tsx",
    "./components/NewRunDialog.tsx",
    "./components/AutomationsView.tsx",
    // Both of these rendered a bare runnerDisplay().name. The Board filter silently hides the
    // sessions you wanted; the Location dialog creates the (Machine, Workspace) pair against the
    // wrong host, which is the costlier of the two.
    "./components/Board.tsx",
    "./components/ProjectLocationDialog.tsx",
  ]) {
    const source = read(path);
    assert.match(source, /machineOptionLabels\(/,
      `${path}: a Machine selector must derive labels through machineOptionLabels`);
    assert.match(source, /machineLabels\.get\(/,
      `${path}: options must render the derived label, not a raw connection id`);
    // The Box supplies an unnamed SSH Machine's fallback identity, so dropping the lookup renders
    // "box-7f3a9c21" where the user expects "build-linux".
    // Anchored on the callback INSIDE the argument list. Matching `boxByRunner` anywhere within
    // 200 characters passed even with the argument removed, because the useMemo dependency array
    // that follows the call still names it.
    assert.match(source, /machineOptionLabels\([\s\S]{0,140}?=>\s*boxByRunner\.get\(/,
      `${path}: label derivation must pass the Box lookup through`);
    assert.doesNotMatch(source, /<option[^>]*>\{[^}]*\.hostname\}/,
      `${path}: a Machine option must not render a bare hostname`);
  }
});
