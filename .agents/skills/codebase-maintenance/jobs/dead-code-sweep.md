# Job: Dead Code Sweep

Find code that nothing reaches: unused exports, unreferenced files, unused dependencies, dead
branches behind conditions that can no longer be false.

## Ground Truth

Run `npx -y knip --no-progress` from the repository root. It understands this pnpm workspace and
reports unused files, exports, and dependencies without being installed into the tree. If it cannot
resolve the workspace, fall back to reference counting: for each exported symbol in a candidate
file, `git grep -n "<symbol>"` across `apps/`, `packages/`, and `scripts/`, and treat a symbol whose
only hit is its own declaration as a candidate.

Cross-check candidates against the test suite: a symbol referenced only by its own test is dead
production code plus a test that should go with it, not a live symbol.

## Gate

A finding qualifies only when all of these hold:

- no reference outside its own declaration and its own test;
- not exported from a package entry point or `index.ts` that external consumers import;
- not referenced from a non-TypeScript surface — check `git grep` across `*.json`, `*.md`, `*.html`,
  `*.yml`, and the Rust sources under `apps/desktop/src-tauri/`;
- not reached dynamically. Search for the symbol name as a string literal, and for computed access
  patterns near its call sites, before concluding it is unreachable.

## Known False Positives

Protocol types and constants in `packages/protocol` that exist to pin a wire contract may have few
or no local references and are not dead. Driver capability tables, migration steps, and
compatibility shims for older protocol versions are load-bearing even when unreferenced today.
Anything exported for tests in another package will look local-only to a naive grep.

## Report

Group findings by package, and within a package by file. For each, state the symbol, its file and
line range, the evidence that nothing reaches it, and the approximate line count that deletion would
remove. One issue draft per package, not one per symbol.
