// Inert provider/command conformance fixture. No provider SDK, credentials or network.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [moduleUrl, encoded] = process.argv.slice(2);
const policy = JSON.parse(encoded);
const { createPiCommandHomePrototype } = await import(moduleUrl);
// This fixture proves the production operations backend's OS topology, NOT a real Pi runtime.
// The separate source audit/eligibility tests do not turn this synthetic installation into Pi.
const backend = createPiCommandHomePrototype(policy, { auditInstallation: () => true });
const home = policy.providerHome, cwd = policy.outer.protectedWorktree.path;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function command(text, signal) {
  let output = "";
  const result = await backend.exec(text, cwd, { onData: data => { output += data; }, signal,
    env: { HOME: home, PATH: "/usr/bin:/bin" } });
  return { ...result, output };
}
const probe = await command("printf prototype-started");
if (probe.exitCode !== 0 && /(?:No permissions to create new namespace|Operation not permitted|Permission denied)/u.test(probe.output)) {
  console.log("PI_COMMAND_HOME_UNAVAILABLE: nested namespace refused");
} else {
  assert.equal(probe.exitCode, 0, probe.output);
  const auth = `${home}/auth.json`;
  // The provider itself retains temp-file-and-rename refresh and state/config writes.
  writeFileSync(`${auth}.temp`, "provider-refresh"); renameSync(`${auth}.temp`, auth);
  mkdirSync(`${home}/sessions`, { recursive: true });
  writeFileSync(`${home}/sessions/transcript.jsonl`, "provider-transcript");
  writeFileSync(`${home}/settings.json`, "provider-config-value");
  writeFileSync(`${home}/settings.batch`, "provider-config-batch");
  writeFileSync(`${home}/skills.config`, "provider-skills-config");
  for (const text of [
    `printf overwrite > ${quote(auth)}`,
    `printf create > ${quote(`${home}/new-file`)}`,
    `rm ${quote(auth)}`,
    `printf replacement > ${quote(`${cwd}/replacement`)} && mv ${quote(`${cwd}/replacement`)} ${quote(auth)}`,
    `printf alias > ${quote(`${cwd}/home-alias/auth.json`)}`,
    `${quote(policy.shell)} -c ${quote(`printf descendant > ${quote(auth)}`)}`,
  ]) {
    const result = await command(text);
    assert.notEqual(result.exitCode, 0, `command write was not denied: ${text}`);
    assert.equal(readFileSync(auth, "utf8"), "provider-refresh");
  }
  const read = await command(`cat ${quote(auth)}`);
  assert.equal(read.exitCode, 0); assert.equal(read.output, "provider-refresh");
  assert.equal((await command(`printf worktree > ${quote(`${cwd}/allowed`)}`)).exitCode, 0);
  assert.equal(readFileSync(`${cwd}/allowed`, "utf8"), "worktree");
  assert.equal(readFileSync(`${home}/sessions/transcript.jsonl`, "utf8"), "provider-transcript");
  assert.equal(readFileSync(`${home}/settings.json`, "utf8"), "provider-config-value");
  assert.equal(readFileSync(`${home}/settings.batch`, "utf8"), "provider-config-batch");
  assert.equal(readFileSync(`${home}/skills.config`, "utf8"), "provider-skills-config");
  const controller = new AbortController();
  const pending = command("sleep 30", controller.signal);
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(pending, /cancelled|command-tree exit/u); }
  finally { clearTimeout(timer); }
  console.log("PI_COMMAND_HOME_SYNTHETIC_CONFORMANCE: passed");
}
