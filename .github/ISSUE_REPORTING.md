# GitHub Issue Reporting

Use this policy for issues drafted by people or coding agents. The issue forms under
`.github/ISSUE_TEMPLATE` implement the same structure for GitHub's web interface.

## Before Drafting

1. Investigate enough to distinguish observed behavior from assumptions.
2. Search open and closed issues for the same behavior, component, and error text.
3. Use an existing issue when it already covers the problem. Add only genuinely new evidence.
4. Use GitHub Security Advisories for suspected vulnerabilities; do not publish vulnerability
   details in a public issue.

## Public-Content Rules

An issue is public. Remove or generalize:

- Credentials, tokens, cookies, authorization headers, and secrets.
- Private prompts, transcripts, proprietary source code, private repository names, and customer data.
- Names, email addresses, usernames, and other personal information.
- Home-directory paths, hostnames, device names, tailnet names, internal IP addresses, and
  non-public URLs.

Use neutral placeholders such as `<user>`, `<host>`, `<private-path>`, and `<internal-url>` when the
shape of the evidence matters. Include only the smallest useful log or screenshot excerpt.

## Bug Report Format

Use these headings in order:

```markdown
## Problem

Summarize the user-visible failure and its impact.

## Reproduction Steps

1. Provide the smallest reliable sequence.

## Actual Behavior

Describe what was observed, including sanitized error text.

## Expected Behavior

Describe the intended outcome.

## Environment

Include the Wollipog version or commit and only relevant, sanitized platform details.

## Sanitized Evidence

Include minimal logs, screenshots, or code references. Omit this section when there is no evidence
beyond the reproduction.

## Acceptance Criteria

- State the externally verifiable conditions that demonstrate the problem is fixed.
```

Do not assert a root cause unless it has been verified. Mark a suspected cause as an inference and
include the evidence supporting it.

## Feature Request Format

Use these headings in order:

```markdown
## Problem

Describe the user or operator need and why the current behavior is insufficient.

## Proposed Behavior

Describe the desired outcome without prematurely constraining the implementation.

## Acceptance Criteria

- State the externally verifiable behavior required for completion.

## Alternatives Considered

Summarize meaningful alternatives and tradeoffs. Omit this section when none were evaluated.

## Security and Compatibility

Describe effects on credentials, authentication, networks, shells, filesystems, Git, providers,
stored data, upgrades, or mixed-version deployments. Write `None` when no boundary changes.
```

## Approval Preview Formatting

When an agent presents the exact issue payload for approval, it must preserve both the body text and
its Markdown structure:

- Do not enclose the body in a fixed-length fenced code block. Prefer presenting it as rendered
  Markdown under a clearly labeled **Body** section.
- When a literal-source fence is useful, choose an outer fence delimiter longer than every
  consecutive run of that delimiter character in the body. For example, use four backticks around
  a body containing triple-backtick code fences. Use the same delimiter for the opening and closing
  fence.
- Verify before requesting approval that headings, lists, and embedded code fences remain within
  the body preview. Presentation fencing must not escape, rewrite, or otherwise change the payload
  that will be published.

## Agent Publication Gate

Before an agent publishes an issue, it must show the exact sanitized repository, title, body, and
labels for approval. Approval of an earlier draft does not cover material changes. After creation,
the agent must read the issue back, verify its contents, and return the issue link. It must never
claim that an issue was created when publication or verification failed.
