import assert from "node:assert/strict";
// This is the one test permitted to reach the raw API: it has to bound the module under test
// with something that does not depend on the module under test. See GUARDRAIL_EXEMPT below.
import { spawnSync as rawSpawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".bin-build"]);
/**
 * The subtrees the root `test` script globs: the `src` and `scripts` directories of every app and
 * package, plus the top-level `scripts`. A file outside them is never run by the suite, so
 * guarding it would be theatre.
 *
 * Walking REPO_ROOT wholesale instead is actively unsafe. `apps/web/src/desktop-bundle.test.ts`
 * rebuilds `apps/web/dist-desktop-check` and `dist-web-check` with Vite's `--emptyOutDir` while
 * the suite runs concurrently, so a recursive walk can list a directory that Vite deletes before
 * the next `readdirSync` and die with an intermittent ENOENT that has nothing to do with spawns.
 * Anchoring on `src` and `scripts` keeps the walk inside source that no test rewrites.
 */
function testRoots(): string[] {
  const roots = [join(REPO_ROOT, "scripts")];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const subdirectory of ["src", "scripts"]) {
        const candidate = join(REPO_ROOT, group, entry.name, subdirectory);
        if (existsSync(candidate)) roots.push(candidate);
      }
    }
  }
  return roots;
}
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs"];
const MODULE_URL = new URL("./bounded-child-process.ts", import.meta.url).href;

const HANGS_FOREVER = "setInterval(() => {}, 1000)";
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); ${HANGS_FOREVER}`;

function testFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(path);
  }
  return found;
}

/** Separator-normalized so the exemption below matches on Windows too. */
function repoRelative(path: string): string {
  return path.slice(REPO_ROOT.length).split(sep).join("/");
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

// Parse the whole import clause rather than pattern-matching each shape separately. Enumerating
// shapes kept leaving gaps: `import cp, { spawnSync }` matches neither a braces-first pattern
// nor an identifier-then-from one. Capturing everything between `import` and the specifier, then
// inspecting it, covers default, named, namespace, and mixed forms in one place.
const SPECIFIER = String.raw`['"](?:node:)?child_process['"]`;
// [^;] keeps a clause inside its own statement; a lazy any-character class would let one file's
// first import swallow everything up to the offending specifier and tokenize to nothing.
const IMPORT_CLAUSE = String.raw`import\s+([^;]*?)\s*from\s*${SPECIFIER}`;
// require() and dynamic import() reach the same module without an import clause.
const LOADED = String.raw`(?:\{([^}]*)\}|([\w$]+))\s*=\s*(?:await\s+)?(?:require|import)\(\s*${SPECIFIER}\s*\)`;
// Catch-all for the shapes that bind nothing, e.g. (await import(...)).spawnSync(...).
const LOADED_ANY = String.raw`(?:require|import)\(\s*${SPECIFIER}\s*\)`;
// execSync is synchronous too and has no wrapper here, so importing it is rejected outright.
const SYNCHRONOUS = new Set(["execFileSync", "spawnSync", "execSync"]);

// ESM aliases with `as`, CommonJS destructuring with `:` — either way, take the imported name.
const importedNames = (clause: string | undefined): string[] =>
  (clause ?? "")
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+|:/)[0].trim())
    // `spawn` and `exec` are asynchronous, so --test-timeout already bounds them.
    .filter((name) => SYNCHRONOUS.has(name));

// `{ default: cp }` and `{ default as cp }` hand over the whole module rather than one export: a
// builtin's `default` is its `module.exports`, so `cp.spawnSync` resolves. `importedNames` reads
// only the name `default`, which is not itself synchronous, so recognise the binding separately.
const defaultBinding = (clause: string | undefined): string | undefined => {
  for (const entry of (clause ?? "").split(",")) {
    // `$` is a valid identifier character and `\w` does not cover it: `{ default: $cp }` is a
    // binding a real contributor writes, and matching only `\w` let it through as no binding.
    const bound = /^\s*default(?:\s*:\s*|\s+as\s+)([\w$]+)\s*$/.exec(entry);
    if (bound) return bound[1];
  }
  return undefined;
};

const mentionsSynchronous = (text: string): boolean =>
  [...SYNCHRONOUS].some((name) => new RegExp(String.raw`\b${name}\b`).test(text));

