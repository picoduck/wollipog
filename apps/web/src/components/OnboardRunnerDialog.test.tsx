import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalReadinessIcon } from "./OnboardRunnerDialog.js";

// light-theme.test.ts holds this mark to the 3:1 glyph bar because it renders one hidden glyph and
// nothing else, while the status itself is stated in the heading beside it.
test("the local readiness mark renders only a hidden glyph beside a text status", () => {
  for (const [state, glyph] of [["ready", "✓"], ["needs-attention", "!"]] as const) {
    assert.equal(renderToStaticMarkup(<LocalReadinessIcon state={state} />),
      `<div class="onboard-local-icon" aria-hidden="true">${glyph}</div>`, state);
  }
});
