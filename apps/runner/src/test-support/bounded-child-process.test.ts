import assert from "node:assert/strict";
// This is the one runner test permitted to reach the raw API: it has to bound the module under
// test with something that does not depend on the module under test. See GUARDRAIL_EXEMPT below.
import { spawnSync as rawSpawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  execFileSync,
  spawnSync,
  TEST_CHILD_KILL_SIGNAL,
  TEST_CHILD_TIMEOUT_MS,
  withDefaultTimeout,
} from "./bounded-child-process.js";

const RUNNER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".bin-build"]);
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs"];
const MODULE_URL = new URL("./bounded-child-process.ts", import.meta.url).href;

const HANGS_FOREVER = "setInterval(() => {}, 1000)";
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); ${HANGS_FOREVER}`;

function testFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    // The root test glob reaches apps/**/src/**/*.test.ts(x) AND apps/**/scripts/**/*.test.mjs,
    // so scanning only src/*.test.ts would leave whole file patterns unguarded.
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(path);
  }
  return found;
}

/** Separator-normalized so the exemption below matches on Windows too. */
function repoRelative(path: string): string {
  return path.slice(RUNNER_ROOT.length).split(sep).join("/");
}

/**
 * Runs `code` in a child that imports this module, under a bound of our own that does not depend
 * on the module under test.
 *
 * Testing a deadlock guard in-process is self-defeating: if a regression removes the module's
 * bound, the assertion never gets to run, because the synchronous call it is testing never
 * returns. The suite would hang — the exact failure this module exists to prevent, reproduced by
 * its own guardrail. Delegating to a child makes that regression a clean, fast assertion failure.
 */
function probe(code: string, defaultTimeoutMs: number): string {
  const result = rawSpawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const M = await import(${JSON.stringify(MODULE_URL)});\n${code}`,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: { ...process.env, WOLLIPOG_TEST_CHILD_TIMEOUT_MS: String(defaultTimeoutMs) },
    },
  );

  assert.equal(
    (result.error as NodeJS.ErrnoException | undefined)?.code,
    undefined,
    "the probe child never returned, so the module under test did not bound its own call",
  );
  return result.stdout.trim();
}

/** Reports the error code a wrapper threw, or NO_THROW. */
function callWithoutTimeout(wrapper: "spawnSync" | "execFileSync", childCode: string): string {
  return `
    try {
      M.${wrapper}(process.execPath, ["-e", ${JSON.stringify(childCode)}], { encoding: "utf8" });
      console.log("NO_THROW");
    } catch (error) {
      console.log(error.code ?? "THREW_WITHOUT_CODE");
    }
  `;
}

test("the defaults are applied, and an explicit value always wins", () => {
  assert.equal(withDefaultTimeout(undefined).timeout, TEST_CHILD_TIMEOUT_MS);
  assert.equal(withDefaultTimeout({}).timeout, TEST_CHILD_TIMEOUT_MS);
  assert.equal(withDefaultTimeout({ timeout: undefined }).timeout, TEST_CHILD_TIMEOUT_MS);
  assert.equal(withDefaultTimeout({}).killSignal, TEST_CHILD_KILL_SIGNAL);

  // host-actions.test.ts already passes timeout: 10_000; silently widening that would weaken a
  // bound a caller chose deliberately.
  assert.equal(withDefaultTimeout({ timeout: 10_000 }).timeout, 10_000);
  assert.equal(withDefaultTimeout({ killSignal: "SIGTERM" as const }).killSignal, "SIGTERM");

  // Unrelated options survive.
  assert.equal(withDefaultTimeout({ encoding: "utf8" as const }).encoding, "utf8");
});

