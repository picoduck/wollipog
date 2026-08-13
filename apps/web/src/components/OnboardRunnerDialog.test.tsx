import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingHealthChecklist } from "./OnboardRunnerDialog.js";

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
