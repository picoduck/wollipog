/**
 * The managed-worktree guard's judgment of Codex's `apply_patch` edits (#1437).
 *
 * The payload shape and the header grammar asserted here were measured against codex-cli 0.155.1,
 * by capturing the real `PreToolUse` stdin of add, update, delete, and move calls in a throwaway
 * `CODEX_HOME` against a throwaway repository; `applyPatchTargetsProtected` carries the transcript.
 *
 * Both transports #1447 left in place are exercised: `runManagedWorktreeGuardDecision`, which a
 * provider-mode sidecar runs against the protections file, and the runner's verdict socket, which
 * a sandboxed launch asks instead. They share one judging function, and these tests prove the
 * sharing rather than assuming it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  APPLY_PATCH_TOOL,
  GUARD_STATE_REFUSAL,
  MANAGED_WORKTREE_REFUSAL,
  applyPatchTargetsProtected,
  parseApplyPatchPaths,
  pathTargetsGuardState,
  pathTargetsManagedWorktree,
} from "./managed-worktree-protection.js";
import {
  runManagedWorktreeGuardDecision,
  writeManagedWorktreeGuardProtections,
  type ManagedWorktreeGuardOutcome,
} from "./managed-worktree-guard.js";

const REPO = "/repo";
const WORKTREE = "/repo-worktrees/session-a";
const PROTECTIONS = [{ worktreePath: WORKTREE, repoPath: REPO }];

function fixture(): { dir: string; protectionsFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guard-patch-"));
  const protectionsFile = join(dir, "s1.protections.json");
  writeManagedWorktreeGuardProtections(protectionsFile, PROTECTIONS);
  return { dir, protectionsFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A patch document, from the header lines that carry its file names. */
function patch(...lines: readonly string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

/** The `PreToolUse` payload Codex sends for an edit: patch text under the Bash `command` key. */
function applyPatchInput(command: string, cwd: string = WORKTREE): string {
  return JSON.stringify({
    session_id: "abc",
    cwd,
    hook_event_name: "PreToolUse",
    permission_mode: "bypassPermissions",
    tool_name: APPLY_PATCH_TOOL,
    tool_input: { command },
    tool_use_id: "exec-1",
  });
}

/** Every header form that names a location, each one writing at `target`. */
function headersTargeting(target: string): Array<[string, string]> {
  return [
    ["add", patch(`*** Add File: ${target}`, "+planted")],
    ["update", patch(`*** Update File: ${target}`, "@@", "-before", "+after")],
    ["delete", patch(`*** Delete File: ${target}`)],
    // A move names two locations; only the destination is out of bounds here.
    ["move", patch(`*** Update File: ${WORKTREE}/src/app.ts`, `*** Move to: ${target}`, "@@", "-a", "+b")],
  ];
}

function denial(outcome: ManagedWorktreeGuardOutcome): { decision: string; reason: string } {
  const parsed = JSON.parse(outcome.stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

test("an apply_patch header naming the guard state is refused, for add, update, delete, and move", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const [kind, document] of headersTargeting(join(f.dir, "s1.protections.json"))) {
    const outcome = runManagedWorktreeGuardDecision(applyPatchInput(document), f.protectionsFile);
    assert.equal(outcome.exitCode, 0, `${kind}: a deny is a successful hook run, not a failure`);
    assert.equal(outcome.stderr, "", kind);
    assert.deepEqual(denial(outcome), { decision: "deny", reason: GUARD_STATE_REFUSAL }, kind);
  }
});

test("an apply_patch header naming a protected worktree's Git state is refused, for every header", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // The worktree's own gitdir pointer, a hook it would run, and its registration under the
  // repository: the administrative area the managed-worktree rules already protect.
  for (const target of [
    `${WORKTREE}/.git`,
    `${WORKTREE}/.git/hooks/pre-commit`,
    `${REPO}/.git/worktrees/session-a/gitdir`,
  ]) {
    for (const [kind, document] of headersTargeting(target)) {
      const outcome = runManagedWorktreeGuardDecision(applyPatchInput(document), f.protectionsFile);
      assert.deepEqual(denial(outcome), { decision: "deny", reason: MANAGED_WORKTREE_REFUSAL },
        `${kind} of ${target}`);
    }
  }
});