test("the bound is a deadlock guard, not a performance budget", () => {
  assert.ok(Number.isFinite(TEST_CHILD_TIMEOUT_MS));
  assert.ok(
    TEST_CHILD_TIMEOUT_MS >= 60_000,
    "too tight: a loaded CI runner would turn slow-but-correct calls into flakes",
  );
  assert.ok(
    TEST_CHILD_TIMEOUT_MS <= 600_000,
    "too loose to fail before the CI job timeout reports the whole job instead of this test",
  );

  // Pinned against the literal, not the constant, so weakening the signal fails here in
  // milliseconds rather than only through the slower end-to-end probe below.
  assert.equal(
    TEST_CHILD_KILL_SIGNAL,
    "SIGKILL",
    "a catchable kill signal lets a child decline the deadline, which is not a bound",
  );
});

test("the wrappers apply the default bound, not just the helper", () => {
  // The point of the module is that a call site passing NO timeout is still bounded. Asserting
  // that through a call which supplies its own timeout would keep passing even if the wrappers
  // stopped consulting withDefaultTimeout, leaving all 162 migrated calls unbounded.
  assert.equal(probe(callWithoutTimeout("spawnSync", HANGS_FOREVER), 1_200), "ETIMEDOUT");
  assert.equal(probe(callWithoutTimeout("execFileSync", HANGS_FOREVER), 1_200), "ETIMEDOUT");
});

test("a child that ignores SIGTERM is still killed", () => {
  // SIGTERM is catchable. With the default signal, Node signals at the deadline and then keeps
  // waiting, so the call never returns and the bound is worthless.
  assert.equal(probe(callWithoutTimeout("spawnSync", IGNORES_SIGTERM), 1_200), "ETIMEDOUT");
});

test("a hung spawnSync throws rather than returning a null status", () => {
  // A timed-out spawnSync reports status null, and callers in
  // discovery/codex-schema-contract.test.ts assert notEqual(status, 0) to mean the child rejected
  // bad input — null passes that, so returning would turn a hang into a false green.
  assert.throws(
    () =>
      spawnSync(process.execPath, ["-e", HANGS_FOREVER], { encoding: "utf8", timeout: 2_000 }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /setInterval/, "the failure names the command that hung");
      return true;
    },
  );
});

// The options-only overload cannot pass arguments, so the executable itself has to hang. A tiny
// POSIX script is the simplest such target; the Windows equivalent is not worth carrying, and
// this file only runs under the ubuntu `pnpm test` job.
test(
  "the options-only overload is bounded too",
  { skip: process.platform === "win32" },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "wollipog-options-only-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const hangs = join(directory, "hangs.sh");
    writeFileSync(hangs, "#!/bin/sh\nwhile true; do sleep 1; done\n");
    chmodSync(hangs, 0o755);

    // Both native functions accept (file, options). Forwarding the bounded options as a third
    // argument in that case is worse than useless: Node reads the second argument as the options
    // and discards the third, so the call would look bounded and run forever.
    assert.equal(
      probe(
        `
        try {
          M.spawnSync(${JSON.stringify(hangs)}, { encoding: "utf8" });
          console.log("NO_THROW");
        } catch (error) {
          console.log(error.code ?? "THREW_WITHOUT_CODE");
        }
        `,
        1_200,
      ),
      "ETIMEDOUT",
      "spawnSync(file, options) must still be bounded",
    );

    // The ETIMEDOUT message path formats the argument list, so it must not assume an array.
    assert.throws(
      () => spawnSync(hangs, { encoding: "utf8", timeout: 1_200 }),
      (error: NodeJS.ErrnoException) => error.code === "ETIMEDOUT",
      "the options-only overload must not throw a TypeError while reporting a timeout",
    );
  },
);

test("spawn errors other than a timeout are still returned, not thrown", () => {
  // ENOENT is a result some callers assert on; only ETIMEDOUT is escalated.
  const result = spawnSync("wollipog-no-such-binary", [], { encoding: "utf8" });

  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
  assert.equal(result.status, null);
});

test("execFileSync still behaves normally for a child that exits", () => {
  const stdout = execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
    encoding: "utf8",
  });
  assert.equal(stdout, "ok");

  assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" }));
});

