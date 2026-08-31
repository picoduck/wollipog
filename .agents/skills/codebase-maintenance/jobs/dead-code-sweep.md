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

Two classes the first sweeps re-derived independently, now named so no run derives them again:

- `apps/web/src/e2e/*-main.tsx` files are Vite entry points referenced from sibling
  `apps/web/<name>-e2e.html` files. They are never unused, and neither is anything whose only
  importer is one of them. This was 15 of 17 knip "unused files" in one run.
- knip reports an export as "unused" when nothing IMPORTS it, even when the symbol is used inside
  its own file — only the `export` keyword is redundant, and deleting the export removes zero
  reachable lines. This was 149 of 168 export candidates in one run. Separate the two cases with
  `git grep -c -w "<symbol>" -- "<its own file>"`: a count of 1 (declaration only) is the real
  dead-code signal; more means the symbol is alive and at most the export modifier is noise.

## Report

Group findings by package, and within a package by file. For each, state the symbol, its file and
line range, the evidence that nothing reaches it, and the approximate line count that deletion would
remove. One issue draft per package, not one per symbol.