test("an apply_patch touching only ordinary project files gets no opinion at all", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const document of [
    // Relative to the payload's cwd, which is how Codex spelled most measured headers.
    patch("*** Update File: src/app.ts", "@@", "-before", "+after"),
    patch("*** Add File: docs/notes.md", "+hello"),
    patch("*** Delete File: src/old.ts"),
    patch("*** Update File: src/app.ts", "*** Move to: src/renamed.ts", "@@", "-a", "+b"),
    // Absolute, inside the protected worktree: the session's own workspace, never the guard's.
    patch(`*** Update File: ${WORKTREE}/src/app.ts`, "@@", "-before", "+after"),
    // A content line that looks like a directive IS content: it carries the `+` prefix.
    patch("*** Add File: src/fixture.txt", "+*** Add File: /etc/shadow", "+*** Begin Patch"),
    // A removed line and a context line the same way.
    patch("*** Update File: src/app.ts", "@@", "-*** Delete File: /etc/shadow", " context", "+after"),
    // The envelope Codex adds for a remote environment names an id, not a location.
    ["*** Begin Patch", "*** Environment ID: abc-123", "*** Add File: src/new.ts", "+x", "*** End Patch"]
      .join("\n"),
    // An update hunk may end with the end-of-file marker.
    patch("*** Update File: src/app.ts", "@@", "-before", "+after", "*** End of File"),
  ]) {
    assert.deepEqual(
      runManagedWorktreeGuardDecision(applyPatchInput(document), f.protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
      document,
    );
  }
});

test("an apply_patch whose headers cannot be parsed is refused while the guard is active", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const [why, document] of [
    ["not a patch envelope at all", "please just write the file for me"],
    ["no end marker, so the document may be truncated", "*** Begin Patch\n*** Add File: a.txt\n+x"],
    ["no begin marker", "*** Add File: a.txt\n+x\n*** End Patch"],
    ["an envelope naming no file", patch()],
    // The case the fail-closed rule exists for: a directive this build does not model may name a
    // location, and skipping it would wave through the write the guard exists to refuse.
    ["a directive this build does not know", patch("*** Rename File: a.txt", "*** To: b.txt")],
    ["a header with an empty filename", patch("*** Add File: ", "+x")],
    ["a NUL byte", patch("*** Add File: a\u0000.txt", "+x")],
  ] as Array<[string, string]>) {
    const outcome = runManagedWorktreeGuardDecision(applyPatchInput(document), f.protectionsFile);
    assert.equal(outcome.exitCode, 2, why);
    assert.equal(outcome.stdout, "", why);
    assert.ok(outcome.stderr.includes(MANAGED_WORKTREE_REFUSAL), why);
    assert.match(outcome.stderr, /could not read the file headers/u, why);
  }
});

test("an apply_patch payload carrying no patch text is refused, not passed", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const toolInput of [
    { patch: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" },
    { command: ["apply_patch", "*** Begin Patch"] },
    { command: 7 },
    {},
  ]) {
    const outcome = runManagedWorktreeGuardDecision(
      JSON.stringify({ cwd: WORKTREE, tool_name: APPLY_PATCH_TOOL, tool_input: toolInput }),
      f.protectionsFile,
    );
    assert.equal(outcome.exitCode, 2, JSON.stringify(toolInput));
    assert.match(outcome.stderr, /with no patch text/u, JSON.stringify(toolInput));
  }
});