test("runner tests take the synchronous spawns from this module, not node:child_process", () => {
  // Parse the whole import clause rather than pattern-matching each shape separately. Enumerating
  // shapes kept leaving gaps: `import cp, { spawnSync }` matches neither a braces-first pattern
  // nor an identifier-then-from one. Capturing everything between `import` and the specifier, then
  // inspecting it, covers default, named, namespace, and mixed forms in one place.
  const SPECIFIER = String.raw`['"](?:node:)?child_process['"]`;
  // [^;] keeps a clause inside its own statement; a lazy any-character class would let one file's
  // first import swallow everything up to the offending specifier and tokenize to nothing.
  const IMPORT_CLAUSE = new RegExp(String.raw`import\s+([^;]*?)\s*from\s*${SPECIFIER}`, "g");
  // require() and dynamic import() reach the same module without an import clause.
  const LOADED = new RegExp(
    String.raw`(?:\{([^}]*)\}|(\w+))\s*=\s*(?:await\s+)?(?:require|import)\(\s*${SPECIFIER}\s*\)`,
    "g",
  );
  // Catch-all for the shapes that bind nothing, e.g. (await import(...)).spawnSync(...).
  const LOADED_ANY = new RegExp(String.raw`(?:require|import)\(\s*${SPECIFIER}\s*\)`, "g");
  // execSync is synchronous too and has no wrapper here, so importing it is rejected outright.
  const SYNCHRONOUS = new Set(["execFileSync", "spawnSync", "execSync"]);

  // This file must reach the raw API to bound the module under test independently of itself.
  const GUARDRAIL_EXEMPT = new Set(["src/test-support/bounded-child-process.test.ts"]);

  // ESM aliases with `as`, CommonJS destructuring with `:` — either way, take the imported name.
  const importedNames = (clause: string | undefined): string[] =>
    (clause ?? "")
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+|:/)[0].trim())
      // `spawn` and `exec` are asynchronous, so --test-timeout already bounds them.
      .filter((name) => SYNCHRONOUS.has(name));

  const mentionsSynchronous = (text: string): boolean =>
    [...SYNCHRONOUS].some((name) => new RegExp(String.raw`\b${name}\b`).test(text));

  const offenders: string[] = [];

  for (const path of testFilesUnder(RUNNER_ROOT)) {
    const relative = repoRelative(path);
    if (GUARDRAIL_EXEMPT.has(relative)) continue;
    const text = readFileSync(path, "utf8");

    for (const match of text.matchAll(IMPORT_CLAUSE)) {
      const clause = match[1] ?? "";
      const braced = /\{([^}]*)\}/.exec(clause);
      const names = importedNames(braced?.[1]);
      if (names.length > 0) offenders.push(`${relative}: import { ${names.join(", ")} }`);

      // Whatever sits outside the braces is a default or namespace binding, which hands the test
      // every synchronous function at once. Only flag it when the file actually mentions one:
      // acp-client-services.test.ts embeds `require("node:child_process").spawn(...)` inside a
      // string it writes out as a child script, and that async usage is not this rule's business.
      const binding = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, "").trim();
      if (binding.length > 0 && mentionsSynchronous(text)) {
        offenders.push(`${relative}: default or namespace import (${binding})`);
      }
    }

    let boundLoad = false;
    for (const match of text.matchAll(LOADED)) {
      boundLoad = true;
      const names = importedNames(match[1]);
      if (names.length > 0) offenders.push(`${relative}: require/import { ${names.join(", ")} }`);
      if (match[2] && mentionsSynchronous(text)) {
        offenders.push(`${relative}: whole-module require/import (${match[2]})`);
      }
    }

    // An unbound require()/import() still exposes everything, e.g. (await import(...)).spawnSync().
    // Gated on a synchronous reference for the same reason as the bindings above.
    if (!boundLoad && mentionsSynchronous(text) && LOADED_ANY.test(text)) {
      offenders.push(`${relative}: unbound require/import of child_process`);
    }
    LOADED_ANY.lastIndex = 0;
  }

  assert.deepEqual(
    offenders,
    [],
    `import these from test-support/bounded-child-process.js instead:\n${offenders.join("\n")}`,
  );
});
