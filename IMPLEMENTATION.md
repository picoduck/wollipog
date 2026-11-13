# Implementation Guidance

Build the simplest complete change that satisfies the task. Simplicity means fewer concepts to
understand and maintain, not the fewest lines or the smallest diff at any cost.

## Understand the Whole Change

Read the affected flow before editing. Find callers, protocol consumers, tests, fixtures, config,
and exports that must change together. Trace input, authorization, persistence, dispatch, and
recovery across the web app, control plane, and runner where applicable. Fix the shared cause
rather than adding a workaround to each caller. Keep unrelated cleanup out of the change.

Before restructuring defensive or compatibility code, inspect relevant history, linked PRs,
tests, and design decisions to establish why it exists. Separate recorded constraints from
inferred rationale; an unexplained check is not evidence that it is redundant.

## Reuse Before Adding

Search for existing helpers, components, services, and established patterns. Prefer those, then
platform features, then installed dependencies, before writing another implementation. Explain
why a new dependency, configuration option, wrapper, or abstraction is needed by the current task.
Avoid speculative extension points and options without a real caller. Preserve useful boundaries;
similar-looking code with different authority or lifecycle rules need not share an abstraction.

For a substantial interface change, sketch real caller usage first. Include the ordering,
ownership, failure, and recovery rules callers must know, not only its type signature. Prefer
interfaces that concentrate those rules and reduce knowledge spread across callers. Ask what
would happen if an abstraction disappeared: would complexity disappear or move into its callers?

## Preserve Guarantees

Never trade authorization, validation, data durability, recovery, compatibility, observability,
or accessibility for a smaller patch. Keep checks at each trust boundary. Unknown ownership or
missing evidence must retain the existing fail-closed behavior. Treat control-plane state,
runner state, provider processes, and forge state as separate sources with explicit reconciliation.
Consider retries, duplicate delivery, disconnects, crashes, and mixed-version peers. Follow the
repository's protocol, evidence, review, and approval workflows; this guidance grants no authority.

## Verify Behavior

Test changed behavior and meaningful failure cases at the boundary that owns them. A regression
test should fail without the fix. Prefer observable outcomes to assertions that repeat the code,
match prose, or freeze incidental structure. Use existing test infrastructure and proportionate
checks; trivial documentation changes do not need new tests. Never loosen a failing test before
establishing whether it exposes a product defect.

For behavior-preserving refactors, establish the current contract before moving structure. Reuse
adequate tests; add characterization or old-versus-new comparisons where coverage is missing.
Keep that evidence green through small steps and verify affected callers. Typechecking alone
does not establish equivalence. Separate newly discovered behavior changes from the refactor,
and retain compatibility paths required by supported peers. Replace old tests only after mapping
their meaningful guarantees to surviving coverage.

## Explain What Matters

Document non-obvious invariants, deliberate limits, and recovery decisions where maintainers need
them. Use enough explanation to make authority and durability decisions reviewable. Report what
changed, what was verified, and any concrete remaining limitation. Do not invent follow-up work
just to make the report look thorough.
