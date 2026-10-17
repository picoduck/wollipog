import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  landlockSpecialFilesHelper, landlockSpecialFilesUnavailableReason, setLandlockSpecialFilesHelperForTests,
  stageLandlockSpecialFilesHelper,
} from "./landlock-special-files.js";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
afterEach(() => setLandlockSpecialFilesHelperForTests());

/** Landlock is a kernel feature; probe the exact capability instead of inferring it. */
function staged(): ReturnType<typeof stageLandlockSpecialFilesHelper> | string {
  if (process.platform !== "linux") return "Landlock is Linux only";
  if (!existsSync("/usr/bin/cc")) return "no C compiler to build the helper";
  try {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-landlock-test-")));
    roots.push(root);
    return stageLandlockSpecialFilesHelper([root]);
  } catch (error) {
    return `Landlock is not enforced on this host: ${(error as Error).message}`;
  }
}

const helper = staged();
const skip = typeof helper === "string" ? helper : false;

function run(args: string[]): { status: number | null; output: string } {
  const result = spawnSync((helper as { path: string }).path, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("the helper refuses special files outside its allowed roots and nothing else", { skip }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-landlock-roots-")));
  roots.push(root);
  const allowed = join(root, "allowed");
  const protectedDirectory = join(root, "relocated");
  mkdirSync(allowed);
  mkdirSync(protectedDirectory);
  const script = [
    `ln -s target ${JSON.stringify(join(allowed, "link"))}`,
    `mkfifo ${JSON.stringify(join(allowed, "fifo"))}`,
    `mkdir -p ${JSON.stringify(join(allowed, "node_modules/.pnpm/pkg"))}`,
    `ln -s .pnpm/pkg ${JSON.stringify(join(allowed, "node_modules/pkg"))}`,
    // Landlock denies cross-directory renames and links unless REFER is granted; tools rely on both.
    `printf moved > ${JSON.stringify(join(allowed, "staged"))}`,
    `python3 -I -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2]); os.link(sys.argv[2], sys.argv[3])' ${JSON.stringify(join(allowed, "staged"))} ${JSON.stringify(join(allowed, "node_modules/.pnpm/pkg/moved"))} ${JSON.stringify(join(allowed, "node_modules/linked"))}`,
    `printf regular > ${JSON.stringify(join(protectedDirectory, "packed-refs.lock"))}`,
    `mv ${JSON.stringify(join(protectedDirectory, "packed-refs.lock"))} ${JSON.stringify(join(protectedDirectory, "packed-refs"))}`,
    `mkdir ${JSON.stringify(join(protectedDirectory, "directory"))}`,
    `if ln -s /etc/passwd ${JSON.stringify(join(protectedDirectory, "link"))}; then exit 10; fi`,
    `if mkfifo ${JSON.stringify(join(protectedDirectory, "fifo"))}; then exit 11; fi`,
    `if ln -s /etc/passwd ${JSON.stringify(join(protectedDirectory, "directory", "nested"))}; then exit 12; fi`,
  ].join(" && ");
  const result = run(["--allow", allowed, "--", "/bin/sh", "-c", script]);
  assert.equal(result.status, 0, result.output);
  assert.ok(lstatSync(join(allowed, "link")).isSymbolicLink());
  assert.equal(lstatSync(join(allowed, "node_modules/linked")).nlink, 2);
  assert.ok(lstatSync(join(protectedDirectory, "packed-refs")).isFile());
  for (const name of ["link", "fifo", join("directory", "nested")]) {
    assert.equal(existsSync(join(protectedDirectory, name)), false, name);
  }
});

test("the helper never runs a command it could not restrict", { skip }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-landlock-refuse-")));
  roots.push(root);
  const marker = join(root, "ran");
  const command = ["/bin/sh", "-c", `printf ran > ${JSON.stringify(marker)}`];
  const file = join(root, "file");
  writeFileSync(file, "");
  for (const [label, args] of [
    ["no arguments", []],
    ["a relative root", ["--allow", "relative", "--", ...command]],
    ["a missing root", ["--allow", join(root, "missing"), "--", ...command]],
    ["a file as root", ["--allow", file, "--", ...command]],
    ["a missing separator", ["--allow", root, ...command]],
    ["no command", ["--allow", root, "--"]],
    ["a relative probe directory", ["--probe", "relative"]],
  ] as const) {
    assert.equal(run([...args]).status, 125, label);
    assert.equal(existsSync(marker), false, label);
  }
  const probe = join(root, "probe");
  mkdirSync(probe);
  assert.equal(run(["--probe", probe]).status, 0);
  assert.ok(lstatSync(join(probe, "allowed", "link")).isSymbolicLink(), "the probe's allowed symlink was created");
  assert.ok(existsSync(join(probe, "allowed", "to", "file")), "the probe's cross-directory rename succeeded");
  assert.equal(existsSync(join(probe, "denied", "link")), false, "the probe's refused symlink does not exist");
  assert.equal(run(["--probe", probe]).status, 125, "a reused probe directory is refused rather than trusted");
});

test("an unavailable helper is reported and never staged as available", () => {
  setLandlockSpecialFilesHelperForTests(() => null);
  assert.equal(landlockSpecialFilesHelper(), null);
  setLandlockSpecialFilesHelperForTests();
  if (process.platform !== "linux") {
    assert.equal(landlockSpecialFilesHelper(), null);
    assert.match(landlockSpecialFilesUnavailableReason() ?? "", /unavailable/);
  }
});
