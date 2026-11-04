import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CampaignBudgetView } from "@wollipog/protocol";
import { CampaignBudgetFacts } from "./CampaignStatusPanel.js";

// The component's JSX compiles against a global React when the suite runs from the repository root.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const budget = (extra: Partial<CampaignBudgetView> = {}): CampaignBudgetView => ({
  authority: { version: 1, accounting: "managed_workers_only", unpriced: "stop", costUsd: 10 },
  state: "active",
  actual: { costUsd: 4.25, toolCalls: 12 },
  outstanding: { costUsd: 3, toolCalls: 0 },
  remaining: { costUsd: 2.75, toolCalls: null },
  occupied: 1,
  acceptedFollowUps: 0,
  reachedCheckpointsUsd: [],
  enforcement: "admission_and_best_effort_cancellation",
  externalWorkers: "unsupported",
  costAccounting: "priced",
  ...extra,
});

/** The Recorded Campaign Spend value, as text. */
function recordedSpend(view: CampaignBudgetView): string {
  const window = new Window();
  window.document.body.innerHTML = `<dl>${renderToStaticMarkup(<CampaignBudgetFacts budget={view} />)}</dl>`;
  const term = [...window.document.querySelectorAll("dt")].find((dt) => dt.textContent === "Recorded Campaign Spend");
  assert.ok(term, "the spend row is shown");
  return term.nextElementSibling!.textContent;
}

test("recorded campaign spend says when it includes an estimate for running turns (#3196)", () => {
  assert.equal(recordedSpend(budget()), "$4.25, 12 tool calls");
  assert.equal(recordedSpend(budget({ actual: { costUsd: 4.25, toolCalls: 12, includesEstimate: true } })),
    "$4.25, 12 tool callsIncludes an estimate for running turns.");
  assert.equal(recordedSpend(budget({ costAccounting: "unavailable", actual: { costUsd: 4.25, toolCalls: 12, includesEstimate: true } })),
    "Cost unavailable, 12 tool calls", "no estimate is claimed for a cost that is not shown");
});

/** The Campaign Allowance value without its note, as text. */
function allowance(view: CampaignBudgetView): string {
  const window = new Window();
  window.document.body.innerHTML = `<dl>${renderToStaticMarkup(<CampaignBudgetFacts budget={view} />)}</dl>`;
  const term = [...window.document.querySelectorAll("dt")].find((dt) => dt.textContent === "Campaign Allowance");
  assert.ok(term, "the allowance row is shown");
  return term.nextElementSibling!.firstChild!.textContent ?? "";
}

test("a campaign authorized without a ceiling says No limit, and a single ceiling is shown alone", () => {
  const unbounded = budget({ authority: { version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 4, acceptedFollowUps: 0 },
    remaining: { costUsd: null, toolCalls: null } });
  assert.equal(allowance(unbounded), "No limit, 4 concurrent workers");
  assert.equal(recordedSpend(unbounded), "$4.25, 12 tool calls", "usage is still metered and shown");
  assert.equal(allowance(budget()), "$10.00");
  const policy = (view: CampaignBudgetView) => renderToStaticMarkup(<CampaignBudgetFacts budget={view} />);
  assert.match(policy(unbounded), /Unpriced usage is counted without a cost\./, "no cost ceiling means unpriced usage never stops the campaign");
  assert.match(policy(budget()), /Unpriced usage stops protected admission\./);
});
