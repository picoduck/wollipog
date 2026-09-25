# Wollipog Skills

Agent skills for people who use Wollipog. They teach coding agents running inside Wollipog sessions
how to use the product.

| Skill | Purpose |
|---|---|
| [`using-wollipog`](using-wollipog/SKILL.md) | Compact reference for Wollipog's CLI and MCP tools: worktrees, artifacts, workflow decisions, and campaign supervision. |
| [`orchestrate-issues`](orchestrate-issues/SKILL.md) | Runs an explicitly requested Orchestrator campaign that delegates GitHub issues to child sessions through merge, follow-ups, and archival. Requires `using-wollipog`. |

Each Wollipog release includes them as built-in skills: the Skills view lists them as recommended,
and **Assign to All Machines** or **Assign to Machine** deploys them. New releases update them on
Machines that track the latest version. See
[Built-In Skills](../docs/agent-skills.md#built-in-skills).

After changing a skill here, run `pnpm generate:built-in-skills` so the control plane ships the
change.

Skills for contributing to this repository, such as issue reporting and release work, live in
[`.agents/skills`](../.agents/skills) instead and are not meant for Wollipog users.
