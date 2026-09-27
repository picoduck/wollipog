import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalReadinessIcon, OnboardingHealthChecklist } from "./OnboardRunnerDialog.js";

// light-theme.test.ts holds these marks to the 3:1 glyph bar because each renders one hidden glyph
// and nothing else, while the status itself is stated in text beside it.
test("onboarding status marks render only a hidden glyph beside a text status", () => {
  for (const [status, glyph] of [["pass", "✓"], ["warning", "△"], ["fail", "!"]] as const) {
    const html = renderToStaticMarkup(<OnboardingHealthChecklist health={[{
      id: "agents", label: "Agent Readiness", status, detail: "Detail.",
    }]} />);
    assert.match(html, new RegExp(`<span class="onboard-health-icon" aria-hidden="true">${glyph}</span>`), status);
    assert.match(html, new RegExp(`<span class="sr-only">${status}: </span>Agent Readiness`), status);
  }
  for (const [state, glyph] of [["ready", "✓"], ["needs-attention", "!"]] as const) {
    assert.equal(renderToStaticMarkup(<LocalReadinessIcon state={state} />),
      `<div class="onboard-local-icon" aria-hidden="true">${glyph}</div>`, state);
  }
});

test("onboarding health checklist exposes status and a labelled copyable recovery command", () => {
  const html = renderToStaticMarkup(<OnboardingHealthChecklist health={[{
    id: "agents",
    label: "Agent Readiness",
    status: "fail",
    detail: "Codex App Server is not signed in.",
    command: "codex login",
  }]} />);
  assert.match(html, /aria-label="Runner Health Checklist"/);
  assert.match(html, /fail: /);
  assert.match(html, /Codex App Server is not signed in/);
  assert.match(html, /<code>codex login<\/code>/);
  assert.match(html, /aria-label="Copy agent readiness recovery command"/);
});
