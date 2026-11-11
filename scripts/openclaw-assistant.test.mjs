import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { connectionConfig, writeIsolatedProfile } from "./openclaw-assistant.mjs";

const connection = { name: "wollipog-alpha", url: "https://alpha.example/assistant/mcp", tokenEnv: "WOLLIPOG_ALPHA_TOKEN" };

test("remote config retains secret references and refuses ambiguous or credential-bearing endpoints", () => {
  const config = connectionConfig([connection, { ...connection, name: "wollipog-beta", tokenEnv: "WOLLIPOG_BETA_TOKEN" }]);
  assert.equal(config.mcp.servers[connection.name].headers.Authorization, "Bearer ${WOLLIPOG_ALPHA_TOKEN}");
  assert.equal(config.mcp.servers[connection.name].transport, "streamable-http");
  assert.throws(() => connectionConfig([connection, connection]), /unique/);
  for (const url of ["http://remote.example/assistant/mcp", "https://user:secret@alpha.example/assistant/mcp", "https://alpha.example/assistant/mcp?token=secret"]) {
    assert.throws(() => connectionConfig([{ ...connection, url }]), /HTTPS/);
  }
});

test("isolated profile cannot overwrite existing owner state or inherit ambient credentials", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-profile-test-"));
  try {
    const root = path.join(scratch, "dedicated");
    const profile = await writeIsolatedProfile(root, [connection]);
    const configPath = profile.env.OPENCLAW_CONFIG_PATH;
    assert.equal(profile.env.OPENAI_API_KEY, undefined);
    assert.equal(profile.env.WOLLIPOG_SESSION_TOKEN, undefined);
    assert.equal(profile.env.OPENCLAW_STATE_DIR, path.join(root, "state"));
    const saved = await readFile(configPath, "utf8");
    assert.ok(saved.includes("${WOLLIPOG_ALPHA_TOKEN}"));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(writeIsolatedProfile(root, [connection]), { code: "EEXIST" });
    assert.equal(await readFile(configPath, "utf8"), saved);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
