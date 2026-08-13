import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../api.js";
import {
  LifecycleConflictDetails,
  lifecycleConflictPresentation,
} from "./RunnersView.js";

test("runner lifecycle conflicts present bounded, normalized session details", () => {
  const error = new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", {
    activeSessionCount: 6,
    activeSessions: [
      { title: "  # AGENTS.md\n\n   Review   the project  ", status: "idle" },
      { title: "Ship <unsafe> markup", status: "input_required" },
      { title: "", status: "running" },
      { title: 42, status: null },
      { title: "This fifth row must remain hidden", status: "idle" },
    ],
  });

  const conflict = lifecycleConflictPresentation(error, "update");
  assert.equal(conflict.message, "Updating this runner will interrupt 6 active sessions.");
  assert.deepEqual(conflict.sessions, [
    { title: "# AGENTS.md Review the project", status: "Idle" },
    { title: "Ship <unsafe> markup", status: "Input Required" },
    { title: "Untitled Session", status: "Running" },
    { title: "Untitled Session", status: "Active" },
  ]);
  assert.equal(conflict.omittedSessionCount, 2);

  const markup = renderToStaticMarkup(<LifecycleConflictDetails conflict={conflict} />);
  assert.match(markup, /Affected Sessions/);
  assert.match(markup, /Ship &lt;unsafe&gt; markup/);
  assert.match(markup, /2 more active sessions not shown/);
  assert.doesNotMatch(markup, /fifth row/);
});

test("runner lifecycle conflicts stay useful when the server omits session details", () => {
  const conflict = lifecycleConflictPresentation(
    new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS"),
    "reconnect",
  );
  assert.equal(conflict.message, "Reconnecting this runner will interrupt active work.");
  assert.deepEqual(conflict.sessions, []);
  assert.equal(conflict.omittedSessionCount, 0);
  assert.equal(renderToStaticMarkup(<LifecycleConflictDetails conflict={conflict} />), "");
});
