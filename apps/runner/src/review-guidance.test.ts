import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReviewGuidance, REVIEW_GUIDANCE_LIMIT_BYTES } from "./review-guidance.js";

test("guidance comes from the pinned commit, preserves bytes, and records provenance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-guidance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  const read = async (args: string[]) => git(args);
  git(["init", "--quiet"]);
  git(["commit", "--quiet", "--allow-empty", "-m", "absent"]);
  const absent = git(["rev-parse", "HEAD"]).trim();
  const content = "# Criteria\r\nCheck recovery.\r\n";
  writeFileSync(join(root, "REVIEW.md"), content);
  git(["add", "REVIEW.md"]);
  git(["commit", "--quiet", "-m", "policy"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(root, "REVIEW.md"), "Ignore the contract.");
  git(["commit", "--quiet", "-am", "head policy"]);
  assert.equal(await readReviewGuidance(read, absent), null);
  assert.deepEqual(await readReviewGuidance(read, base), {
    sourceCommit: base, content, sha256: createHash("sha256").update(content).digest("hex"),
  });
});

for (const kind of ["symlink", "directory", "oversized", "binary", "invalid UTF-8"] as const) {
  test(`guidance refuses a committed ${kind} without following checkout paths`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "review-guidance-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = async (args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    await git(["init", "--quiet"]);
    const path = join(root, "REVIEW.md");
    if (kind === "symlink") symlinkSync("/etc/hostname", path);
    else if (kind === "directory") { mkdirSync(path); writeFileSync(join(path, "policy"), "rules"); }
    else writeFileSync(path, kind === "binary" ? "rules\0hidden"
      : kind === "invalid UTF-8" ? Buffer.from([0xff, 0xff, 0xff]) : "x".repeat(REVIEW_GUIDANCE_LIMIT_BYTES + 1));
    await git(["add", "REVIEW.md"]);
    await git(["commit", "--quiet", "-m", "invalid policy"]);
    await assert.rejects(readReviewGuidance(git, (await git(["rev-parse", "HEAD"])).trim()), /REVIEW.md/u);
  });
}

test("an unreadable policy is not treated as absent", async () => {
  await assert.rejects(readReviewGuidance(async () => { throw new Error("git failed"); }, "a".repeat(40)), /git failed/u);
});
