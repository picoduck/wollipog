import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TESTED_OPENCLAW_VERSION } from "../integrations/openclaw-discord/index.mjs";

const host = process.argv[2];
if (!host || !isAbsolute(host)) throw new Error("Pass the absolute installed OpenClaw package directory.");
const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
if (version !== TESTED_OPENCLAW_VERSION) throw new Error("This native component has not been tested with the supplied host version.");
const root = mkdtempSync(join(tmpdir(), "wollipog-openclaw-native-"));
const profile = "wollipog-native-verification", state = join(root, "state"), privateRoot = join(state, "private");
const pluginRoot = fileURLToPath(new URL("../integrations/openclaw-discord/", import.meta.url));
mkdirSync(privateRoot, {recursive: true, mode: 0o700});
const configPath = join(state, "openclaw.json"), privateConfig = join(privateRoot, "native.json");
writeFileSync(privateConfig, JSON.stringify({version: 1, connections: []}), {mode: 0o600});
writeFileSync(configPath, JSON.stringify({gateway: {mode: "local"}, tools: {profile: "minimal"}, plugins: {allow: ["wollipog-assistant-discord"],
  load: {paths: [pluginRoot]}, entries: {"wollipog-assistant-discord": {enabled: true, config: {profile, configPath: privateConfig}}}}}), {mode: 0o600});
const env = {OPENCLAW_HOME: root, OPENCLAW_PROFILE: profile, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
  PATH: process.env.PATH ?? "", LANG: "C.UTF-8", NO_COLOR: "1"};
let proof;
try {
  const run = args => JSON.parse(execFileSync(process.execPath, [join(host, "openclaw.mjs"), "--profile", profile, ...args],
    {env, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]}));
  const inspection = run(["plugins", "inspect", "wollipog-assistant-discord", "--runtime", "--json"]);
  if (inspection.plugin?.status !== "loaded" || !inspection.commands?.includes("wollipog") || inspection.tools?.length) {
    throw new Error("The native command did not load with the expected tool-free registration.");
  }
  // This is installation/registration evidence only. It starts no Gateway, installs no Discord
  // bot, issues no live credential and invokes no host command with a real user's identity.
  proof = {hostVersion: version, status: inspection.plugin.status, commands: inspection.commands,
    modelTools: inspection.tools, diagnostics: inspection.diagnostics};
} finally {rmSync(root, {recursive: true, force: true});}
console.log(JSON.stringify({...proof, isolatedProfileRemoved: !existsSync(root)}, null, 2));
