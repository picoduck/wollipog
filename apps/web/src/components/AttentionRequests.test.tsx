import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "@wollipog/protocol";
import { AttentionRequests } from "./AttentionRequests.js";

Object.defineProperty(globalThis, "React", { configurable: true, value: React });

test("request picker counts normalized requests and bounds high-cardinality rendering", () => {
  const request = { requestId: "first", title: "Private Provider Title", options: [] };
  const session = { id: "s", status: "input_required", pendingApproval: { ...request,
    additionalRequests: [request, ...Array.from({ length: 100 }, (_, index) => ({
      ...request, requestId: String(index), ownerToolUseId: "private-owner-id",
    }))],
  } } as unknown as SessionView;
  const html = renderToStaticMarkup(<AttentionRequests session={session} onNavigate={() => {}} />);
  assert.match(html, /101 Requests/);
  assert.equal((html.match(/<button/g) ?? []).length, 11, "ten exact targets and one bounded full-list entry");
  assert.doesNotMatch(html, /Private Provider Title|private-owner-id/);
  assert.match(html, /View All Requests/);
  assert.equal(renderToStaticMarkup(<AttentionRequests session={{ ...session, pendingApproval: null }} onNavigate={() => {}} />), "");
});
