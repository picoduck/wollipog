import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const webSourceRoot = join(repoRoot, "apps/web/src");
const approvedHelper = join(webSourceRoot, "browser-crypto.ts");

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

test("browser source centralizes randomUUID compatibility handling", () => {
  const violations = sourceFiles(webSourceRoot)
    .filter((path) => path !== approvedHelper)
    .filter((path) => /\bcrypto\s*\.\s*randomUUID\s*\(/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(repoRoot, path));
  assert.deepEqual(
    violations,
    [],
    "Use browserRandomUUID() so non-secure browser contexts retain a getRandomValues fallback",
  );
});