// Every way a file can reach node:child_process's synchronous API, as human-readable reasons; []
// for a clean file. At module scope so the fixtures below can drive each branch directly: walking
// the repository only ever proves that today's tree happens to be clean, which keeps passing even
// if the detection is deleted.
function synchronousLoadOffenders(text: string): string[] {
  const reasons: string[] = [];

  for (const match of text.matchAll(new RegExp(IMPORT_CLAUSE, "g"))) {
    const clause = match[1] ?? "";
    const braced = /\{([^}]*)\}/.exec(clause);
    const names = importedNames(braced?.[1]);
    if (names.length > 0) reasons.push(`import { ${names.join(", ")} }`);

    // Whatever sits outside the braces is a default or namespace binding, which hands the test
    // every synchronous function at once. Only flag it when the file actually mentions one:
    // acp-client-services.test.ts embeds `require("node:child_process").spawn(...)` inside a
    // string it writes out as a child script, and that async usage is not this rule's business.
    const binding = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, "").trim();
    if (binding.length > 0 && mentionsSynchronous(text)) {
      reasons.push(`default or namespace import (${binding})`);
    }
    const aliased = defaultBinding(braced?.[1]);
    if (aliased !== undefined && mentionsSynchronous(text)) {
      reasons.push(`default or namespace import (${aliased})`);
    }
  }

  for (const match of text.matchAll(new RegExp(LOADED, "g"))) {
    const names = importedNames(match[1]);
    if (names.length > 0) reasons.push(`require/import { ${names.join(", ")} }`);
    // A `default` binding is a whole-module load wearing a destructuring pattern.
    const whole = match[2] ?? defaultBinding(match[1]);
    if (whole !== undefined && mentionsSynchronous(text)) {
      reasons.push(`whole-module require/import (${whole})`);
    }
  }

  // An unbound require()/import() still exposes everything, e.g. (await import(...)).spawnSync().
  // Judge each occurrence by what it is used for rather than by anything file-wide. A file-wide
  // flag fails in both directions: it excuses a genuine unbound synchronous load whenever some
  // unrelated benign load happens to appear first, and it condemns the async
  // `require("node:child_process").spawn(...)` strings that several tests embed as child scripts.
  // A synchronous member access on the load itself is the only local evidence that it is one.
  const SYNCHRONOUS_MEMBER = [...SYNCHRONOUS].join("|");
  // Dot access, optional chaining, and computed access all reach the same function. A comment
  // between the load and the access would still slip through; that needs a parser rather than a
  // regex, and is contrived enough to be recorded as accepted risk instead.
  const ACCESSES_SYNCHRONOUS = new RegExp(
    String.raw`^\s*\)*\s*(?:\??\.\s*(?:${SYNCHRONOUS_MEMBER})\b|(?:\?\.)?\[\s*["'](?:${SYNCHRONOUS_MEMBER})["']\s*\])`,
  );
  for (const loose of text.matchAll(new RegExp(LOADED_ANY, "g"))) {
    const after = text.slice(loose.index + loose[0].length);
    if (ACCESSES_SYNCHRONOUS.test(after)) {
      reasons.push("unbound require/import of child_process");
      break;
    }
  }

  return reasons;
}

