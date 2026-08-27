# Agent Instructions

## UI Copy

- Use Title Case for all non-prose visible button text and UI labels, including navigation items,
  tabs, menu items, field labels, compact section labels, badges, table headers, and definition
  terms. Preserve established acronyms and intentionally all-caps text.
- Use standard title casing: capitalize the first and last word and all principal words; keep short
  articles, coordinating conjunctions, and prepositions lowercase unless they are first or last.
- Keep complete sentences, helper text, descriptions, warnings, validation messages, tooltips, and
  user-authored content in normal sentence case.
- Accessible names for controls must match the visible convention even when the control is icon-only.

## UI Change Evidence

- When completed work changes anything user-visible, capture visual evidence and present it in chat
  when asking the user to review or approve the work, so they can give specific feedback before it
  merges. Do not declare UI work done without it.
- Use screenshots for static changes. Record a short video (e.g. Playwright video capture) when the
  change involves interaction, motion, loading states, or transitions that a still image cannot
  convey.
- Capture the states that actually changed: before/after when modifying existing UI, each affected
  viewport (desktop and mobile) when the change is responsive, and relevant variants such as light
  and dark themes when they are affected.
- Save captures inside the working tree or another local path and reference them in chat by absolute
  file path. Keep captures on this machine; real session data may appear in them, so never upload
  them to external services without explicit approval.

## GitHub Issues

- When asked to draft, report, log, file, or create a GitHub issue, read and follow
  `.agents/skills/log-github-issue/SKILL.md` and `.github/ISSUE_REPORTING.md`.
- Do not publish an issue until the user approves the exact sanitized repository, title, body, and
  labels. After publication, read the issue back and return its verified link.
