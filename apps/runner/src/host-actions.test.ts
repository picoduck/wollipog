import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detachedLaunchSpec, editorLaunchSpec, KNOWN_EDITORS, pickWindowsExecutable, revealSpec, wslSourceFileCheckArgs } from "./host-actions.js";

test("editor catalog advertises only verified native/WSL location precision", () => {
  assert.deepEqual(KNOWN_EDITORS.find((editor) => editor.id === "code")?.locations, { native: "column", wsl: "column" });
  assert.deepEqual(KNOWN_EDITORS.find((editor) => editor.id === "cursor")?.locations, { native: "column" });
  assert.deepEqual(KNOWN_EDITORS.find((editor) => editor.id === "zed")?.locations, { native: "column" });
  assert.equal(KNOWN_EDITORS.find((editor) => editor.id === "windsurf")?.locations, undefined);
  assert.deepEqual(
    KNOWN_EDITORS.find((editor) => editor.id === "windsurf"),
    { id: "windsurf", name: "Devin Desktop", bin: "windsurf", remoteWsl: true },
    "the rebrand must not break the installed Windsurf CLI contract",
  );
});

test("editorLaunchSpec: native root is a plain open; unknown editor errors", () => {
  assert.deepEqual(editorLaunchSpec("code", "C:\\repo", { kind: "native" }), { bin: "code", args: ["C:\\repo"] });
  const r = editorLaunchSpec("emacs", "/repo", { kind: "native" });
  assert.ok("error" in r && /unknown editor/.test(r.error));
});

test("editorLaunchSpec: WSL roots use the VS Code-family remote flag", () => {
  assert.deepEqual(editorLaunchSpec("code", "/home/u/repo", { kind: "wsl", distro: "Ubuntu" }), {
    bin: "code",
    args: ["--remote", "wsl+Ubuntu", "/home/u/repo"],
  });
  assert.deepEqual(editorLaunchSpec("cursor", "/r", { kind: "wsl", distro: "Debian" }), {
    bin: "cursor",
    args: ["--remote", "wsl+Debian", "/r"],
  });
});

test("editorLaunchSpec: verified CLIs receive exact native file/line/column argv", () => {
  const location = { path: "src/main file.ts", line: 42, column: 7 };
  assert.deepEqual(editorLaunchSpec("code", "C:\\repo", { kind: "native" }, location), {
    bin: "code", args: ["--goto", `${join("C:\\repo", "src", "main file.ts")}:42:7`],
  });
  assert.deepEqual(editorLaunchSpec("cursor", "/repo", { kind: "native" }, location), {
    bin: "cursor", args: ["--goto", "/repo/src/main file.ts:42:7"],
  });
  assert.deepEqual(editorLaunchSpec("zed", "/repo", { kind: "native" }, { path: "src/a.ts", line: 3 }), {
    bin: "zed", args: ["/repo/src/a.ts:3"],
  });
  assert.deepEqual(editorLaunchSpec("subl", "/repo", { kind: "native" }, { path: "src/a.ts" }), {
    bin: "subl", args: ["/repo/src/a.ts"],
  });
  assert.deepEqual(editorLaunchSpec("idea", "/repo", { kind: "native" }, location), {
    bin: "idea", args: ["--line", "42", "--column", "7", "/repo/src/main file.ts"],
  });
});

test("editorLaunchSpec: only VS Code advertises verified WSL source locations", () => {
  assert.deepEqual(editorLaunchSpec("code", "/home/u/repo", { kind: "wsl", distro: "Ubuntu" }, {
    path: "src/a.ts", line: 8, column: 2,
  }), {
    bin: "code",
    args: ["--remote", "wsl+Ubuntu", "--goto", "/home/u/repo/src/a.ts:8:2"],
  });
  const cursor = editorLaunchSpec("cursor", "/repo", { kind: "wsl", distro: "Ubuntu" }, { path: "a.ts" });
  assert.ok("error" in cursor && /does not expose verified source-location support/.test(cursor.error));
  const windsurf = editorLaunchSpec("windsurf", "/repo", { kind: "native" }, { path: "a.ts" });
  assert.ok("error" in windsurf && /does not expose verified source-location support/.test(windsurf.error));
});

test("editorLaunchSpec: location validation rejects traversal and impossible coordinates", () => {
  for (const location of [
    { path: "../secret" },
    { path: "a.ts", line: 0 },
    { path: "a.ts", column: 2 },
  ]) {
    const result = editorLaunchSpec("code", "/repo", { kind: "native" }, location as never);
    assert.ok("error" in result && /invalid source location/.test(result.error));
  }
});

