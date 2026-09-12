import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";

test("descendant checks use persisted ancestry and terminate on malformed cycles", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1);
    const create = (id: string, parentSessionId?: string) => db.createSession({
      id, parentSessionId, runnerId: "r", workspaceId: null, agentId: null, title: id,
      driver: "acp", useWorktree: false, config: {}, now: 2,
    });
    create("root"); create("child", "root"); create("grandchild", "child"); create("sibling", "root"); create("unrelated");
    db.setPendingApproval("child", {
      requestId: "question", kind: "question", title: "Question", options: [],
      questions: [{ id: "q", header: "Next", question: "What next?", options: [] }],
    });
    const child = db.listSessionDescendantRequestCandidates("root").find((session) => session.id === "child");
    assert.ok(child);
    assert.deepEqual(Object.keys(child).sort(), ["id", "pendingApproval", "runnerId", "title"]);
    assert.equal(child.runnerId, "r");
    assert.equal(child.pendingApproval?.requestId, "question");
    assert.deepEqual(db.listSessionDescendantRequestCandidates("root").map((session) => session.id).sort(),
      ["child", "grandchild", "sibling"]);
    assert.equal(db.isSessionDescendant("root", "child"), true);
    assert.equal(db.isSessionDescendant("root", "grandchild"), true);
    for (const [parent, target] of [["root", "root"], ["child", "root"], ["child", "sibling"],
      ["root", "unrelated"], ["missing", "child"], ["root", "missing"]]) {
      assert.equal(db.isSessionDescendant(parent!, target!), false);
    }
    db.setSessionArchived("child", true, 3);
    assert.equal(db.isSessionDescendant("root", "grandchild"), true, "archive preserves ancestry and history");
    db.deleteSession("child");
    assert.equal(db.isSessionDescendant("root", "grandchild"), false, "deleted ancestry fails closed");
    assert.deepEqual(db.listSessionDescendantRequestCandidates("root").map((session) => session.id), ["sibling"]);
    assert.ok(db.getSession("grandchild"), "descendant history survives parent deletion");
    db.raw().prepare("UPDATE sessions SET parent_session_id=? WHERE id=?").run("sibling", "root");
    assert.equal(db.isSessionDescendant("unrelated", "sibling"), false, "cycle terminates");
    assert.equal(db.isSessionDescendant("root", "root"), false, "cycle cannot grant self access");
    assert.deepEqual(db.listSessionDescendantRequestCandidates("root").map((session) => session.id), ["sibling"],
      "candidate projection terminates a cycle without returning self");
  } finally { db.close(); }
});
