import assert from "node:assert/strict";
import { test } from "node:test";
import { matchWorkspaceId, matchWorkspaceIds, workspacePathsEqual } from "./workspace-match.js";

/* -------------------------------------------------------------------------- */
/* matchWorkspaceId — file a session under a workspace by its cwd             */
/* -------------------------------------------------------------------------- */

const WS = [
  { id: "ws-posix", path: "/home/me/repo" },
  { id: "ws-win", path: "C:\\Repo" },
];

test("matchWorkspaceId matches an exactly equal path", () => {
  assert.equal(matchWorkspaceId(WS, "/home/me/repo"), "ws-posix");
});

test("matchWorkspaceId matches a path INSIDE a workspace", () => {
  assert.equal(matchWorkspaceId(WS, "/home/me/repo/packages/core"), "ws-posix");
});

test("matchWorkspaceId prefers the longest (most specific) path for nested workspaces", () => {
  const nested = [
    { id: "outer", path: "/home/me/repo" },
    { id: "inner", path: "/home/me/repo/apps/web" },
  ];
  assert.equal(matchWorkspaceId(nested, "/home/me/repo/apps/web/src"), "inner");
  assert.equal(matchWorkspaceId(nested, "/home/me/repo/apps"), "outer");
  // Declaration order must not matter — most specific still wins.
  assert.equal(matchWorkspaceId([...nested].reverse(), "/home/me/repo/apps/web/src"), "inner");
});

test("matchWorkspaceId compares Windows drive-letter paths case-insensitively with mixed separators", () => {
  // Windows filesystems are case-insensitive; both sides normalize \ → / first.
  assert.equal(matchWorkspaceId(WS, "c:/repo/sub"), "ws-win");
  assert.equal(matchWorkspaceId(WS, "c:\\REPO"), "ws-win");
});

test("matchWorkspaceId compares POSIX paths case-SENSITIVELY (no match on case difference)", () => {
  assert.equal(matchWorkspaceId(WS, "/home/me/REPO"), null);
  assert.equal(matchWorkspaceId(WS, "/home/ME/repo/sub"), null);
});

test("matchWorkspaceId strips trailing slashes on both sides", () => {
  assert.equal(matchWorkspaceId([{ id: "ws", path: "/home/me/repo/" }], "/home/me/repo"), "ws");
  assert.equal(matchWorkspaceId(WS, "/home/me/repo/"), "ws-posix");
  assert.equal(matchWorkspaceId(WS, "C:\\Repo\\sub\\"), "ws-win");
});

test("matchWorkspaceId equates the WSL drvfs form /mnt/<drive> with the Windows drive path", () => {
  // The headline scenario: claude ran inside WSL under a Windows drive; the workspace was
  // registered natively — same (case-insensitive) filesystem, so they must match.
  const win = [{ id: "ws", path: "C:\\Users\\developer\\Dev\\repo" }];
  assert.equal(matchWorkspaceId(win, "/mnt/c/Users/developer/Dev/repo/sub"), "ws");
  assert.equal(matchWorkspaceId(win, "/mnt/c/users/DEVELOPER/dev/repo"), "ws"); // drvfs is case-insensitive too

  // Reverse direction: workspace registered in WSL form, cwd reported natively.
  const wsl = [{ id: "ws", path: "/mnt/c/Users/developer/Dev/repo" }];
  assert.equal(matchWorkspaceId(wsl, "C:\\Users\\developer\\Dev\\repo\\sub"), "ws");

  // Two /mnt/c paths differing only in case are the same drvfs filesystem.
  assert.equal(matchWorkspaceId(wsl, "/mnt/c/Users/developer/dev/REPO"), "ws");
});

test("matchWorkspaceId leaves non-drive /mnt mounts untouched (no drive canonicalization)", () => {
  // /mnt/data is a plain directory, not a drvfs drive — stays POSIX (case-sensitive, no D: form).
  const ws = [{ id: "ws", path: "/mnt/data/repo" }];
  assert.equal(matchWorkspaceId(ws, "/mnt/data/repo/sub"), "ws");
  assert.equal(matchWorkspaceId(ws, "/mnt/DATA/repo"), null);
  assert.equal(matchWorkspaceId([{ id: "ws", path: "D:/ata/repo" }], "/mnt/data/repo"), null);
});

test("matchWorkspaceId does not guess Linux-home mappings onto Windows or WSL UNC paths", () => {
  const linuxCwd = "/home/example/dev/project";
  assert.equal(
    matchWorkspaceId([{ id: "native", path: "C:\\Users\\example\\Dev\\project" }], linuxCwd),
    null,
  );
  assert.equal(
    matchWorkspaceId([{
      id: "wsl-unc",
      path: "\\\\wsl.localhost\\Fixture-Distro\\home\\example\\dev\\project",
    }], linuxCwd),
    null,
  );
});

test("matchWorkspaceId rejects a prefix that is not a path boundary", () => {
  // /home/me/repo2 merely starts with the workspace string — it is NOT inside /home/me/repo.
  assert.equal(matchWorkspaceId(WS, "/home/me/repo2"), null);
  assert.equal(matchWorkspaceId(WS, "/home/me/repo2/src"), null);
});

test("matchWorkspaceId returns null for a null/empty/blank session path", () => {
  assert.equal(matchWorkspaceId(WS, null), null);
  assert.equal(matchWorkspaceId(WS, undefined), null);
  assert.equal(matchWorkspaceId(WS, ""), null);
  assert.equal(matchWorkspaceId(WS, "   "), null);
});

test("matchWorkspaceId returns null when nothing matches", () => {
  assert.equal(matchWorkspaceId(WS, "/somewhere/else"), null);
  assert.equal(matchWorkspaceId([], "/home/me/repo"), null);
});

test("matchWorkspaceIds reports every most-specific durable identity instead of selecting a tie", () => {
  assert.deepEqual(matchWorkspaceIds([
    { id: "reported-parent", path: "C:/code" },
    { id: "reported-exact", path: "C:\\code\\repo" },
    { id: "managed-exact", path: "c:/CODE/repo/" },
  ], "C:/code/repo/src"), ["reported-exact", "managed-exact"]);
});

test("workspacePathsEqual applies the same exact Windows and drvfs canonicalization", () => {
  assert.equal(workspacePathsEqual("C:\\Users\\me\\repo", "/mnt/c/users/ME/repo/"), true);
  assert.equal(workspacePathsEqual("/home/Me/repo", "/home/me/repo"), false);
  assert.equal(workspacePathsEqual("/home/me/repo", "/home/me/repo/sub"), false);
});
