import React from "react";
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

const noopRunnerAction = () => {};
const noopBoxAction = async () => {};

function Sample() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const scheme = SCHEMES.includes(params.get("scheme") ?? "") ? params.get("scheme")! : "wollipog";
  document.documentElement.setAttribute("data-theme", theme);
  // Density is a third axis, and the harness renders it so the spec can measure that Comfortable
  // actually IS roomier rather than merely declaring different tokens.
  const density = params.get("density") === "comfortable" ? "comfortable" : "compact";
  if (density === "compact") document.documentElement.removeAttribute("data-density");
  else document.documentElement.setAttribute("data-density", density);
  if (scheme === "wollipog") document.documentElement.removeAttribute("data-scheme");
  else document.documentElement.setAttribute("data-scheme", scheme);

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
          <div className="slash-palette">
            <div className="slash-command-list" role="listbox" aria-label="Slash Commands">
              <div className="slash-section" role="group" aria-label="Harness Commands">
                <div className="slash-section-label">Harness Commands</div>
                <button type="button" role="option" aria-selected className="slash-item active">
                  <span className="slash-item-main">
                    <span className="slash-name">/review</span>
                    <span className="slash-desc">Open the review panel for this session</span>
                  </span>
                  <span className="slash-src">Project</span>
                </button>
                <button type="button" role="option" aria-selected={false} className="slash-item">
                  <span className="slash-item-main">
                    <span className="slash-name">/compact</span>
                    <span className="slash-desc">Summarise the transcript so far</span>
                  </span>
                  <span className="slash-src">Built-In</span>
                </button>
              </div>
            </div>
            <div className="slash-detail">
              <div className="slash-detail-head">
                <span className="slash-detail-name">/review</span>
                <span className="slash-detail-source">Project</span>
              </div>
              <p className="slash-detail-description">Open the review panel for this session</p>
              <div className="slash-detail-argument">
                <span className="slash-detail-argument-label">Arguments</span>
                <code>[focus]</code>
              </div>
              <p className="slash-detail-disabled">This command is unavailable in this workspace.</p>
            </div>
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
            {["st-queued", "st-running", "st-input", "st-stopped", "st-done"].map((status) => (
              // Just the status class. There is no bare `.st` rule — `statusMeta` returns
              // `st-queued`, `st-running` and so on, and the harness had invented a wrapper class
              // that styled nothing.
              <span key={status} className={status}>{status.replace("st-", "")}</span>
            ))}
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
          <div className="sample-row">
            {THEME_OPTIONS.map((option) => (
              <span key={option.value} className="ui-seg-option">{option.label}</span>
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
          <div className="project-manager-items">
            <button type="button" className="project-manager-item"><span>A project row</span></button>
          </div>
          <div className="column">
            {/* `.card`, which is what Board actually renders — `.board-card` does not exist. */}
            <div className="card"><span>A board card</span></div>
          </div>
          {/* The five families round two found still bypassed. Rendered here so "application-wide"
              is a measurement rather than a claim about which rules I remembered to edit. */}
          <div className="agent-list"><div className="agent-row"><span>An agent row</span></div></div>
          <div className="review-findings-list"><div className="review-finding-row"><span /><span>A finding</span><span /></div></div>
          <div className="ext-session-list"><div className="ext-session"><span>An external session</span></div></div>
          <div className="browser-artifact-row"><span>An artifact</span></div>
          <div className="run-card"><span>A run card</span></div>
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
          <button type="button" className="files-entry"><span>A file entry</span></button>
          <table className="usage-table"><tbody><tr><td>A usage cell</td></tr></tbody></table>
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
      <Sample />
    </FeedbackProvider>
  </ApiProvider>,
);
