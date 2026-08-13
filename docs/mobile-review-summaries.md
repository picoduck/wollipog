# Mobile approval and review summaries

P1 review work is actionable from a phone without asking the user to trust an abbreviated title or
aggregate line count.

## Queue behavior

- Approval cards show the runner-bounded `ApprovalContext.input` by default. The text is rendered
  as plain preformatted content and is not trimmed, reformatted, or interpreted by the browser.
- The existing provenance, policy blockers, check rollup, finding counts, and reviewer verdict stay
  visible in the cross-session queue.
- **Open approval** navigates to the owning session's stale-safe approval card and its exact option
  set. The queue still does not offer bulk allow; only the existing bulk reject path remains.
- **Open exact diff** navigates to the owning session and opens the existing Review panel directly.
  On phone viewports that panel is the full-width overlay, so the canonical unified/split,
  staged/unstaged, findings, and GitHub provenance views remain the only diff implementation.
- Legacy/context-free approvals state that exact input was not supplied instead of implying that the
  shorter title is the full command.

## Trust and compatibility boundaries

- No protocol or persistence migration is required. Approval input already crosses the authenticated
  runner boundary as a bounded field; this slice only stops omitting it from the queue UI.
- Exact diffs are loaded on demand through the existing session-scoped, capability-gated git route.
  The queue does not duplicate or cache patch content and cannot present an aggregate summary as the
  reviewed bytes.
- Phone controls use 44-pixel minimum touch targets. Desktop continues to use compact row actions.
- Plain React text rendering prevents command/tool input from becoming executable markup.

## Acceptance

- A phone-sized queue shows the exact supplied approval input without byte rewriting.
- One tap opens the canonical exact diff in the full-width Review overlay.
- Missing exact input is explicit, not silently hidden.
- Desktop queue navigation, stale-safe approval identity, bulk rejection, review findings, and diff
  capability/error handling remain unchanged.
