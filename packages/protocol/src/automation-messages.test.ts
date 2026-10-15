import assert from "node:assert/strict";
import test from "node:test";
import * as messages from "./automation-messages.js";

test("automation installation and target sentences use plain user nouns", () => {
  const sentences = Object.entries(messages).flatMap(([name, message]) => typeof message === "string"
    ? [[name, message] as const]
    : [[`${name}(role)`, message("Reviewer", false)] as const, [`${name}(alternate)`, message("the Orchestrator", true)] as const]);
  assert.ok(sentences.length >= 13);
  for (const [name, text] of sentences) {
    // docs/design-system.md §17.2: no internal nouns, and "machine", "workspace" and "project" stay
    // lowercase in prose unless they name a visible control such as the Machine Settings dialog.
    assert.doesNotMatch(text, /Agent Harness|unbound/i, name);
    assert.doesNotMatch(text.replaceAll("Machine Settings", ""), /\b(Machine|Workspace|Project)\b/, name);
    assert.match(text, /^[A-Z].*\.$/, `${name} is a complete sentence-case sentence`);
  }
});

test("a workflow save error names the role or the Orchestrator and the machine", () => {
  assert.equal(messages.automationChooseWorkflowInstallation("Reviewer", false),
    "Choose an available installation of the agent for Reviewer on this machine.");
  assert.equal(messages.automationChooseWorkflowInstallation("the Orchestrator", true),
    "Choose an available installation of the agent for the Orchestrator on the other machine.");
});