test("editorLaunchSpec: editors without WSL remote support get a clear error", () => {
  const r = editorLaunchSpec("zed", "/home/u/repo", { kind: "wsl", distro: "Ubuntu" });
  assert.ok("error" in r && /Zed cannot open a WSL path/.test(r.error));
  assert.ok("error" in r && /Devin Desktop/.test(r.error));
});

test("revealSpec: per-platform file managers; WSL paths go through \\\\wsl.localhost", () => {
  assert.deepEqual(revealSpec("C:\\repo", { kind: "native" }, "win32"), { bin: "explorer.exe", args: ["C:\\repo"] });
  assert.deepEqual(revealSpec("/repo", { kind: "native" }, "darwin"), { bin: "open", args: ["/repo"] });
  assert.deepEqual(revealSpec("/repo", { kind: "native" }, "linux"), { bin: "xdg-open", args: ["/repo"] });
  assert.deepEqual(revealSpec("/home/u/repo", { kind: "wsl", distro: "Ubuntu" }, "win32"), {
    bin: "explorer.exe",
    args: ["\\\\wsl.localhost\\Ubuntu\\home\\u\\repo"],
  });
});

test("pickWindowsExecutable: prefers .cmd/.exe over the extension-less POSIX script `where` lists first", () => {
  assert.equal(
    pickWindowsExecutable("C:\\VS Code\\bin\\code\r\nC:\\VS Code\\bin\\code.cmd\r\n"),
    "C:\\VS Code\\bin\\code.cmd",
  );
  assert.equal(pickWindowsExecutable("C:\\Zed\\bin\\zed\r\nC:\\Zed\\bin\\Zed.exe"), "C:\\Zed\\bin\\Zed.exe");
  // No executable-extension hit at all: fall back to the first line rather than failing.
  assert.equal(pickWindowsExecutable("C:\\only\\script"), "C:\\only\\script");
  assert.equal(pickWindowsExecutable(""), null);
});

test("detachedLaunchSpec routes Windows command shims through a shell-free, quoted cmd tail", () => {
  assert.deepEqual(
    detachedLaunchSpec("C:\\Program Files (x86) & Tools\\code.cmd", ["--goto", "C:\\repo & work\\a.ts:4:2"], {
      platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", '""C:\\Program Files (x86) & Tools\\code.cmd" "--goto" "C:\\repo & work\\a.ts:4:2""'],
      windowsVerbatimArguments: true,
    },
  );
  assert.deepEqual(detachedLaunchSpec("/usr/bin/zed", ["/repo/a.ts"], { platform: "linux" }), {
    command: "/usr/bin/zed", args: ["/repo/a.ts"], windowsVerbatimArguments: false,
  });
  assert.throws(
    () => detachedLaunchSpec("C:\\code.cmd", ["%USERPROFILE%\\a.ts"], { platform: "win32" }),
    /would expand/,
  );
  assert.throws(
    () => detachedLaunchSpec("C:\\code.cmd", ['quote"value'], { platform: "win32" }),
    /cannot contain a double quote/,
  );
});

test("WSL source-file checks keep hostile roots and paths in positional argv", () => {
  assert.deepEqual(wslSourceFileCheckArgs("Ubuntu; touch nope", "/repo $(touch nope)", "src/a'; touch nope; '.ts"), [
    "-d",
    "Ubuntu; touch nope",
    "--exec",
    "sh",
    "-c",
    'cd "$1" 2>/dev/null && test -f "./$2"',
    "sh",
    "/repo $(touch nope)",
    "src/a'; touch nope; '.ts",
  ]);
});

test("Windows detached shim launch preserves spaced and metacharacter source argv", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-editor (x86) & Tools-"));
  try {
    const helper = join(dir, "capture.cjs");
    const shim = join(dir, "editor shim.cmd");
    const output = join(dir, "captured args.json");
    writeFileSync(helper, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n');
    writeFileSync(shim, '@echo off\r\nnode "%~dp0capture.cjs" %*\r\n');
    const expected = ["--goto", "C:\\repo & work\\a (test)!^caret.ts:4:2", "pipe|value"];
    const spec = detachedLaunchSpec(shim, [output, ...expected], { platform: "win32", comspec: process.env.ComSpec });
    const result = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
