import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * No control characters in source.
 *
 * This exists because of a specific, repeated, expensive mistake. Writing a file through a shell
 * heredoc turns an escaped `\b` into a literal U+0008 BACKSPACE, and the result compiles and runs:
 *
 *     /^color\(\s*srgb\b/     becomes     /^color\(\s*srgb<BS>/
 *
 * which matches nothing. That regex decided whether a colour was read as 0-1 or as 0-255, so the
 * measurement reported light blue text as near-black and five labels as failing at 1.08:1. A long
 * time went into "why does this palette fail" before the answer turned out to be a character no
 * editor displays. The same corruption hit the icon test earlier in this campaign, where an
 * `IconBase` guard silently matched nothing for hours.
 *
 * The cost is not the bug — it is that the bug LOOKS like a real finding: a measurement that
 * confidently reports a failure which is not there. A guard is cheap.
 *
 * It caught its own first draft, which had gone through the same heredoc and contained a literal
 * NUL where an escape was intended.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));
const E2E = fileURLToPath(new URL("../e2e/", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    if (/\.(ts|tsx|mjs|css|html)$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Tab, newline and carriage return are legitimate; nothing else below 0x20 is.
 *
 * Built from codepoints rather than written as a character class, so this file cannot itself be
 * corrupted into a pattern that matches nothing — which is exactly the failure it guards against.
 */
const ALLOWED_CONTROLS = new Set([9, 10, 13]);
const isForbidden = (code: number) => (code < 0x20 && !ALLOWED_CONTROLS.has(code)) || code === 0x7f;

test("no source file contains an invisible control character", () => {
  const offenders: string[] = [];
  for (const path of [...sourceFiles(SRC), ...sourceFiles(E2E)]) {
    const source = readFileSync(path, "utf8");
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (!isForbidden(code)) continue;
      const line = source.slice(0, index).split(String.fromCharCode(10)).length;
      offenders.push(`${path.slice(SRC.length)}:${line} has U+${code.toString(16).padStart(4, "0").toUpperCase()}`);
      break;
    }
  }
  assert.deepEqual(offenders, [],
    "a control character in source is invisible in every editor and changes what the code means");
});

test("the guard can actually see one", () => {
  // The check above passes on a clean tree whether or not it works. This is the other half: the
  // detector is exercised on the exact character that caused the bug, and on the correct form.
  const corrupted = `srgb${String.fromCharCode(8)}`;
  assert.equal([...corrupted].some((c) => isForbidden(c.charCodeAt(0))), true,
    "a literal backspace must be detected");
  assert.equal([...String.raw`/^color\(\s*srgb\b/`].some((c) => isForbidden(c.charCodeAt(0))), false,
    "and the correctly escaped form must not be");
});
