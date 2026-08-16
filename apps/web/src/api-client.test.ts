import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClient } from "./api.js";
import type { ApiTransport } from "./api-transport.js";

function fixtureTransport(instanceId: string, calls: string[]): ApiTransport {
  return {
    instanceId,
    publicOrigin: `https://${instanceId}.example.test`,
    async request(path) {
      calls.push(path);
      return new Response(JSON.stringify({ instance: instanceId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    close() {},
  };
}

test("API clients remain bound to their instance when logical resource paths are identical", async () => {
  const callsA: string[] = [];
  const callsB: string[] = [];
  const clientA = createApiClient(fixtureTransport("instance-a", callsA));
  const clientB = createApiClient(fixtureTransport("instance-b", callsB));

  const [sessionA, sessionB] = await Promise.all([
    clientA.session("same-session-id"),
    clientB.session("same-session-id"),
  ]);

  assert.deepEqual(sessionA, { instance: "instance-a" });
  assert.deepEqual(sessionB, { instance: "instance-b" });
  assert.deepEqual(callsA, ["/api/sessions/lookup/by-id?id=same-session-id"]);
  assert.deepEqual(callsB, ["/api/sessions/lookup/by-id?id=same-session-id"]);
});

test("binary and JSON requests share the selected instance transport", async () => {
  const paths: string[] = [];
  const transport: ApiTransport = {
    instanceId: "instance-a",
    publicOrigin: "https://instance-a.example.test",
    async request(path) {
      paths.push(path);
      if (path.includes("/export")) return new Response("artifact");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    close() {},
  };
  const client = createApiClient(transport);

  await client.session("same-id");
  await client.artifactExport("same-id");
  assert.deepEqual(paths, ["/api/sessions/lookup/by-id?id=same-id", "/api/artifacts/same-id/export"]);
});

test("cancelTurn posts to the encoded non-terminal turn endpoint", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const client = createApiClient({
    instanceId: "instance-a",
    publicOrigin: "https://instance-a.example.test",
    async request(path, init) {
      calls.push({ path, method: init?.method ?? "GET" });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    close() {},
  });

  await client.cancelTurn("session/1");
  assert.deepEqual(calls, [{ path: "/api/sessions/session%2F1/cancel", method: "POST" }]);
});

test("steering methods use encoded correlated paths and exact mutation bodies", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = createApiClient({
    instanceId: "instance-a",
    publicOrigin: "https://instance-a.example.test",
    async request(path, init) {
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    close() {},
  });

  await client.steer("session/1", {
    submissionId: "submission-1",
    turnId: "turn-1",
    promotePromptId: "queue-1",
  });
  await client.resolveSteeringAttempt("session/1", "submission/1", "queue_again");
  await client.resolveSteeringAttempt("session/1", "submission/1", "dismiss");

  assert.deepEqual(calls, [
    {
      path: "/api/sessions/session%2F1/steer",
      method: "POST",
      body: { submissionId: "submission-1", turnId: "turn-1", promotePromptId: "queue-1" },
    },
    {
      path: "/api/sessions/session%2F1/steering/submission%2F1/resolve",
      method: "POST",
      body: { action: "queue_again" },
    },
    {
      path: "/api/sessions/session%2F1/steering/submission%2F1/resolve",
      method: "POST",
      body: { action: "dismiss" },
    },
  ]);
});

test("provider command invocation posts only the durable authority coordinates and arguments", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = createApiClient({
    instanceId: "instance-a",
    publicOrigin: "https://instance-a.example.test",
    async request(path, init) {
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    close() {},
  });

  await client.invokeSessionCommand("session/1", {
    submissionId: "web-submission-1",
    providerCommandId: "opaque-command-1",
    catalogRevision: "catalog-revision-7",
    argumentText: "focus on storage",
  });

  assert.deepEqual(calls, [{
    path: "/api/sessions/session%2F1/command-invocations",
    method: "POST",
    body: {
      submissionId: "web-submission-1",
      providerCommandId: "opaque-command-1",
      catalogRevision: "catalog-revision-7",
      argumentText: "focus on storage",
    },
  }]);
});

test("Project API methods use stable encoded resource paths and exact mutation bodies", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = createApiClient({
    instanceId: "instance-a",
    publicOrigin: "https://instance-a.example.test",
    async request(path, init) {
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    close() {},
  });

  await client.projects();
  await client.project("project/a");
  await client.createProject({ name: "Project One" });
  await client.updateProject("project/a", { name: "Renamed", hidden: true });
  await client.previewProjectAccessScope("project/a", { kind: "user", userId: "user/1" });
  await client.updateProjectAccessScope("project/a", { kind: "user", userId: "user/1" }, "a".repeat(64));
  await client.deleteProject("project/a");
  await client.addProjectLocation("project/a", { runnerId: "runner-1", workspaceId: "workspace-1" });
  await client.createProjectLocation("project/a", {
    runnerId: "runner-1",
    name: "New Location",
    path: "/repos/new-location",
  });
  await client.previewWorkspaceAccessScope("runner/1", "workspace/1", {
    kind: "organization", organizationId: "org/1",
  });
  await client.updateWorkspaceAccessScope(
    "runner/1",
    "workspace/1",
    { kind: "organization", organizationId: "org/1" },
    "b".repeat(64),
  );
  await client.moveProjectLocation("project/a", { locationId: "location/1" });
  await client.removeProjectLocation("project/a", "location/1");
  await client.setDefaultProjectLocation("project/a", "location/1");
  await client.archiveProjectSessions("project/a");
  await client.setProject("session/1", "project/a");
  await client.setProject("session/2", "project/b", { linkLocation: true });

  assert.deepEqual(calls, [
    { path: "/api/projects", method: "GET", body: undefined },
    { path: "/api/projects/project%2Fa", method: "GET", body: undefined },
    { path: "/api/projects", method: "POST", body: { name: "Project One" } },
    { path: "/api/projects/project%2Fa", method: "PATCH", body: { name: "Renamed", hidden: true } },
    {
      path: "/api/projects/project%2Fa/access-scope?ownerKind=user&ownerId=user%2F1",
      method: "GET",
      body: undefined,
    },
    {
      path: "/api/projects/project%2Fa/access-scope",
      method: "PUT",
      body: { owner: { kind: "user", userId: "user/1" }, confirmationToken: "a".repeat(64) },
    },
    { path: "/api/projects/project%2Fa", method: "DELETE", body: undefined },
    {
      path: "/api/projects/project%2Fa/locations",
      method: "POST",
      body: { runnerId: "runner-1", workspaceId: "workspace-1" },
    },
    {
      path: "/api/projects/project%2Fa/locations/new",
      method: "POST",
      body: { runnerId: "runner-1", name: "New Location", path: "/repos/new-location" },
    },
    {
      path: "/api/runners/runner%2F1/workspaces/workspace%2F1/access-scope?ownerKind=organization&ownerId=org%2F1",
      method: "GET",
      body: undefined,
    },
    {
      path: "/api/runners/runner%2F1/workspaces/workspace%2F1/access-scope",
      method: "PUT",
      body: {
        owner: { kind: "organization", organizationId: "org/1" },
        confirmationToken: "b".repeat(64),
      },
    },
    { path: "/api/projects/project%2Fa/locations/move", method: "POST", body: { locationId: "location/1" } },
    { path: "/api/projects/project%2Fa/locations/location%2F1", method: "DELETE", body: undefined },
    { path: "/api/projects/project%2Fa/locations/location%2F1/default", method: "POST", body: undefined },
    { path: "/api/projects/project%2Fa/archive-sessions", method: "POST", body: undefined },
    { path: "/api/sessions/session%2F1/project", method: "POST", body: { projectId: "project/a" } },
    {
      path: "/api/sessions/session%2F2/project",
      method: "POST",
      body: { projectId: "project/b", linkLocation: true },
    },
  ]);
});
