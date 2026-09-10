import assert from "node:assert/strict";
import { test } from "node:test";
import { wslHomeToUnc } from "./wsl-skill-snapshots.js";

test("WSL snapshot HOME conversion is positional, absolute, and traversal-free", () => {
  assert.equal(wslHomeToUnc("Ubuntu Dev", "/home/me"), "\\\\wsl.localhost\\Ubuntu Dev\\home\\me");
  for (const [distro, home] of [["../Ubuntu", "/home/me"], ["Ubuntu\\escape", "/home/me"],
    ["Ubuntu:escape", "/home/me"], ["Ubuntu.", "/home/me"], ["Ubuntu", "home/me"],
    ["Ubuntu", "/home/../root"], ["Ubuntu", "/home/me\\escape"], ["Ubuntu", "/home//me"],
    ["Ubuntu", "/home/me\nother"]]) {
    assert.throws(() => wslHomeToUnc(distro!, home!));
  }
});
