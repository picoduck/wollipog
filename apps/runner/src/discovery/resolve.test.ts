import assert from "node:assert/strict";
import { test } from "node:test";
import { launchForVersionManagerHit, run, sortVersionsDesc, wslInspectArgs, wslVersionManagerArgs } from "./resolve.js";
import { interpretCodexAppServerProbe } from "./codex-app-server.js";

test("run preserves a string execFile error code for retryable spawn diagnostics", async () => {
  const result = await run("__wollipog_command_that_does_not_exist__", [], { timeoutMs: 1000 });
  assert.equal(result.code, 1);
  assert.equal(result.errorCode, "ENOENT");
});

test("run distinguishes actual timeouts from max-buffer termination", async () => {
  const timeout = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 25 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.errorCode, undefined);

  const overflow = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 32 });
  assert.equal(overflow.timedOut, undefined);
  assert.equal(overflow.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(interpretCodexAppServerProbe("0.144.1", overflow).failure?.code, "probe_failed");
});

test("sortVersionsDesc: numeric semver order, not lexicographic", () => {
  assert.deepEqual(sortVersionsDesc(["v9.0.0", "v25.2.1", "v10.1.0"]), ["v25.2.1", "v10.1.0", "v9.0.0"]);
  assert.deepEqual(sortVersionsDesc(["20.11.1", "20.9.0"]), ["20.11.1", "20.9.0"]); // no leading v
  assert.deepEqual(sortVersionsDesc(["v1.0.0", "junk", "v2.0.0"]), ["v2.0.0", "v1.0.0", "junk"]); // non-semver sinks
  assert.deepEqual(sortVersionsDesc([]), []);
});

test("launchForVersionManagerHit: node scripts wrap, real binaries run direct", () => {
  const node = "/h/.nvm/versions/node/v25.2.1/bin/node";
  const shim = "/h/.nvm/versions/node/v25.2.1/bin/codex";

  // npm shim: symlink resolves to a .js entry — wrap with the sibling node.
  const js = launchForVersionManagerHit(shim, "/h/.nvm/.../codex/bin/codex.js", "#!/usr/bin/env node", node);
  assert.deepEqual(js, { command: node, args: ["/h/.nvm/.../codex/bin/codex.js"] });

  // extension-less script with a node shebang still wraps.
  const shebang = launchForVersionManagerHit(shim, "/h/lib/codex-entry", "#!/usr/bin/env node", node);
  assert.equal(shebang.command, node);

  // a real (ELF) binary runs directly — garbage first line, no .js extension.
  const bin = launchForVersionManagerHit(shim, shim, "ELF...", node);
  assert.deepEqual(bin, { command: shim, args: [] });

  // node script but no sibling node available — fall back to direct (best effort).
  const noNode = launchForVersionManagerHit(shim, "/h/lib/codex.js", "#!/usr/bin/env node", null);
  assert.deepEqual(noNode, { command: shim, args: [] });
});

test("wslVersionManagerArgs: name rides as a positional arg, never inside the script", () => {
  const hostile = 'codex"; rm -rf ~; echo "';
  const args = wslVersionManagerArgs("Ubuntu-24.04", hostile);
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu-24.04", "--exec", "sh", "-c"]);
  const script = args[5]!;
  assert.ok(!script.includes(hostile), "name never interpolated into the script");
  assert.ok(script.includes('"$d/$1"'), "name consumed as $1");
  assert.ok(script.includes("sort -rV"), "newest version first");
  assert.ok(script.includes(".nvm/versions/node") && script.includes("fnm/node-versions"), "scans nvm + fnm");
  assert.equal(args[6], "sh"); // $0 placeholder
  assert.equal(args[7], hostile);
});

test("wslInspectArgs: the inspected path rides as a positional arg, never inside the script", () => {
  const hostile = "/home/u/.nvm/versions/node/v20.0.0/bin/$(rm -rf ~)/codex";
  const args = wslInspectArgs("Ubuntu", hostile);
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "--exec", "sh", "-c"]);
  assert.ok(!args[5]!.includes(hostile), "path never interpolated into the script");
  assert.ok(args[5]!.includes('"$1"'), "path consumed as $1");
  assert.ok(args[5]!.includes("readlink -f"), "resolves the exact hit, not a scan");
  assert.equal(args[6], "sh"); // $0 placeholder
  assert.equal(args[7], hostile);
});
