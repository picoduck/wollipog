import React from "react";
import { StatusBadge } from "../components/StatusBadge.js";
import { CountBadge } from "../components/CountBadge.js";
import { InboxIcon } from "../components/Icons.js";
import { SlashCommandMenu } from "../components/SlashCommandMenu.js";
import { buildComposerCommandRegistry } from "../composer-commands.js";
import { PROTOCOL_VERSION, type BoxView, type RunnerView } from "@wollipog/protocol";
import { createRoot } from "react-dom/client";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { BoxCard, NativeRunnerCard } from "../components/RunnersView.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../navigation.js";
import { COLOR_SCHEMES, THEME_OPTIONS } from "../theme.js";
import "../styles.css";

/**
 * Text on its ACTUAL rendered ground, in every palette.
 *
 * The static checks answer "does this rule's colour clear this rule's fill". They cannot answer
 * "what is behind this text", because the ground is usually painted by an ancestor or by a more
 * specific rule on the same element — a fact about the cascade, not about a rule. Four static
 * approximations were tried on this branch and each attributed a ground to the wrong token: walking
 * selector prefixes misses a contextual rule on the same element; matching selectors by suffix
 * invents grounds; requiring every body ink to clear every tint in the app demands readability on
 * the danger button. The information genuinely is not in the text of one rule.
 *
 * A browser has the information. This page renders the markup whose grounds come from somewhere
 * else, the spec walks the composited ancestor chain, and the cascade does the resolving. What it
 * covers is what is on this page — that is the honest boundary, and it is why the markup here is
 * the real class names rather than a simplification.
 */

const SCHEMES = ["wollipog", ...COLOR_SCHEMES.map((s) => s.value).filter((v) => v !== "wollipog")];

// Establish every root-level cascade input before React creates descendants that consume the
// custom properties. Changing these during render let Chromium 153 briefly retain dark computed
// colours on parts of a light tree, depending on where React yielded during the commit.
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const scheme = SCHEMES.includes(params.get("scheme") ?? "") ? params.get("scheme")! : "wollipog";
document.documentElement.setAttribute("data-theme", theme);
const density = params.get("density") === "comfortable" ? "comfortable" : "compact";
if (density === "compact") document.documentElement.removeAttribute("data-density");
else document.documentElement.setAttribute("data-density", density);
if (scheme === "wollipog") document.documentElement.removeAttribute("data-scheme");
else document.documentElement.setAttribute("data-scheme", scheme);

// Regression-only timing control: keep the exact selectors implicated by the CI failure in a
// deliberately unfinished cascade after React's content becomes visible. The browser test owns
// the release event, so the pre-settlement assertion has no wall-clock race on a slow runner.
if (params.get("settle") === "manual") {
  document.documentElement.setAttribute("data-contrast-fixture-pending", "true");
  const pendingStyle = document.createElement("style");
  pendingStyle.textContent = `
    [data-contrast-fixture-pending] .picker-reason,
    [data-contrast-fixture-pending] .diff-sign {
      color: var(--bg-elev-1) !important;
    }
  `;
  document.head.append(pendingStyle);
  window.addEventListener("contrast-fixture-release", () => {
    pendingStyle.remove();
    document.documentElement.removeAttribute("data-contrast-fixture-pending");
  }, { once: true });
}

const nativeRunner: RunnerView = {
  runnerId: "fixture-native-runner",
  displayName: "Native Workstation",
  hostname: "native-workstation",
  os: "windows",
  version: "fixture",
  status: "online",
  agents: [],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
  agentsRefreshed: true,
};

const boxRunner: RunnerView = {
  ...nativeRunner,
  runnerId: "fixture-box-runner",
  displayName: "SSH Build Machine",
  hostname: "ssh-build-machine",
  os: "linux",
};

const box: BoxView = {
  boxId: "fixture-box",
  displayName: "SSH Build Machine",
  sshTarget: "builder@example.test",
  runnerId: boxRunner.runnerId,
  status: "online",
  lastError: null,
  createdAt: 1,
  deployedVersion: "fixture",
  triple: "x86_64-unknown-linux-gnu",
};

const PICKER_COMMANDS = buildComposerCommandRegistry({
  context: { planSupported: true, canStopTurn: false, agentLabel: "Claude Code" },
  providerCommands: [
    { id: "project:review", name: "review", providerSource: "project", description: "Open the review panel for this session", argumentHint: "[focus]" },
    { id: "builtin:compact", name: "compact", providerSource: "builtin", description: "Summarise the transcript so far" },
  ],
}).filter((command) => command.source === "provider" || command.name === "stop");

