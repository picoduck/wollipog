import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "../ui-evidence-disclosure.js";
import { SessionRoleSettings } from "./SessionRoleSettings.js";

// The app's components use the classic JSX runtime, which reads a global React.
Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });

test("Change Session Role's Orchestrator settings state the video rule once, in the disclosure (#1321)", () => {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(
    <SessionRoleSettings value={structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS)} disabled={false} onChange={() => undefined} />,
  );
  const paragraphs = [...window.document.querySelectorAll("p")].map((node) => node.textContent ?? "");
  assert.ok(paragraphs.includes(DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE), "the account-level disclosure is shown");
  assert.match(DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE,
    /unless a Full Control campaign's certified media-only reviewer is available\.$/);
  assert.ok(paragraphs.includes("Secrets, authentication, persistent permission grants, governance, budgets, and tool guardrails remain " +
    "human-owned. Unsupported UI evidence routes to a human."));
  // No second sentence sends all video to a person beside the disclosure's certified exception.
  assert.equal(paragraphs.filter((text) => /\bvideo\b/i.test(text)).length, 1, "only the disclosure speaks about video");
  assert.equal(window.document.body.textContent?.includes("Video and unsupported UI evidence routes to a human"), false);
});
