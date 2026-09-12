import { expect, type Page } from "@playwright/test";
import type { SkillGroupView, SkillGroupAssignmentView, SkillSummary } from "../src/skills.js";
export async function installSkillGroupsFixture(page: Page) {
  const scope = { organizationId: "demo-org", owner: { kind: "organization" as const, organizationId: "demo-org" } };
  let groups: SkillGroupView[] = [{ id: "legacy", name: "Legacy Tools" }];
  let skills: SkillSummary[] = [{ id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest: "d1" } }];
  let assignments: SkillGroupAssignmentView[] = [];
  let created = 0;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  await page.route(/\/api\/(?:skills|skill-groups)(?:\/|$)/, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const method = request.method(); const body = request.postData() ? request.postDataJSON() : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/skills") return route.fulfill({ json: { skills } });
    if (path === "/api/skills/skill-1") {
      if (method === "PUT") skills = skills.map(skill => ({ ...skill, groupId: body.groupId }));
      return route.fulfill({ json: { skill: skills[0] } });
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
      if (method === "POST") assignments.push({ id: "rule-1", groupId: id, ...body, enabled: true });
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
