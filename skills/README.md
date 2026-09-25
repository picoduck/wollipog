# Wollipog Skills

Agent skills for people who use Wollipog. They teach coding agents running inside Wollipog sessions
how to use the product.

| Skill | Purpose |
|---|---|
| [`using-wollipog`](using-wollipog/SKILL.md) | Compact reference for Wollipog's CLI and MCP tools: worktrees, artifacts, workflow decisions, and campaign supervision. |
| [`orchestrate-issues`](orchestrate-issues/SKILL.md) | Runs an explicitly requested Orchestrator campaign that delegates GitHub issues to child sessions through merge, follow-ups, and archival. Requires `using-wollipog`. |

Install them with **Import from Git** in the Skills view. Use this repository, a release tag, and
the subdirectory `skills`, then assign the imported skills to your Machines. See
[Wollipog Skills](../docs/agent-skills.md#wollipog-skills).

Skills for contributing to this repository, such as issue reporting and release work, live in
[`.agents/skills`](../.agents/skills) instead and are not meant for Wollipog users.
