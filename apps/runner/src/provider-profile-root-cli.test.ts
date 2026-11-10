import assert from "node:assert/strict";
import { test } from "node:test";
import { runProfileRootCli, type ProfileRootCliHost } from "./provider-profile-root-cli.js";
import { runWollipogCli } from "./wollipog-cli.js";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(options: { interactive?: boolean; answer?: string; reason?: string } = {}) {
  const calls: unknown[][] = [], prompts: string[] = [], output: string[] = [];
  const host: ProfileRootCliHost = {
    home: "/synthetic/home", platform: "linux", interactive: options.interactive ?? true,
    async confirm(prompt) { prompts.push(prompt); return options.answer ?? "repair manager_root"; },
    run(...args) {
      calls.push(args);
      return args[0] === "inspect" ? { ok: false, component: "manager_root", reason: options.reason ?? "group_or_other_write",
        repairable: !options.reason, identity: "1:2:3:4" }
        : { ok: true, component: "manager_root", reason: "repaired", repairable: false };
    },
  };
  return { host, calls, prompts, output, io: { stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) } };
}
test("repair refuses unattended use and unknown yes flags before metadata access", async () => {
  for (const args of [["profile-root", "repair"], ["profile-root", "repair", "--yes"]]) {
    const f = fixture({ interactive: false });
    assert.equal(await runProfileRootCli(args, f.host, f.io), 2);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.prompts, []);
  }
});
test("one exact human response authorizes only the inspected component and snapshot", async () => {
  const f = fixture();
  assert.equal(await runProfileRootCli(["profile-root", "repair"], f.host, f.io), 0);
  assert.deepEqual(f.calls, [["inspect", "/synthetic/home", "manager_root"], ["repair", "/synthetic/home", "manager_root", "1:2:3:4"]]);
  assert.equal(f.prompts.length, 1);
  assert.ok(!f.prompts[0]!.includes("1:2:3:4"), "raw filesystem metadata stays internal");
  for (const answer of ["", "yes", "repair profiles_root", "repair manager_root "]) {
    const cancelled = fixture({ answer });
    assert.equal(await runProfileRootCli(["profile-root", "repair"], cancelled.host, cancelled.io), 1);
    assert.equal(cancelled.calls.length, 1);
  }
});
test("ambiguous ACL/type/ownership states are guidance-only and never prompt or repair", async () => {
  for (const reason of ["unsupported_acl", "not_directory", "wrong_owner", "symlink", "identity_changed"]) {
    const f = fixture({ reason });
    assert.equal(await runProfileRootCli(["profile-root", "repair"], f.host, f.io), 1);
    assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 0);
  }
});
test("inspection is usable unattended and malformed/native errors never expose paths", async () => {
  const f = fixture({ interactive: false });
  assert.equal(await runProfileRootCli(["profile-root", "inspect", "--json"], f.host, f.io), 1);
  assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 0);
  assert.ok(!f.output.join("").includes("1:2:3:4"));
  f.host.run = () => { throw new Error("unsafe path /private/operator/home credential text"); };
  assert.equal(await runProfileRootCli(["profile-root", "inspect"], f.host, f.io), 1);
  assert.ok(!f.output.join("").includes("/private/operator"));
});

test("a lost repair response reports uncertainty with no replay", async () => {
  for (const failure of ["throw", "malformed", "reported"]) {
    const f = fixture(); const original = f.host.run;
    f.host.run = (...args) => {
      if (args[0] === "inspect") return original(...args);
      f.calls.push(args);
      if (failure === "throw") throw new Error("/private/path");
      return failure === "malformed" ? {} : { ok: false, component: "manager_root", reason: "may_have_changed", repairable: false };
    };
    assert.equal(await runProfileRootCli(["profile-root", "repair"], f.host, f.io), 1);
    assert.equal(f.calls.length, 2);
    assert.ok(f.output.join("").includes('"component":"manager_root","reason":"may_have_changed"'));
    assert.ok(f.output.join("").includes("do not replay or roll back automatically"));
    assert.ok(!f.output.join("").includes("/private/path"));
  }
});

test("public CLI refuses session repair before credential discovery or metadata helper launch", async () => {
  const output: string[] = [];
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "profile-root", "repair"],
    { WOLLIPOG_SESSION_ID: "synthetic-session" }, { stdout: (s) => output.push(s), stderr: (s) => output.push(s) },
    async () => assert.fail("local maintenance must not contact the control plane")), process.platform === "linux" ? 2 : 1);
  assert.ok(output.join("").includes(process.platform === "linux" ? "local interactive terminal" : "unsupported_platform"));
});

test("unsupported platforms provide explicit guidance without helper launch or consent", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const f = fixture(); f.host.platform = platform;
    assert.equal(await runProfileRootCli(["profile-root", "repair"], f.host, f.io), 1);
    assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
    assert.ok(f.output.join("").includes("unsupported_platform"));
  }
});

test("a legacy helper passing --probe but lacking metadata mode is refused before consent", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-old-root-helper-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const helper = join(root, "old-helper");
  // Legacy helper contract: --probe works; any other arguments are a bounded protocol error.
  execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", helper], { input: `
#include <string.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) return 0;
  fputs("unsupported lease helper arguments", stdout); return 1;
}` });
  assert.equal(execFileSync(helper, ["--probe"], { encoding: "utf8", timeout: 1000 }), "");
  const home = join(root, "home"); mkdirSync(home);
  const sentinel = join(home, "sentinel"); writeFileSync(sentinel, "preserve");
  const f = fixture(); f.host.home = home;
  f.host.run = (...args) => {
    f.calls.push(args);
    return JSON.parse(execFileSync(helper, ["--profile-root", ...args.filter((v): v is string => v !== undefined)], { encoding: "utf8", timeout: 1000 }));
  };
  assert.equal(await runProfileRootCli(["profile-root", "repair"], f.host, f.io), 1);
  assert.equal(f.prompts.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![0], "inspect");
  assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  assert.ok(!f.output.join("").includes(root));
});
