import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import type { PromptImage } from "@wollipog/protocol";
import { stagePromptImages, type WslImageCommand } from "./prompt-images.js";

const image = (mimeType = "image/png", data = Buffer.from("pixels").toString("base64")): PromptImage => ({ mimeType, data });

test("native staging creates private context-local files and cleanup is idempotent", async () => {
  const staged = await stagePromptImages([image(), image("image/webp")], { kind: "native" });
  const dir = dirname(staged.paths[0]!);
  try {
    assert.deepEqual(staged.inputs, staged.paths.map((path) => ({ type: "localImage", path })));
    assert.equal(readFileSync(staged.paths[0]!, "utf8"), "pixels");
    if (process.platform !== "win32") {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(staged.paths[0]!).mode & 0o777, 0o600);
    }
  } finally {
    await staged.cleanup();
    await staged.cleanup();
  }
  assert.equal(existsSync(dir), false);
});

test("WSL staging creates files inside the distro and never uses a Windows/UNC path", async () => {
  const calls: Array<{ args: string[]; input?: Buffer }> = [];
  const run: WslImageCommand = async (args, input) => {
    calls.push({ args, input });
    return { stdout: args.includes("mktemp") ? "/tmp/wollipog-prompt-images.Abc123\n" : "", stderr: "" };
  };
  const staged = await stagePromptImages([image("image/jpeg")], { kind: "wsl", distro: "Ubuntu Dev" }, run);
  assert.deepEqual(staged.paths, ["/tmp/wollipog-prompt-images.Abc123/image-1.jpg"]);
  assert.equal(staged.paths.some((path) => path.includes("\\")), false);
  assert.deepEqual(calls[1]!.args.slice(0, 6), ["-d", "Ubuntu Dev", "--exec", "sh", "-c", 'umask 077; cat > "$1"']);
  assert.equal(calls[1]!.input!.toString("utf8"), "pixels");
  await staged.cleanup();
  assert.deepEqual(calls.at(-1)!.args, ["-d", "Ubuntu Dev", "--exec", "rm", "-rf", "--", "/tmp/wollipog-prompt-images.Abc123"]);
});

test("WSL staging passes arbitrary binary bytes to stdin unchanged", async () => {
  const raw = Buffer.from([0x00, 0x89, 0xff, 0x0a, 0x1a, 0x00]);
  let written: Buffer | undefined;
  const run: WslImageCommand = async (args, input) => {
    if (args.includes("mktemp")) return { stdout: "/tmp/wollipog-prompt-images.Bin123\n", stderr: "" };
    if (input) written = input;
    return { stdout: "", stderr: "" };
  };
  const staged = await stagePromptImages(
    [{ mimeType: "image/png", data: raw.toString("base64") }],
    { kind: "wsl", distro: "Ubuntu" },
    run,
  );
  try {
    assert.deepEqual(written, raw);
  } finally {
    await staged.cleanup();
  }
});

test("WSL staging failure removes the partial directory", async () => {
  const calls: string[][] = [];
  const run: WslImageCommand = async (args) => {
    calls.push(args);
    if (args.includes("mktemp")) return { stdout: "/tmp/wollipog-prompt-images.Fail123\n", stderr: "" };
    if (args.some((arg) => arg.includes('cat > "$1"'))) throw new Error("write failed");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(() => stagePromptImages([image()], { kind: "wsl", distro: "Ubuntu" }, run), /write failed/);
  assert.deepEqual(calls.at(-1), ["-d", "Ubuntu", "--exec", "rm", "-rf", "--", "/tmp/wollipog-prompt-images.Fail123"]);
});

test("validation fails before any WSL filesystem command", async () => {
  let calls = 0;
  await assert.rejects(
    () => stagePromptImages([image("image/gif")], { kind: "wsl", distro: "Ubuntu" }, async () => {
      calls++;
      return { stdout: "", stderr: "" };
    }),
    /unsupported MIME/,
  );
  assert.equal(calls, 0);
});
