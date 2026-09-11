/**
 * Rewrite `apps/web/src/e2e-geometry-debt.json` from the current specs.
 *
 * Run this ONLY when an exception has been removed, or when a new one is genuinely justified, and
 * in the same commit that does it. Regenerating to silence a failure about a NEW bare number is how
 * an allowlist becomes a rubber stamp: the guard's whole value is that adding an entry has to be a
 * deliberate, reviewable act.
 *
 * Reasons already written are PRESERVED. A newly added entry gets a placeholder that the guardrail
 * itself rejects, so regenerating cannot quietly launder an unexplained exception into the tree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { measureGeometry, UNEXPLAINED } from "../apps/web/src/e2e-geometry-guardrails.test.ts";

const target = fileURLToPath(new URL("../apps/web/src/e2e-geometry-debt.json", import.meta.url));
const previous = new Map(
  (JSON.parse(readFileSync(target, "utf8")).allowed ?? []).map((entry) => [entry.id, entry.reason]),
);

const allowed = measureGeometry()
  .map(({ id }) => ({ id, reason: previous.get(id) ?? UNEXPLAINED }))
  .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

writeFileSync(target, `${JSON.stringify({ allowed }, null, 2)}\n`);

const added = allowed.filter((entry) => entry.reason === UNEXPLAINED);
console.log(`wrote ${target} (${allowed.length} exceptions, ${added.length} needing a reason)`);
for (const entry of added) console.log(`  needs a reason: ${entry.id}`);
