/**
 * Rewrite `apps/web/src/stylesheet-debt/` from the current tree: `pnpm regenerate:stylesheet-debt`.
 *
 * Run this ONLY when debt has been paid down, and in the same commit that pays it. Regenerating to
 * silence a failure about NEW debt is how an inventory becomes a rubber stamp: the guard's whole
 * value is that adding an entry has to be a deliberate, reviewable act.
 *
 * It is also how to resolve a conflict in the inventory: take either side, run this, and commit
 * the result. The output depends only on the tree, so both sides converge on the same files.
 */
import { measureDebt } from "../apps/web/src/stylesheet-guardrails.test.ts";
import { INVENTORY_DIRECTORY, writeInventory } from "./stylesheet-debt-store.mjs";

writeInventory(measureDebt());
console.log(`wrote ${INVENTORY_DIRECTORY}`);
