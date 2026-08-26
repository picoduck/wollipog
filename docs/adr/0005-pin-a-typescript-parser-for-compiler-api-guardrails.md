# ADR 0005: Pin a TypeScript parser for the compiler-API guardrails

- Status: Proposed
- Date: 2026-08-26
- Decision owners: Wollipog maintainers
- Tracking issue: [#349](https://github.com/picoduck/wollipog/issues/349)

## Context

Two tests parse first-party source with the TypeScript compiler API rather than asserting against
rendered output:

- `apps/web/src/ui-copy-style.test.ts` enforces the Title Case and sentence case rules in
  `AGENTS.md` against JSX attributes and literals.
- `apps/web/src/stylesheet-guardrails.test.ts` walks class-name expressions to decide which
  selectors in `styles.css` are genuinely reachable.

Between them they use `createSourceFile`, `forEachChild`, `SyntaxKind`, `ScriptTarget`,
`ScriptKind`, and eighteen `is*` type guards. Both reach the API through `import ts from
"typescript"`.

TypeScript 7 is the Go port, and its published package does not expose that API on the default
entry point. `typescript@7.0.2` declares `"exports": { ".": "./lib/version.cjs", ... }`, and
`lib/version.cjs` re-exports `version` and `versionMajorMinor` and nothing else. The AST entry
points that replace it are published under an `unstable/` prefix — `typescript/unstable/ast`,
`typescript/unstable/ast/is`, `typescript/unstable/ast/factory`, `typescript/unstable/ast/scanner`
— and a stable programmatic API is not expected before 7.1.

This couples two upgrades that have no reason to be coupled. Moving `tsc` forward is a
configuration change; porting these two files is roughly 940 lines of AST-walking test code. On a
literal reading, the compiler upgrade blocks on the port, and the port can only be written against
an API the vendor labels unstable.

## Decision

Decouple them.

1. The repository's `tsc` — the compiler that runs `pnpm -r typecheck` and `pnpm -r build` — may
   move to 6.0 and then 7.0 on its own schedule. These two tests do not gate that move.
2. Through that upgrade, the two guardrail tests keep using the classic compiler API from a
   second, aliased, pinned TypeScript devDependency in `apps/web` (`npm:typescript@5.9.x`), used
   only as a test-time AST parser. They parse first-party source to enforce repository
   conventions; they do not need to agree with the compiler that type-checks the build.
3. Port them to `typescript/unstable/ast` only after a stable programmatic API ships. Do not port
   to an `unstable/` specifier — that trades one forced migration for two.
4. Do not reimplement either check without a parser. Both were written against an AST precisely
   because the regex versions were wrong, and a weakened guardrail is worse than a pinned
   dependency.

## Alternatives Considered

**Port to `typescript/unstable/ast` now.** Cannot be written today — those subpaths do not exist in
TypeScript 5.9, so the port is untestable until the compiler upgrade lands, which is the ordering
this ADR exists to break. It also guarantees a second migration when 7.1 stabilizes the API.

**Reimplement the checks with regular expressions.** Rejected. `stylesheet-guardrails.test.ts`
resolves class names through conditional expressions, template literals, and property access; a
textual approximation reintroduces exactly the false positives and false negatives the AST version
removed.

**Stay on TypeScript 5.9 indefinitely.** A legitimate choice, but it should be a recorded decision
rather than drift, and it makes every downstream toolchain bump progressively harder. This ADR
lets the compiler move without forcing that call.

## Consequences

- `apps/web` carries two TypeScript resolutions during the transition: the build compiler and the
  pinned parser. This is a deliberate, documented duplicate, and any dependency automation should
  treat the alias as pinned rather than bump it.
- The guardrails keep enforcing exactly what they enforce today. Neither test file changes.
- The compiler upgrade becomes a configuration exercise, reviewable on its own merits.

## Prerequisite Already Landed

`packages/protocol/tsconfig.json` now names `"types": ["node"]` explicitly. TypeScript 6.0 changes
the default for `types` from every installed `@types` package to `[]`, and
`packages/protocol/src/skills-digest.ts` imports `node:crypto` and uses `Buffer`. The package
compiled only through the implicit default; it now states the dependency. The other three package
configs already did.

## Revisit When

TypeScript ships a stable, non-`unstable` programmatic AST API — expected in 7.1. At that point
port both files and drop the pinned parser alias.
