import assert from "node:assert/strict";
import { test } from "node:test";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { humanResolver, resolverName, viewerIdentity } from "./resolver-identity.js";

function identity(userId: string, members: Array<[string, string, string?]>): IdentityAdministrationView {
  return {
    context: {
      userId, userName: "", organizationId: "org-1", organizationName: "Org", role: "viewer",
      deviceId: null, localBootstrap: false,
    },
    organizations: [],
    memberships: members.map(([memberId, userName, organizationId = "org-1"]) => ({
      organizationId, organizationName: "Org", userId: memberId, userName,
      userStatus: "active", role: "operator", createdAt: 1,
    })),
    teams: [],
  };
}

test("the viewer's organization decides whether answers can belong to someone else (#2527)", () => {
  assert.equal(viewerIdentity(identity("user-ada", [["user-ada", "Ada"]])).shared, false);
  assert.equal(viewerIdentity(identity("user-ada", [])).shared, false, "a directory without the viewer still counts them");
  assert.equal(viewerIdentity(identity("user-ada", [["user-ada", "Ada"], ["user-x", "X", "org-2"]])).shared, false,
    "another organization's members never make this one shared");
  const shared = viewerIdentity(identity("user-ada", [["user-ada", "Ada"], ["user-grace", " Grace Hopper "], ["user-anon", ""]]));
  assert.equal(shared.shared, true);
  assert.deepEqual([...shared.names], [["user-ada", "Ada"], ["user-grace", "Grace Hopper"]]);

  assert.deepEqual(humanResolver(shared, "user-ada"), { kind: "viewer" });
  assert.deepEqual(humanResolver(shared, "user-grace"), { kind: "member", name: "Grace Hopper" });
  assert.deepEqual(humanResolver(shared, "user-anon"), { kind: "other" });
  assert.equal(humanResolver(shared, undefined), null);
  assert.equal(humanResolver(null, "user-ada"), null);
});

test("resolver names follow Title Case in labels and sentence case in prose", () => {
  assert.equal(resolverName({ kind: "viewer" }), "you");
  assert.equal(resolverName({ kind: "viewer" }, { titleCase: true }), "You");
  assert.equal(resolverName({ kind: "other" }), "another member");
  assert.equal(resolverName({ kind: "other" }, { titleCase: true }), "Another Member");
  assert.equal(resolverName({ kind: "member", name: "grace hopper" }, { titleCase: true }), "grace hopper",
    "a display name is user-authored and kept as written");
});
