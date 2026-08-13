import assert from "node:assert/strict";
import { test } from "node:test";
import { contextCommandSpec } from "./context-command.js";

test("WSL commands preserve argv boundaries while env values ride WSLENV, never argv", () => {
  const spec = contextCommandSpec(
    { kind: "wsl", distro: "Ubuntu Dev" },
    "git",
    ["worktree", "add", "/home/me/path with space", "HEAD"],
    { cwd: "/home/me/repo with space", env: { GIT_INDEX_FILE: "/tmp/index file" } },
  );
  assert.equal(spec.file, "wsl.exe");
  assert.deepEqual(spec.args, [
    "-d", "Ubuntu Dev", "--cd", "/home/me/repo with space", "--exec",
    "git", "worktree", "add", "/home/me/path with space", "HEAD",
  ]);
  assert.equal(spec.cwd, undefined);
  assert.equal(spec.env?.GIT_INDEX_FILE, "/tmp/index file");
  assert.ok(spec.env?.WSLENV?.split(":").includes("GIT_INDEX_FILE"));
  assert.equal(spec.args.join(" ").includes("/tmp/index file"), false);
});

test("native commands retain the host cwd and executable", () => {
  const spec = contextCommandSpec({ kind: "native" }, "git", ["status"], { cwd: "C:\\repo" });
  assert.equal(spec.file, "git");
  assert.deepEqual(spec.args, ["status"]);
  assert.equal(spec.cwd, "C:\\repo");
});