test("an apply_patch header reaches the guard state through a relative, climbing, or symlinked spelling", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const workspace = mkdtempSync(join(tmpdir(), "wollipog-guard-patch-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "src"));
  symlinkSync(f.dir, join(workspace, "innocent"));
  for (const spelling of [
    // Through a symlink that points at the hook directory.
    "innocent/s1.protections.json",
    // Not yet created behind that symlink: the nearest existing ancestor still resolves.
    "innocent/planted.json",
    // Climbing out of the workspace into the sibling hook directory.
    join("..", basename(f.dir), "s1.protections.json"),
  ]) {
    const outcome = runManagedWorktreeGuardDecision(
      applyPatchInput(patch(`*** Add File: ${spelling}`, "+{}"), workspace),
      f.protectionsFile,
    );
    assert.deepEqual(denial(outcome), { decision: "deny", reason: GUARD_STATE_REFUSAL }, spelling);
  }
  assert.deepEqual(
    runManagedWorktreeGuardDecision(
      applyPatchInput(patch("*** Add File: src/index.ts", "+x"), workspace),
      f.protectionsFile,
    ),
    { stdout: "", stderr: "", exitCode: 0 },
    "an ordinary file beside the symlink is untouched by the veto",
  );
});

test("a home-relative apply_patch header is expanded before the guard state is compared", () => {
  // A real session's hook directory lives under the user's home, where `~` names it directly.
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  const me = userInfo().username;
  for (const spelling of [
    "~/.wollipog-test-data/hooks/s1.protections.json",
    `~${me}/.wollipog-test-data/hooks/s1.protections.json`,
    "~/.wollipog-test-data/hooks",
  ]) {
    assert.equal(
      applyPatchTargetsProtected(patch(`*** Add File: ${spelling}`, "+{}"), WORKTREE, directory, PROTECTIONS),
      GUARD_STATE_REFUSAL,
      spelling,
    );
  }
  assert.equal(
    applyPatchTargetsProtected(
      patch("*** Add File: ~/projects/readme.md", "+x"), WORKTREE, directory, PROTECTIONS,
    ),
    null,
  );
});

test("a trailing-padded apply_patch header is judged by both spellings, a leading space by neither", () => {
  // Measured at codex-cli 0.155.1 by reading the bytes of the files it created:
  // `*** Add File: trailing.txt ` -> `trailing.txt`; `*** Add File: nel.txt<U+0085>` -> `nel.txt`;
  // `*** Add File: bom.txt<U+FEFF>` -> `bom.txt<U+FEFF>`; `*** Add File:  leading.txt` ->
  // ` leading.txt`. So trailing padding names a second location, the trim set is Rust's — Unicode
  // `White_Space`, which U+0085 and U+FEFF distinguish from JavaScript's — and a leading space is
  // part of the name.
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  // Padding only matters where the STRIPPED spelling is the protected location itself: a padded
  // path beneath a protected directory is already inside it under the verbatim reading. So these
  // name the worktree's own gitdir pointer and the hook directory itself.
  for (const [why, pad] of [
    ["an ordinary space, which both trim sets remove", " "],
    // U+0085 is Unicode White_Space but NOT JavaScript whitespace: `trimEnd()` leaves it where
    // codex removes it, so judging only `trimEnd`'s result let this exact spelling through.
    ["U+0085, which codex removes and `trimEnd` does not", "\u0085"],
    ["U+00A0", "\u00a0"],
    ["a tab", "\t"],
  ] as Array<[string, string]>) {
    assert.equal(
      applyPatchTargetsProtected(
        patch(`*** Delete File: ${WORKTREE}/.git${pad}`), WORKTREE, directory, PROTECTIONS,
      ),
      MANAGED_WORKTREE_REFUSAL,
      `${why}: the worktree's gitdir pointer`,
    );
    assert.equal(
      applyPatchTargetsProtected(
        patch(`*** Delete File: ~/.wollipog-test-data/hooks${pad}`), WORKTREE, directory, PROTECTIONS,
      ),
      GUARD_STATE_REFUSAL,
      `${why}: the hook state directory itself`,
    );
  }
  // And a padded path already beneath a protected directory is refused under either reading.
  assert.equal(
    applyPatchTargetsProtected(
      patch("*** Add File: ~/.wollipog-test-data/hooks/s1.protections.json  ", "+{}"),
      WORKTREE,
      directory,
      PROTECTIONS,
    ),
    GUARD_STATE_REFUSAL,
  );
  // U+FEFF is JavaScript whitespace but NOT Unicode `White_Space`, and codex keeps it: the file
  // it creates is an ordinary one whose name merely ends in a zero-width no-break space. Stripping
  // it — as `trimEnd()` and as a union of both sets would — refuses normal editing.
  assert.equal(
    applyPatchTargetsProtected(
      patch(`*** Add File: ${WORKTREE}/.git\ufeff`, "+x"), WORKTREE, directory, PROTECTIONS,
    ),
    null,
    "codex keeps U+FEFF, so this names an ordinary workspace file",
  );
  // A file whose name begins with a space is an ordinary, if odd, workspace file: codex creates
  // `<cwd>/ .git/probe`, which is nothing to do with the worktree's Git administration.
  assert.equal(
    applyPatchTargetsProtected(patch("*** Add File:  .git/probe", "+x"), WORKTREE, directory, PROTECTIONS),
    null,
    "trimming the leading space would refuse an ordinary workspace file",
  );
  assert.equal(
    applyPatchTargetsProtected(
      patch("*** Add File:  ~/.wollipog-test-data/hooks/s1.protections.json", "+{}"),
      WORKTREE,
      directory,
      PROTECTIONS,
    ),
    null,
    "and codex would write ` ~/…` beneath the cwd, not into the guard state",
  );
});

test("a spelling with no physical reading is out of bounds, not unrelated", (t) => {
  // A symlinked prefix plus more not-yet-existing components than the resolution walk's bound:
  // `canonicalPath` used to give up and hand back the unresolved spelling, which compares as
  // unrelated, while the kernel — and a tool that creates missing parents — lands inside the
  // guard state. `/proc/self/root` is such a prefix on Linux.
  const f = fixture();
  t.after(f.cleanup);
  const deep = Array.from({ length: 300 }, (_, index) => `d${index}`).join("/");
  const throughSymlink = `/proc/self/root${f.dir}/${deep}/planted.json`;
  if (process.platform === "linux") {
    assert.equal(pathTargetsGuardState(throughSymlink, WORKTREE, f.dir), true);
    const outcome = runManagedWorktreeGuardDecision(
      applyPatchInput(patch(`*** Add File: ${throughSymlink}`, "+{}")),
      f.protectionsFile,
    );
    assert.deepEqual(denial(outcome), { decision: "deny", reason: GUARD_STATE_REFUSAL });
  }
  // The same shape against a protected worktree, on any platform: unresolvable is protected.
  assert.equal(pathTargetsManagedWorktree(`/proc/self/root${WORKTREE}/${deep}/x`, WORKTREE, PROTECTIONS),
    process.platform === "linux");
  // A short path with a few not-yet-existing components still resolves and is judged normally.
  assert.equal(pathTargetsGuardState(join(f.dir, "a", "b", "c.json"), WORKTREE, f.dir), true);
  assert.equal(pathTargetsGuardState(join(WORKTREE, "a", "b", "c.ts"), WORKTREE, f.dir), false);
});

test("the guard's own state is judged before the worktree, so a patch touching both names it", () => {
  const directory = join(homedir(), ".wollipog-test-data", "hooks");
  assert.equal(
    applyPatchTargetsProtected(
      patch(
        `*** Delete File: ${WORKTREE}/.git`,
        "*** Delete File: ~/.wollipog-test-data/hooks/s1.protections.json",
      ),
      WORKTREE,
      directory,
      PROTECTIONS,
    ),
    GUARD_STATE_REFUSAL,
  );
});

test("the header parser returns exactly the filenames the measured grammar names", () => {
  assert.deepEqual(
    parseApplyPatchPaths(patch(
      "*** Add File: a.txt", "+one",
      "*** Delete File: b.txt",
      "*** Update File: c.txt", "*** Move to: d/e f.txt", "@@ context", "-x", "+y", "*** End of File",
    )),
    ["a.txt", "b.txt", "c.txt", "d/e f.txt"],
    "a filename is the rest of the line, interior spaces included",
  );
  // CRLF line endings must not carry the carriage return into the path.
  assert.deepEqual(
    parseApplyPatchPaths("*** Begin Patch\r\n*** Delete File: a.txt\r\n*** End Patch\r\n"),
    ["a.txt"],
  );
  for (const malformed of ["", "*** Begin Patch\n*** End Patch", "hello", "*** Add File: a.txt"]) {
    assert.equal(parseApplyPatchPaths(malformed), "malformed", JSON.stringify(malformed));
  }
});

test("the managed-worktree path veto protects Git state but not the worktree's own contents", () => {
  for (const target of [
    `${WORKTREE}/.git`,
    `${WORKTREE}/.git/config`,
    `${REPO}/.git/worktrees`,
    `${REPO}/.git/worktrees/session-a/gitdir`,
    // A location that CONTAINS the worktree: writing it away takes the worktree with it.
    "/repo-worktrees",
  ]) {
    assert.equal(pathTargetsManagedWorktree(target, WORKTREE, PROTECTIONS), true, target);
  }
  for (const ordinary of [`${WORKTREE}/src/app.ts`, `${REPO}/src/app.ts`, "/elsewhere/file.txt"]) {
    assert.equal(pathTargetsManagedWorktree(ordinary, WORKTREE, PROTECTIONS), false, ordinary);
  }
  // With nothing protected there is no worktree opinion to hold.
  assert.equal(pathTargetsManagedWorktree(`${WORKTREE}/.git/config`, WORKTREE, []), false);
});

test("a session with no worktree yet still refuses an apply_patch against the guard's own state", (t) => {
  // Issue #1303: the guard is installed from spawn, over an empty list, so a worktree created
  // later in the turn is covered from the next invocation. Its own state is vetoed throughout.
  const f = fixture();
  t.after(f.cleanup);
  writeManagedWorktreeGuardProtections(f.protectionsFile, []);
  const stateWrite = runManagedWorktreeGuardDecision(
    applyPatchInput(patch(`*** Update File: ${join(f.dir, "s1.protections.json")}`, "@@", "-a", "+b")),
    f.protectionsFile,
  );
  assert.deepEqual(denial(stateWrite), { decision: "deny", reason: GUARD_STATE_REFUSAL });
  assert.deepEqual(
    runManagedWorktreeGuardDecision(
      applyPatchInput(patch(`*** Delete File: ${WORKTREE}/.git`)),
      f.protectionsFile,
    ),
    { stdout: "", stderr: "", exitCode: 0 },
    "nothing is protected yet, so the worktree veto holds no opinion",
  );
});
