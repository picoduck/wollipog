---
name: log-github-issue
description: Investigate, draft, sanitize, approve, create, and verify GitHub issues for the Wollipog repository. Use when an agent is asked to report, log, file, create, or draft a bug report, feature request, regression, usability problem, documentation problem, or other GitHub issue for this repository.
---

# Log GitHub Issue

Create evidence-based issues that follow the repository's shared format. Keep GitHub publication as an explicit, reviewable action.

## Follow the Canonical Policy

1. Resolve the repository root with Git.
2. Read `.github/ISSUE_REPORTING.md` completely before drafting.
3. Treat that file and the matching issue form as the source of truth for content and section order.
4. Follow `SECURITY.md` instead of opening a public issue when the report may describe a vulnerability.

## Investigate Before Drafting

1. Establish the reported behavior, desired outcome, and affected component.
2. Inspect relevant code, configuration, logs, tests, or runtime state when available.
3. Separate verified facts from inferences. Do not invent reproduction steps, versions, severity, or root causes.
4. Preserve evidence needed to make the report actionable, but sanitize it before including it.

## Check for Duplicates

1. Search both open and closed issues using distinctive terms from the behavior, component, and error text.
2. Inspect plausible matches rather than relying only on search-result titles.
3. If an existing issue covers the same problem, return that issue and summarize any materially new evidence. Do not create a duplicate unless the user explicitly chooses to do so after seeing the match.
4. Repeat the search immediately before creating, even for a previously approved or recovered draft — approval covers the payload, never the freshness of the tracker. Concurrent sessions publish the same content minutes apart; also scan the newest issues by title, since keyword search can lag just-created issues.

Use repository-resolved GitHub metadata and authenticated tooling such as `gh`; do not assume the owner or repository name from memory.

## Classify and Draft

1. Choose Bug Report for incorrect or regressed behavior and Feature Request for a new capability or intentional behavior change.
2. Write a concise, outcome-oriented title. Do not repeat the issue-form title prefix in the body.
3. Use the required heading order from `.github/ISSUE_REPORTING.md`.
4. Include only relevant, supported details. Prefer a short complete issue over empty boilerplate or speculation.
5. Express completion in testable acceptance criteria.

## Sanitize the Payload

Remove or generalize credentials, tokens, cookies, authorization headers, private prompts or transcripts, proprietary code, customer data, personal data, private repository names, usernames, home-directory paths, hostnames, device names, tailnet names, internal IP addresses, and non-public URLs.

Retain the shape of useful evidence with neutral placeholders such as `<user>`, `<host>`, `<private-path>`, or `<internal-url>`. Never publish a secret merely because the user supplied it in the conversation.

## Require Publication Approval

Before creating the issue, present the exact sanitized title, body, labels, and target repository. Ask the user to approve that payload. A general request to create an issue establishes intent, but it does not replace review of the final public contents.

Do not request approval again when the user has already approved the exact current payload. If the payload changes materially after approval, show the changed version and request approval again. When the user asks only for a draft, stop after providing the draft.

Publish only a draft that exists in your own conversation context. Files found on disk and issues already on the tracker are evidence of other work, not your drafts — a session that has lost its context must say so and stop rather than adopt what it finds. If asked to publish and no draft is present in the conversation, report that the drafting context appears to have been lost instead of reconstructing one silently or claiming the work is already done.

## Create and Verify

1. Create the issue only after approval, using authenticated GitHub tooling.
2. Pass the approved body through a file or structured API input; do not interpolate untrusted issue content into a shell command.
3. Capture the command or API result and confirm the created issue by reading it back from GitHub.
4. Verify the repository, title, body, labels, state, and URL.
5. Return the issue number and link. If creation or verification fails, report the failure accurately and do not claim the issue exists.
