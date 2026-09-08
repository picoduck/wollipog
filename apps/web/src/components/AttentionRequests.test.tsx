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
  const inactive = renderToStaticMarkup(<AttentionRequests session={session} keyboardActive={false} onNavigate={() => {}} />);
  assert.equal((inactive.match(/tabindex="-1"/g) ?? []).length, 12, "inactive rows add no sequential tab stops");
  assert.equal(renderToStaticMarkup(<AttentionRequests session={{ ...session, pendingApproval: null }} onNavigate={() => {}} />), "");
});

test("request picker joins only the server-projected safe owner name and explicit role", () => {
  const session = {
    id: "s", status: "input_required",
    pendingApproval: { requestId: "owned", ownerToolUseId: "opaque-owner", title: "Private", options: [],
      additionalRequests: [{ requestId: "missing", ownerToolUseId: "missing-owner", title: "Private Missing", options: [] }] },
    attentionOwners: [
      { requestId: "owned", toolCallId: "opaque-owner", resolved: true, name: "Audit Child", role: "reviewer" },
      { requestId: "missing", toolCallId: "missing-owner", resolved: false },
    ],
  } as unknown as SessionView;
  const html = renderToStaticMarkup(<AttentionRequests session={session} onNavigate={() => {}} />);
  assert.match(html, /Audit Child · Reviewer · Child Approval Required/);
  assert.match(html, /Child Owner Unavailable · Child Approval Required/);
  assert.doesNotMatch(html, /opaque-owner|missing-owner|Private Missing/);
});
