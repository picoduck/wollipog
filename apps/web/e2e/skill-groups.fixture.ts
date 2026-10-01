import { expect, type Page } from "@playwright/test";
import type { ResourceScope } from "@wollipog/protocol";
import type { SkillGroupView, SkillGroupAssignmentView, SkillSummary } from "../src/skills.js";

const orgScope: ResourceScope = { organizationId: "demo-org", owner: { kind: "organization", organizationId: "demo-org" } };

/**
 * Routes the skill library, its groups and their rules for `/skills-removals-e2e.html?groups=1`.
 * `library: "full"` (#1985) adds owned groups of every kind beside the legacy one: Review Team with
 * three skills and two rules, a team's group and a private one.
 */
export async function installSkillGroupsFixture(page: Page, options: { library?: "basic" | "full" } = {}) {
  const full = options.library === "full";
  const scope = orgScope;
  const version = { id: "v1", digest: "d1" };
  let groups: SkillGroupView[] = full ? [
    { id: "review", name: "Review Team", scope },
    { id: "platform", name: "Platform Tools", scope: { organizationId: "demo-org", owner: { kind: "team", teamId: "team-platform" } } },
    { id: "mine", name: "My Drafts", scope: { organizationId: "demo-org", owner: { kind: "user", userId: "user-1" } } },
    { id: "legacy", name: "Legacy Tools" },
  ] : [{ id: "legacy", name: "Legacy Tools" }];
  let skills: SkillSummary[] = full ? [
    { id: "skill-1", name: "code-review", latestVersion: version },
    { id: "skill-2", name: "lint-fix", groupId: "review", latestVersion: version },
    { id: "skill-3", name: "docs-writer", groupId: "review", latestVersion: version },
    { id: "skill-4", name: "test-triage", groupId: "review", latestVersion: version },
    { id: "skill-5", name: "release-notes", latestVersion: version },
    { id: "skill-6", name: "old-helper", groupId: "legacy", latestVersion: version },
  ] : [{ id: "skill-1", name: "code-review", latestVersion: version }];
  let assignments: SkillGroupAssignmentView[] = full ? [
    { id: "rule-a", groupId: "review", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "agent", agentId: "claude" }, enabled: true, invocation: "agent" },
    { id: "rule-b", groupId: "review", scopeKind: "instance", agentSelector: { kind: "all" }, enabled: false, invocation: "manual" },
  ] : [];
  let created = 0;
  let rules = 0;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  await page.route("**/api/identity", route => route.fulfill({ json: {
    context: { userId: "user-1", userName: "Ada", organizationId: "demo-org", organizationName: "Demo", role: "owner", deviceId: null, localBootstrap: true },
    organizations: [], memberships: [], teams: [{ teamId: "team-platform", name: "Platform", organizationId: "demo-org", members: [] }],
  } }));
  await page.route(/\/api\/(?:skills|skill-groups)(?:\/|$)/, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const method = request.method(); const body = request.postData() ? request.postDataJSON() : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/skills") return route.fulfill({ json: { skills } });
    const skillPath = /^\/api\/skills\/([^/]+)$/.exec(path);
    if (skillPath) {
      const id = decodeURIComponent(skillPath[1]!);
      if (method === "PUT") skills = skills.map(skill => skill.id === id ? { ...skill, groupId: body.groupId } : skill);
      return route.fulfill({ json: { skill: skills.find(skill => skill.id === id) } });
    }
    if (path === "/api/skill-groups") {
      if (method === "POST") {
        const group = { id: ++created === 1 ? "created" : `created-${created}`, name: body.name, scope }; groups.push(group);
        return route.fulfill({ status: 201, json: { group } });
      }
      return route.fulfill({ json: { groups, creationScope: scope } });
    }
    const [, , , id, action, ruleId] = path.split("/");
    const group = groups.find(group => group.id === id);
    if (!group) return route.fulfill({ status: 404, json: { error: "Group not found" } });
    if (action === "convert") {
      expect(body).toEqual({ accepted: true }); group.scope = scope;
      return route.fulfill({ json: { group } });
    }
    if (action === "assignments") {
      if (method === "POST") assignments.push({ id: `rule-${++rules}`, groupId: id!, ...body, enabled: true });
      if (method === "PATCH") assignments = assignments.map(rule => rule.id === ruleId ? { ...rule, ...body } : rule);
      if (method === "DELETE") assignments = assignments.filter(rule => rule.id !== ruleId);
      return route.fulfill({ json: { assignments: assignments.filter(rule => rule.groupId === id) } });
    }
    if (method === "DELETE") {
      groups = groups.filter(group => group.id !== id); assignments = assignments.filter(rule => rule.groupId !== id);
      skills = skills.map(skill => skill.groupId === id ? { ...skill, groupId: null } : skill);
      return route.fulfill({ status: 204 });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return { writes };
}
