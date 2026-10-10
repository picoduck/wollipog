import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewFinding } from "@wollipog/protocol";
import { FINDING_SEVERITY, findingLocation, findingProvenance, isOpenFinding } from "./review-finding-copy.js";
import type { ViewerIdentity } from "./resolver-identity.js";

const NOW = Date.UTC(2026, 9, 10, 12, 0);
const MINUTE = 60_000;

const shared: ViewerIdentity = {
  userId: "usr_me",
  shared: true,
  names: new Map([["usr_me", "Mitch"], ["usr_ada", "Ada Lovelace"]]),
};

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingId: "rf_1",
    sessionId: "s1",
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    filePath: "apps/web/src/CheckoutPage.tsx",
    side: "right",
    line: 54,
    body: "Guard the empty cart.",
    severity: "major",
    required: false,
    status: "open",
    source: "local",
    author: { kind: "human", id: "usr_me" },
    createdAt: NOW - 12 * MINUTE,
    updatedAt: NOW - 12 * MINUTE,
    ...over,
  };
}

const remote = (provider: "github" | "gitlab", subjectType: "line" | "file" | "remote" = "line") => ({
  provider,
  repository: "acme/shop",
  pullRequestNumber: 7,
  threadId: "t1",
  commentId: 1,
  url: "https://example.test/t1",
  commitId: "b".repeat(40),
  outdated: false,
  subjectType,
  synchronizedAt: NOW,
});

test("severity maps to one badge tone and a Title Case label from copy", () => {
  assert.deepEqual(FINDING_SEVERITY, {
    blocker: { label: "Blocker", tone: "danger" },
    major: { label: "Major", tone: "warning" },
    minor: { label: "Minor", tone: "neutral" },
    nit: { label: "Nit", tone: "neutral" },
  });
});

test("provenance names the author in words, never an id, a scope enum or a diff side", () => {
  const read = (over: Partial<ReviewFinding>, scope: ReviewFinding["scope"] | null = "uncommitted", viewer: ViewerIdentity | null = shared) =>
    findingProvenance(finding(over), { viewer, now: NOW, scope });
  assert.equal(read({}), "You · 12m ago");
  assert.equal(read({ side: "left" }), "You · 12m ago", "the side never shows");
  assert.equal(read({ author: { kind: "human", id: "usr_ada" }, createdAt: NOW - 61 * MINUTE }), "Ada Lovelace · 1h ago");
  assert.equal(read({ author: { kind: "human", id: "usr_gone" } }), "Another Member · 12m ago", "never the raw id");
  assert.equal(read({}, "all_branch"), "You · 12m ago · Uncommitted", "the scope shows when it differs");
  assert.equal(read({ scope: "last_turn" }, "uncommitted"), "You · 12m ago · Last Turn");
  assert.equal(read({ scope: "all_branch" }, null), "You · 12m ago", "no diff on screen, no scope to compare");
  assert.equal(read({}, "uncommitted", null), "12m ago", "an unknown viewer is not guessed at");
  assert.equal(read({}, "uncommitted", { ...shared, shared: false }), "You · 12m ago", "a one-member organization");
  assert.equal(read({ author: { kind: "agent", id: "agent_1" } }), "Agent · 12m ago");
  assert.equal(
    read({ source: "gitlab", author: { kind: "human", id: "reviewer" }, scope: "all_branch", remote: remote("gitlab") }),
    "reviewer on GitLab · 12m ago",
    "a forge thread names its forge login and never a scope",
  );
  assert.equal(read({ source: "github", author: { kind: "human" }, remote: remote("github") }), "GitHub · 12m ago");
});

test("the location is the base name and line, with the full path in the tooltip", () => {
  assert.deepEqual(findingLocation(finding()), {
    label: "CheckoutPage.tsx:54",
    title: "apps/web/src/CheckoutPage.tsx:54",
    source: { path: "apps/web/src/CheckoutPage.tsx", line: 54 },
  });
  assert.deepEqual(findingLocation(finding({ side: "left" })).source, { path: "apps/web/src/CheckoutPage.tsx" },
    "a line of the old file opens the file, not a line of the new one");
  assert.deepEqual(findingLocation(finding({ remote: remote("github", "file") })), {
    label: "CheckoutPage.tsx",
    title: "apps/web/src/CheckoutPage.tsx",
    source: { path: "apps/web/src/CheckoutPage.tsx" },
  });
  assert.deepEqual(findingLocation(finding({ filePath: "__remote__/gitlab-discussion-1", remote: remote("gitlab", "remote") })),
    { label: null, title: null, source: null });
});

test("open and sent findings are the open ones", () => {
  assert.deepEqual(
    (["open", "sent", "resolved", "dismissed"] as const).map((status) => isOpenFinding(finding({ status }))),
    [true, true, false, false],
  );
});
