import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const componentsUrl = new URL("./components/", import.meta.url);
const expectedCallSites = new Map<string, RegExp>([
  ["PodsView.tsx", /sessionActive=\{isTimelineSessionActive\(status\)\}/],
  ["RunsView.tsx", /sessionActive=\{isTimelineSessionActive\(session\.status\)\}/],
  ["SessionDetail.tsx", /sessionActive=\{isTimelineSessionActive\(session\.status\)\}/],
  ["SideChatPanel.tsx", /sessionActive=\{isTimelineSessionActive\(sideChat\.session\.status\)\}/],
  ["SubagentsPanel.tsx", /sessionActive=\{selected\.lifecycle === "starting" \|\| selected\.lifecycle === "running"\}/],
]);

test("every production EventTimeline call site supplies its live-updating lifecycle", () => {
  const discovered = new Map<string, number>();
  for (const entry of readdirSync(componentsUrl, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;
    const source = readFileSync(new URL(entry.name, componentsUrl), "utf8");
    const count = source.match(/<EventTimeline\b/g)?.length ?? 0;
    if (entry.name !== "EventTimeline.tsx" && count > 0) discovered.set(entry.name, count);
  }

  assert.deepEqual(discovered, new Map([...expectedCallSites.keys()].map((file) => [file, 1])),
    "adding or removing a production timeline requires an explicit lifecycle assertion here");
  for (const [file, lifecyclePattern] of expectedCallSites) {
    const source = readFileSync(new URL(file, componentsUrl), "utf8");
    assert.match(source, lifecyclePattern, `${file} must wire the timeline to its current session lifecycle`);
  }
});
