# Job: Docs Freshness

Find documentation and agent-instruction files that no longer describe the repository.

Agent-instruction files matter most. `AGENTS.md` and `CLAUDE.md` are read at the start of every
agent session in this repository, so a stale claim there silently degrades every future session.
This job exists because a review once downgraded a change over `AGENTS.md` referencing files that
did not exist.

## Ground Truth

Mechanical checks first, because they are provable:

- **Broken path references.** Extract every repository path mentioned in `*.md` (including
  `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, `.github/`, and `.agents/skills/`) and test each
  with `test -e`. A documented path that does not exist is a certain finding.
- **Broken relative links.** Resolve every relative Markdown link target and confirm it exists.
- **Stale commands.** Extract every `pnpm`, `node`, and `npx` command shown in docs and confirm the
  script exists in the relevant `package.json`.
- **Stale identifiers.** For symbols, routes, environment variables, and config keys named in docs,
  confirm they still exist with `git grep`.

Then, for the agent-instruction files only, read them fully and check each behavioral claim against
the code.

## Gate

- Every finding must be mechanically demonstrable: the path, link, command, or identifier is named
  in the doc and provably absent from the tree.
- Do not report prose you would phrase differently. This job fixes falsehoods, not style.
- Do not report intentionally illustrative examples — placeholder paths such as `<private-path>`,
  `mcp.example.com`, or `/home/you/` in sample configuration are correct as written.
- Release notes and ADRs describe the past. A statement that was true at the time is not stale;
  check the document's purpose before flagging it.
- Path references in a nested document are doc-relative. Test each candidate relative to the
  document's own directory before reporting it broken — `scripts/build-sidecar.mjs` named in
  `apps/desktop/README.md` resolves to `apps/desktop/scripts/build-sidecar.mjs`, and testing it
  repo-root-relative produced a false broken-path finding in one run.
- Third-party protocol and platform identifiers are not repository symbols. A doc naming a launchd
  plist key, a provider wire field, or another product's event type has nothing to verify with
  `git grep` against this tree; every symbol-check hit in one run was this class.

## Report

Separate certain mechanical findings from judgment calls about the agent-instruction files. Lead
with anything wrong in `AGENTS.md` or `CLAUDE.md`, since those have the widest blast radius. For
each: the file and line, the exact claim, and the evidence it is false.
