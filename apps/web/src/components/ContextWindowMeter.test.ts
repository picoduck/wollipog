import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const meter = readFileSync(new URL("./ContextWindowMeter.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/**
 * #781 split the two questions apart: the ring answers "how full is the model's window right
 * now", the neighbouring Session Usage control answers "what has this session accumulated".
 * These guard the split at the source, because a billing figure creeping back into the context
 * popover is exactly the regression that made the strip's trailing value unreadable.
 */
test("the context popover reports occupancy and capacity, and no session billing", () => {
  assert.match(meter, /<dt>Used<\/dt>[\s\S]*<dt>Capacity<\/dt>[\s\S]*<dt>Remaining<\/dt>/,
    "the popover states the current occupancy figures it is responsible for");
  assert.match(meter, /compactionNote\(session\.driver\)/,
    "compaction behaviour stays with the context window");
  assert.doesNotMatch(meter, /formatCost|costUsd|Session Cost|Cache Read|Cache Write|Total Processed/,
    "cumulative cost and token buckets belong to the Session Usage control");
  assert.doesNotMatch(meter, /By Model|byModel|sessionUsage|useApi/,
    "the meter no longer fetches or renders the per-model usage ledger");
});

test("the meter shares one anchored-popover implementation with the session-cost control", () => {
  assert.match(meter, /useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>/);
  assert.doesNotMatch(meter, /addEventListener\("pointerdown"/,
    "dismissal and viewport placement live in the shared hook, not duplicated per control");
});

test("the meter consumes the capacity resolution that also allocates its status-strip seat", () => {
  assert.match(meter, /resolution: ContextWindowCapacity/);
  assert.match(meter, /const contextWindow = resolution\.capacity/);
  assert.doesNotMatch(meter, /resolveCaps|useStoreSelector/,
    "the meter cannot independently repeat or drift from SessionDetail's capacity decision");
});

test("the two controls stay visually distinct and their popovers stay separate", () => {
  assert.match(meter, /aria-label=\{`Context Window \$\{fill\.formatPct\} Used`\}/);
  assert.match(css, /\.context-ring-fill\s*\{/, "only the context control draws a ring");
  assert.doesNotMatch(css, /\.context-popover-model/,
    "the per-model rules moved to the Session Usage popover rather than being shared");
});
