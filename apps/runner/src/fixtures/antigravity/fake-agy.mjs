// Synthetic, credential-free stand-in for Google's `agy` CLI used by antigravity-setup tests.
// It is NOT captured from a real Antigravity CLI: Google does not document the sign-in output,
// exit codes or session errors, so it models only the documented shape (an https sign-in link,
// a pasted code, ACP protocol v1 over stdio, and "Authentication required" as error -32000).
//
// FAKE_AGY_STATE: directory holding the fake sign-in marker and any probe output.
// FAKE_AGY_MODE: comma-separated behaviors (see below). Defaults to a working CLI.
// FAKE_AGY_VERSION: the version `--version` prints. A fake managed release (fake-release.ts) sets
// it, and its own FAKE_AGY_MODE, in the wrapper script inside its archive.
// FAKE_AGY_LABEL: names the copy (for example a managed release) in environments.jsonl.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const state = process.env.FAKE_AGY_STATE;
const modes = new Set((process.env.FAKE_AGY_MODE ?? "").split(",").filter(Boolean));
const signedInMarker = state ? join(state, "signed-in") : undefined;
const args = process.argv.slice(2);
const AMBIENT = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];

function recordEnvironment(label) {
  if (!state) return;
  const present = AMBIENT.filter((name) => process.env[name] !== undefined);
  appendFileSync(join(state, "environments.jsonl"), `${JSON.stringify({
    label, copy: process.env.FAKE_AGY_LABEL ?? "path", present, home: process.env.HOME ?? null,
    autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
    runtimeDir: process.env.XDG_RUNTIME_DIR ?? null, sessionBus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
  })}\n`);
}

if (args[0] === "--version") {
  recordEnvironment("version");
  if (modes.has("version_fail")) process.exit(3);
  // A release that works only in the install's staging scratch HOME, not the runner user's own.
  if (modes.has("version_fail_outside_staging") && !(process.env.HOME ?? "").includes("/antigravity-managed/staging/")) process.exit(3);
  process.stdout.write(modes.has("version_garbled") ? "antigravity cli\n" : `agy ${process.env.FAKE_AGY_VERSION ?? "1.4.2"} (fixture)\n`);
  process.exit(0);
}

if (args[0] === "acp" && args[1] === "--help") {
  recordEnvironment("acp_help");
  if (modes.has("acp_help_fail")) {
    process.stderr.write("unknown command\n");
    process.exit(2);
  }
  process.stdout.write("Usage: agy acp [--login]\n");
  process.exit(0);
}

if (args[0] === "acp" && args[1] === "--login") {
  recordEnvironment("login");
  if (modes.has("login_no_link")) {
    process.stdout.write("Starting sign-in...\n");
    setInterval(() => {}, 1_000);
  } else {
    const link = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=fixture-state";
    const prompt = () => process.stdout.write(".\nPaste the authorization code: ");
    process.stdout.write("\u001b[1mSign in with Google\u001b[0m\nOpen this link in a browser:\n");
    if (modes.has("login_ansi_split")) {
      // A style reset between the path and the query, with the chunk cut right after its ESC byte.
      const query = link.indexOf("?");
      process.stdout.write(`${link.slice(0, query)}\u001b`);
      setTimeout(() => { process.stdout.write(`[0m${link.slice(query)}`); prompt(); }, 300);
    } else if (modes.has("login_split_url")) {
      // The link arrives in two writes, cut inside its query string.
      process.stdout.write(link.slice(0, 50));
      setTimeout(() => { process.stdout.write(link.slice(50)); prompt(); }, 300);
    } else {
      process.stdout.write(link);
      prompt();
    }
    const lines = createInterface({ input: process.stdin });
    lines.once("line", (code) => {
      lines.close();
      // A diagnostic that echoes the submitted code inside another link.
      if (modes.has("login_echo_code")) process.stdout.write(`Verifying at https://accounts.google.com/debug?code=${code.trim()}\n`);
      if (modes.has("login_exit0_unverified")) { process.stdout.write("Done.\n"); process.exit(0); }
      if (code.trim() === "FIXTURE-GOOD-CODE") {
        if (signedInMarker) writeFileSync(signedInMarker, "fixture");
        process.stdout.write("Signed in.\n");
        // Exit after a pause, so a link printed above has time to be read before the exit settles.
        setTimeout(() => process.exit(0), modes.has("login_echo_code") ? 200 : 0);
        return;
      }
      process.stdout.write("The code was rejected or has expired.\n");
      process.exit(1);
    });
  }
} else if (args[0] === "acp") {
  recordEnvironment("acp");
  if (modes.has("acp_exit")) process.exit(2);
  const lines = createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      // Valid JSON that is not a JSON-RPC message.
      if (modes.has("acp_null")) process.stdout.write("null\n5\n[]\n");
      if (modes.has("handshake_hang")) return;
      if (modes.has("handshake_bad")) return send({ id: request.id, result: { protocolVersion: 99 } });
      return send({ id: request.id, result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "fixture" },
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      } });
    }
    if (request.method === "session/new") {
      if (modes.has("session_hang")) return;
      if (modes.has("session_error")) return send({ id: request.id, error: { code: -32603, message: "internal error" } });
      // A release that asks for a new sign-in even where the existing one works.
      if (modes.has("session_auth_required")) return send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
      if (!signedInMarker || !existsSync(signedInMarker)) {
        return send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
      }
      if (modes.has("session_no_models")) return send({ id: request.id, result: { sessionId: "fixture-session" } });
      if (modes.has("session_long_model")) {
        return send({ id: request.id, result: { sessionId: "fixture-session", models: {
          currentModelId: "m".repeat(161), availableModels: [{ modelId: "m".repeat(161) }],
        } } });
      }
      if (modes.has("session_model_state")) {
        return send({ id: request.id, result: { sessionId: "fixture-session", models: {
          currentModelId: "fixture-pro",
          availableModels: [{ modelId: "fixture-pro", name: "Fixture Pro" }, { modelId: "fixture-flash", name: "Fixture Flash" }],
        } } });
      }
      return send({ id: request.id, result: { sessionId: "fixture-session", configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: "fixture-pro",
        options: [{ value: "fixture-pro", name: "Fixture Pro" }, { value: "fixture-flash", name: "Fixture Flash" }],
      }] } });
    }
    send({ id: request.id, error: { code: -32601, message: "method not found" } });
  });
} else {
  process.stderr.write("unknown fixture command\n");
  process.exit(64);
}
