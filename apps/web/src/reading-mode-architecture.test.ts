import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const inbox = readFileSync(new URL("./components/InboxView.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("./components/SessionDetail.tsx", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./e2e/command-inbox-projects-main.tsx", import.meta.url), "utf8");

test("Inbox and expanded sessions share one stable route subtree", () => {
  assert.match(app, /view\.name === "inbox" \|\| view\.name === "session"/);
  assert.doesNotMatch(app, /<SessionDetail/,
    "App must not swap InboxView for a separately mounted SessionDetail when the URL expands");
});

test("the session surface key follows session identity, never display mode", () => {
  assert.doesNotMatch(inbox, /SessionPreview/);
  assert.match(inbox, /<SessionDetail[\s\S]*?key=\{surfaceSessionId\}[\s\S]*?mode=\{expanded \? "expanded" : "preview"\}/);
  assert.doesNotMatch(inbox, /key=\{[^}\n]*(expanded|mode)/,
    "compact and expanded modes must retain the same React component identity");
});

test("the transcript key bridge yields to handled and modified global shortcuts", () => {
  const handler = detail.match(
    /onKeyDown=\{\(event\) => \{\s*if \(event\.defaultPrevented\) return;\s*if \(inTypingContext\(event\.currentTarget\.ownerDocument\)\) return;\s*if \(mode !== "expanded" && !isFollowTailResumeKey\(event\)\) return;\s*if \(isFollowTailUpwardReadingKey\(event\)\) markSingleEarlierActivityIntent\(\);\s*if \(!followTail\.onKeyDown\(event\)\) return;\s*event\.preventDefault\(\);\s*\}\}/,
  );
  assert.ok(handler, "preview and expanded readers must skip capture-handled keys and consume only their own bare reading keys");
  assert.match(handler[0], /mode !== "expanded" && !isFollowTailResumeKey\(event\)/,
    "preview readers expose resume keys without inheriting expanded-only upward-key pause semantics");
  assert.match(handler[0], /inTypingContext\(event\.currentTarget\.ownerDocument\)/,
    "inline transcript inputs must retain bare letters and navigation keys");
  assert.match(handler[0], /isFollowTailUpwardReadingKey\(event\)\) markSingleEarlierActivityIntent\(\)/,
    "expanded upward reading keys must arm the same bounded earlier-page traversal as wheel input");
  assert.doesNotMatch(handler[0], /stopPropagation/,
    "unrelated modified shortcuts must continue bubbling to their global owners");
});

test("the persistent preview-follow fixture keeps InboxView mounted after expansion", () => {
  assert.match(fixture, /SCENARIO !== "preview-follow"/,
    "the generic bare SessionDetail fixture branch must exclude the persistent reading scenario");
  assert.match(fixture, /expandedSessionId=\{view\.name === "session" \? view\.id : null\}/,
    "the persistent reading scenario must exercise production InboxView composition in expanded mode");
});