test("runner tests take the synchronous spawns from this module, not node:child_process", () => {
  // This file must reach the raw API to bound the module under test independently of itself.
  const GUARDRAIL_EXEMPT = new Set(["packages/test-support/src/bounded-child-process.test.ts"]);

  const offenders: string[] = [];

  for (const path of testRoots().flatMap(testFilesUnder)) {
    const relative = repoRelative(path);
    if (GUARDRAIL_EXEMPT.has(relative)) continue;
    for (const reason of synchronousLoadOffenders(readFileSync(path, "utf8"))) {
      offenders.push(`${relative}: ${reason}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `import these from @wollipog/test-support/bounded-child-process instead:\n${offenders.join("\n")}`,
  );
});

// The repository walk above passes on a clean tree no matter how much of the detection is deleted,
// so on its own it pins none of these branches. Each fixture is a load form that must stay caught.
test("the guardrail rejects every way of reaching the synchronous API", () => {
  const CALL = 'spawnSync("true");';
  const rejected: Record<string, string> = {
    "named import": 'import { spawnSync } from "node:child_process";',
    "named import without the node: prefix": 'import { execSync } from "child_process";',
    "aliased named import": 'import { spawnSync as ss } from "node:child_process";',
    "default import": `import cp from "node:child_process";\n${CALL}`,
    "namespace import": `import * as cp from "node:child_process";\n${CALL}`,
    "mixed default and named import": 'import cp, { spawnSync } from "node:child_process";',
    "static default alias": `import { default as cp } from "node:child_process";\n${CALL}`,
    "require destructure": 'const { execSync } = require("node:child_process");',
    "dynamic import destructure": 'const { spawnSync } = await import("node:child_process");',
    "require whole module": `const cp = require("node:child_process");\n${CALL}`,
    "dynamic import whole module": `const cp = await import("node:child_process");\n${CALL}`,
    "require default destructure": `const { default: cp } = require("node:child_process");\n${CALL}`,
    "dynamic import default destructure": `const { default: cp } = await import("node:child_process");\n${CALL}`,
    // A benign assigned load elsewhere in the file must not excuse this one.
    "unbound require alongside a benign bound one": `const script = 'const { spawn } = require("node:child_process");';\nrequire("node:child_process").spawnSync("true");`,
    "dollar-signed default destructure": `const { default: $cp } = await import("node:child_process");\n${CALL}`,
    "dollar-signed static default alias": `import { default as $cp } from "node:child_process";\n${CALL}`,
    "dollar-signed whole module": `const $cp = require("node:child_process");\n${CALL}`,
    "unbound require via optional chaining": 'require("node:child_process")?.spawnSync("true");',
    "unbound require via optional computed access": 'require("node:child_process")?.["spawnSync"]("true");',
    "unbound require via computed access": 'require("node:child_process")["spawnSync"]("true");',
    "unbound require": 'require("node:child_process").spawnSync("true");',
    "unbound dynamic import": '(await import("node:child_process")).spawnSync("true");',
  };

  for (const [shape, source] of Object.entries(rejected)) {
    assert.notDeepEqual(synchronousLoadOffenders(source), [], `${shape} slipped past the guardrail`);
  }
});

// synchronousLoadOffenders is pinned by the fixtures above, but the walk that feeds it is not:
// narrowing it back to the runner subtree, or dropping an application, leaves the repository scan
// green because the tree it scans is clean either way. Pin the breadth itself.
test("the guardrail scans every test file the repository tracks", () => {
  const scanned = new Set(testRoots().flatMap(testFilesUnder).map(repoRelative));

  // Derive the expectation from the repository rather than from a hand-kept list of areas. A
  // prefix list silently rots: it passed while omitting apps/runner/scripts and packages/protocol,
  // so narrowing the walk to drop them would not have failed anything.
  const tracked = execFileSync("git", ["ls-files", "*.test.ts", "*.test.tsx", "*.test.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path.length > 0);

  assert.ok(tracked.length > 0, "expected git to report tracked test files");
  assert.deepEqual(
    tracked.filter((path) => !scanned.has(path)),
    [],
    "these tracked test files are outside the guardrail's walk, so unbounded spawns in them would go unnoticed",
  );

  // The walk must stay out of build output: apps/web's bundle test deletes and rebuilds these
  // while the suite runs, and racing them fails this file with an unrelated ENOENT.
  assert.deepEqual(
    [...scanned].filter((p) => p.includes("dist-desktop-check") || p.includes("dist-web-check")),
    [],
  );
});

test("the guardrail leaves the wrapper and the asynchronous forms alone", () => {
  const allowed: Record<string, string> = {
    "the wrapper itself": 'import { spawnSync } from "@wollipog/test-support/bounded-child-process";',
    "asynchronous spawn": 'import { spawn } from "node:child_process";',
    // acp-client-services.test.ts and spawn.test.ts embed exactly this in a child script string.
    "an async require inside a child-script string": `const script = 'const { spawn } = require("node:child_process");';\n${'spawnSync("true");'}`,
    "an unrelated builtin": 'import { readFileSync } from "node:fs";',
  };

  for (const [shape, source] of Object.entries(allowed)) {
    assert.deepEqual(synchronousLoadOffenders(source), [], `${shape} was wrongly rejected`);
  }
});