const noopRunnerAction = () => {};
const noopBoxAction = async () => {};

const contrastSelectors = [
  ".picker-reason",
  ".diff-line-add .diff-sign",
  ".diff-line-del .diff-sign",
  ".status.t-info",
  ".status.t-warning",
  ".status.t-success",
  ".btn.danger",
  ".count-badge",
  ".count-badge.danger",
];

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function contrastStyleSnapshot() {
  return contrastSelectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing contrast fixture selector: ${selector}`);
    const style = getComputedStyle(element);
    return [selector, style.color, style.backgroundColor, style.backgroundImage, style.opacity];
  });
}

async function markContrastFixtureReady() {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
  }
  await document.fonts.ready;

  const rootStyle = getComputedStyle(document.documentElement);
  for (const token of ["--bg", "--text", "--amber-on-tint", "--green-on-tint", "--red-on-tint"]) {
    if (!rootStyle.getPropertyValue(token).trim()) throw new Error(`Missing contrast token: ${token}`);
  }

  // The delayed state exists only for the regression test, where it deterministically recreates
  // the CI ordering: React content is visible while the final cascade is not yet safe to sample.
  while (document.documentElement.hasAttribute("data-contrast-fixture-pending")) await nextFrame();

  let previous = JSON.stringify(contrastStyleSnapshot());
  for (;;) {
    await nextFrame();
    const current = JSON.stringify(contrastStyleSnapshot());
    const animationsRunning = document.getAnimations()
      .some((animation) => animation.playState === "running" || animation.pending);
    if (current === previous && !animationsRunning) break;
    previous = current;
  }

  document.documentElement.setAttribute("data-contrast-fixture-ready", `${scheme}/${theme}`);
}

function ContrastFixtureReady() {
  React.useEffect(() => {
    void markContrastFixtureReady().catch((error: unknown) => {
      document.documentElement.setAttribute(
        "data-contrast-fixture-error",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, []);
  return null;
}

function Sample() {
  return (
    <div className="app">
      <main className="main">
        <div className="main-body">
          {/* The two pairings round two found failing, in their production markup: a container
              carries a tint and the text inside it declares only a colour. */}
          {/* PRODUCTION class names, checked against the components rather than remembered.
              The first version of this file invented `.slash-source` and `.d-row`/`.d-gutter`, so
              the two pairings it was built to measure were not styled at all — it measured
              inherited colours on unstyled markup and reported ten green palettes. That is the
              fixture-divergence failure this campaign has already paid for twice. */}
          {/* The real component, so the measured markup is the markup the composer renders: an
              active row and a disabled row whose reason is a visible second line. Positioned in
              flow, since the picker anchors above whatever contains it. */}
          <div style={{ position: "relative", marginTop: 220 }}>
            <SlashCommandMenu
              listboxId="contrast-slash"
              query="/"
              commands={PICKER_COMMANDS}
              activeCommandId="provider:project:review"
              onActiveCommandChange={() => {}}
              onSelectCommand={() => {}}
            />
          </div>

          <div className="diff-view">
            <div className="diff-line diff-line-add">
              <span className="diff-line-select" />
              <span className="diff-gutter diff-gutter-old">41</span>
              <span className="diff-gutter diff-gutter-new">42</span>
              <span className="diff-sign">+</span>
              <span className="diff-text">const added = true; <span className="diff-syntax-comment">// added</span></span>
            </div>
            <div className="diff-line diff-line-del">
              <span className="diff-line-select" />
              <span className="diff-gutter diff-gutter-old">41</span>
              <span className="diff-gutter diff-gutter-new" />
              <span className="diff-sign">-</span>
              <span className="diff-text">const removed = false; <span className="diff-syntax-comment">// removed</span></span>
            </div>
            <div className="diff-line diff-line-ctx">
              <span className="diff-line-select" />
              <span className="diff-gutter diff-gutter-old">42</span>
              <span className="diff-gutter diff-gutter-new">43</span>
              <span className="diff-sign" />
              <span className="diff-text">const same = 1;</span>
            </div>
          </div>

          {/* Status pills, badges and the button states — every tinted fill the app paints text on. */}
          <div className="sample-row">
            {(["neutral", "info", "warning", "success", "danger"] as const).map((tone) => (
              // The one status recipe in each tone, as `StatusBadge` renders it.
              <StatusBadge key={tone} tone={tone} label={tone} />
            ))}
          </div>
          {/* Count badges (§11.4) in both tones, beside a label and on a 20px icon, as `CountBadge`
              renders them. The icon's wrapper is the positioned box an owner provides. */}
          <div className="sample-row">
            <span data-testid="count-badge-inline">Blocked <CountBadge count={3} /></span>
            <span data-testid="count-badge-inline-danger">Stalled <CountBadge count={12} tone="danger" /></span>
            <span data-testid="count-badge-icon" style={{ position: "relative", display: "inline-flex" }}>
              <InboxIcon size={20} />
              <CountBadge count={1} onIcon />
            </span>
            <span data-testid="count-badge-icon-danger" style={{ position: "relative", display: "inline-flex" }}>
              <InboxIcon size={20} />
              <CountBadge count={128} tone="danger" onIcon />
            </span>
          </div>
          <div className="sample-row">
            <button type="button" className="btn primary">Primary</button>
            <button type="button" className="btn danger">Danger</button>
            <button type="button" className="btn">Ordinary</button>
          </div>
          <div className="sample-row">
            {SETTINGS_SECTIONS.map((section: { id: SettingsSection; title: string }) => (
              <a key={section.id} className="settings-section-link" href={`/settings/${section.id}`}>{section.title}</a>
            ))}
          </div>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((option, index) => (
              <span key={option.value} role="radio" aria-checked={index === 0} className="seg-option">{option.label}</span>
            ))}
          </div>
          {/* The two rhythm carriers the density tokens drive. */}
          <div className="settings-options">
            <button type="button" className="ui-row ui-row-nav"><span className="ui-row-body"><span className="ui-row-title">A settings row</span></span></button>
            <button type="button" className="ui-row ui-row-nav"><span className="ui-row-body"><span className="ui-row-title">Another settings row</span></span></button>
          </div>
          <div className="inbox-list">
            <div className="inbox-row-shell"><div className="inbox-row-primary-cell"><button type="button" className="inbox-row"><span>An inbox row</span></button></div></div>
          </div>
          {/* The other row families the density axis reaches. Review found the first version
              stopped at the settings row and the inbox row, so the setting looked broken on Board,
              Projects and Review rather than opted out. */}
          {/* The §5.2 rows, whose height comes from the row tokens rather than their padding. */}
          <div className="surface">
            <button type="button" className="row row-2"><span className="row-body"><span className="row-title">A project row</span><span className="row-sub">~/project</span></span><span className="row-trail">a-very-long-workspace-name-that-would-otherwise-take-the-whole-row · Created 3h ago</span></button>
            <button type="button" className="row"><span className="row-title">A one-line row</span></button>
            <button type="button" className="row dense"><span className="row-title">A file entry</span></button>
          </div>
          <div className="column">
            {/* `.card`, which is what Board actually renders — `.board-card` does not exist. */}
            <article className="card"><span className="card-title">A board card</span><span className="card-preview">A one-line preview</span></article>
          </div>
          {/* The five families round two found still bypassed. Rendered here so "application-wide"
              is a measurement rather than a claim about which rules I remembered to edit. */}
          <div className="agent-list"><div className="agent-row"><span>An agent row</span></div></div>
          {/* Status chips whose fill comes from the base class and whose ink comes from a modifier
              (#1892), so no single rule states the pair. The runner card below renders its agent
              chips inside a collapsed `<details>`, where nothing is measured. */}
          <div className="agent-row-meta">
            <span className="atag discovered">Discovered</span>
            <span className="atag broken">Not Signed In</span>
          </div>
          <div className="review-findings-list"><div className="review-finding-row"><span /><span>A finding</span><span /></div></div>
          <div className="ext-session-list"><div className="ext-session"><span>An external session</span></div></div>
          {/* Real production runner cards. Their headings caused #237, and copied markup would
              allow the fixture to stay green while the components regress again. */}
          <div className="runner-grid">
            <BoxCard
              box={box}
              runner={boxRunner}
              canManage={false}
              onReconnect={noopBoxAction}
              onRemove={noopBoxAction}
            />
            <NativeRunnerCard
              runner={nativeRunner}
              canManage={false}
              busy={false}
              onRediscover={noopRunnerAction}
              onManage={noopRunnerAction}
              onRepair={noopRunnerAction}
            />
          </div>
          <ul className="workspace-list"><li><span>A workspace row</span></li></ul>
          <div className="table-wrap"><table className="table"><tbody><tr><td>A usage cell</td></tr></tbody></table></div>
          <div className="files-source-line">
            <span>a line with a <mark>highlighted</mark> search hit</span>
          </div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider>
    <FeedbackProvider>
      <ContrastFixtureReady />
      <Sample />
    </FeedbackProvider>
  </ApiProvider>,
);
