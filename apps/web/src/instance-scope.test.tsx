import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InstanceScopeProvider, useInstanceScope } from "./instance-scope.js";

function Probe() {
  return <span>{useInstanceScope()}</span>;
}

test("instance scope defaults browser dashboards to Local", () => {
  assert.equal(renderToStaticMarkup(<Probe />), "<span>local</span>");
});

test("instance scope provider exposes one immutable remote profile id", () => {
  assert.equal(
    renderToStaticMarkup(
      <InstanceScopeProvider instanceScope="remote-alpha"><Probe /></InstanceScopeProvider>,
    ),
    "<span>remote-alpha</span>",
  );
  assert.throws(
    () => renderToStaticMarkup(<InstanceScopeProvider instanceScope=""><Probe /></InstanceScopeProvider>),
    /instance scope must not be empty/,
  );
});
