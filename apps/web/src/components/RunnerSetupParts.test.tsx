import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingHealthChecklist, RunnerSetupFooter } from "./RunnerSetupParts.js";

test("each check shows a hollow circle, a spinner or a Lucide icon, with its status in words for a screen reader", () => {
  for (const [status, words, mark] of [
    ["waiting", "Not started", /<svg[^>]*lucide-circle"?[ >]/],
    ["pending", "Checking", /<span class="spinner" aria-hidden="true"><\/span>/],
    ["pass", "Passed", /<svg[^>]*lucide-circle-check/],
    ["warning", "Warning", /<svg[^>]*lucide-triangle-alert/],
    ["fail", "Failed", /<svg[^>]*lucide-circle-alert/],
  ] as const) {
    const html = renderToStaticMarkup(<OnboardingHealthChecklist health={[{
      id: "agents", label: "Agent Readiness", status, detail: "Detail.",
    }]} />);
    assert.match(html, new RegExp(`<li class="connection-check-${status}">`), status);
    assert.match(html, /<span class="connection-check-icon" aria-hidden="true">/, status);
    assert.match(html, mark, status);
    assert.match(html, new RegExp(`<span class="sr-only">${words}: </span>Agent Readiness`), status);
    assert.doesNotMatch(html, /[✓△↻]/, status);
  }
});

test("a check's recovery command sits in a code well with a labelled icon copy button", () => {
  const html = renderToStaticMarkup(<OnboardingHealthChecklist health={[{
    id: "agents",
    label: "Agent Readiness",
    status: "fail",
    detail: "Codex App Server is not signed in.",
    command: "codex login",
  }]} />);
  assert.match(html, /aria-label="Connection Check"/);
  assert.match(html, /Codex App Server is not signed in/);
  assert.match(html, /<div class="code-well"><code>codex login<\/code>/);
  assert.match(html, /aria-label="Copy Agent Readiness Recovery Command"/);
});

test("the footer offers Cancel and a disabled Done with its reason until the runner connects", () => {
  const before = renderToStaticMarkup(<RunnerSetupFooter stage="before" beforeNote="Done turns on when the runner connects." onClose={() => {}} />);
  assert.match(before, /<p class="runner-setup-reason" id="([^"]+)">Done turns on when the runner connects\.<\/p>/);
  assert.match(before, /<button type="button" class="btn">Cancel<\/button>/);
  assert.match(before, /<button type="button" class="btn primary" disabled="" aria-describedby="[^"]+">Done<\/button>/);
  assert.doesNotMatch(before, /spinner/);

  const waiting = renderToStaticMarkup(<RunnerSetupFooter stage="waiting" beforeNote="unused" onClose={() => {}} />);
  assert.match(waiting, /<span class="spinner" aria-hidden="true"><\/span>Waiting for the runner…/);
  assert.match(waiting, /class="btn primary" disabled=""/);

  const connected = renderToStaticMarkup(<RunnerSetupFooter stage="connected" beforeNote="unused" onClose={() => {}} />);
  assert.doesNotMatch(connected, /runner-setup-reason|disabled/);
  assert.match(connected, /Cancel<\/button><button type="button" class="btn primary">Done<\/button>/);

  assert.equal(renderToStaticMarkup(<RunnerSetupFooter stage="failed" beforeNote="unused" onClose={() => {}} />),
    '<button type="button" class="btn">Cancel</button>');
});
