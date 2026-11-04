import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { applicability } from "./ci-pr-browser-applicability.mjs";
import { CRITICAL_BROWSER_FILES } from "./ci-pr-browser-policy.mjs";

test("replay uses each unique squash commit's diff and inventory, not the working tree", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "browser-replay-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000 });
  const put = (path, text = "fixture") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text);
  };
  const commit = (message) => { git("add", "."); git("commit", "-qm", message); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of CRITICAL_BROWSER_FILES) put(`apps/web/e2e/${file}`);
  commit("initial inventory");
  put("apps/runner/src/auth.ts"); commit("ordinary source (#1)");
  put("apps/web/e2e/helper.ts"); commit("browser support (#2)");
  const pinned = git("rev-parse", "HEAD").trim();
  put("docs/notes.md"); commit("duplicate suffix (#2)");
  const result = applicability({ cwd, ref: "HEAD", count: 2 });
  assert.equal(result.reduced, 2);
  assert.equal(result.skippedDuplicatePrCommits, 1);
  assert.deepEqual(result.samples.map((row) => row.pullRequest), [2, 1]);
  const older = applicability({ cwd, ref: pinned, count: 2 });
  assert.equal(older.reduced, 1); assert.equal(older.full, 1);
  assert.equal(older.samples[0].reason, "browser-harness-or-support");
  // An uncommitted critical-file deletion cannot change historical inventory.
  rmSync(join(cwd, `apps/web/e2e/${CRITICAL_BROWSER_FILES[0]}`));
  assert.deepEqual(applicability({ cwd, ref: pinned, count: 2 }), older);
  assert.throws(() => applicability({ cwd, count: 501 }), /1–500/);
});
