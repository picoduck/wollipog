/**
 * Rewrite `apps/web/src/stylesheet-debt.json` from the current tree.
 *
 * Run this ONLY when debt has been paid down, and in the same commit that pays it. Regenerating to
 * silence a failure about NEW debt is how an inventory becomes a rubber stamp: the guard's whole
 * value is that adding an entry has to be a deliberate, reviewable act.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { measureDebt } from "../apps/web/src/stylesheet-guardrails.test.ts";

const target = fileURLToPath(new URL("../apps/web/src/stylesheet-debt.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(measureDebt(), null, 2)}\n`);
console.log(`wrote ${target}`);
