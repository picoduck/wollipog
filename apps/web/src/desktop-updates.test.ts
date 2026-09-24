import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_UPDATE_CHECKED,
  checkForDesktopUpdate,
  installDesktopUpdate,
  openReleasePage,
  readDesktopUpdateStatus,
  updateWarning,
  writeAutomaticUpdateChecks,
  type DesktopUpdateRuntime,
} from "./desktop-updates.js";

const lib = readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/src/lib.rs", import.meta.url)), "utf8");
const updates = readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/src/updates.rs", import.meta.url)), "utf8");
const capabilities = readFileSync(
  fileURLToPath(new URL("../../desktop/src-tauri/capabilities/default.json", import.meta.url)),
  "utf8",
);

function recorder(isTauri = true) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const desktop: DesktopUpdateRuntime = {
    isTauri: () => isTauri,
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return null as T;
    },
  };
  return { calls, desktop };
}

test("every command the dashboard invokes is one the shell registers", async () => {
  const { calls, desktop } = recorder();
  await readDesktopUpdateStatus(desktop);
  await checkForDesktopUpdate(true, desktop);
  await installDesktopUpdate(false, desktop);
  await writeAutomaticUpdateChecks(false, desktop);
  await openReleasePage("https://github.com/picoduck/wollipog/releases/tag/v0.28.0", desktop);
  const handler = lib.slice(lib.indexOf("tauri::generate_handler!["), lib.indexOf("])", lib.indexOf("tauri::generate_handler![")));
  for (const { command } of calls) {
    // Two spellings of one command name is a button that silently does nothing.
    assert.match(handler, new RegExp(`\\b${command}\\b`, "u"), `${command} is not registered by the shell`);
  }
  assert.deepEqual(calls.map(({ args }) => args), [
    undefined,
    { automatic: true },
    { confirmed: false },
    { enabled: false },
    { url: "https://github.com/picoduck/wollipog/releases/tag/v0.28.0" },
  ]);
});

test("a browser never asks a shell it does not have", async () => {
  const { calls, desktop } = recorder(false);
  assert.equal(await readDesktopUpdateStatus(desktop), null);
  assert.equal(calls.length, 0);
});

test("the webview cannot reach the updater plugin around the exit guard", () => {
  // The plugin's own commands install without asking whether work is in flight. Only the shell's
  // `install_desktop_update` holds a restart, so the webview must be granted none of them.
  assert.doesNotMatch(capabilities, /updater:/u);
  // Under the updater's OWN latch: a deferred install must not authorize a later window close.
  assert.match(updates, /let latch = &task_app\.state::<DesktopUpdater>\(\)\.warned_at;\s*forget_unconfirmed_warning\(latch, confirmed\);\s*crate::exit_hold_for_work\(&task_app, latch\)/u);
  assert.match(lib, /let Some\(count\) = exit_hold_for_work\(app, &app\.state::<CloseGuard>\(\)\.warned_at\)/u);
});

test("the check event the Settings hook listens for is the one the shell emits", () => {
  assert.match(updates, new RegExp(`UPDATE_CHECKED_EVENT: &str = "${DESKTOP_UPDATE_CHECKED}"`, "u"));
});

test("the shell's serialized shapes are the ones this file reads", () => {
  // serde renames in updates.rs, spelled as the dashboard's discriminants.
  assert.match(updates, /#\[serde\(tag = "mode", rename_all = "camelCase"\)\]\s*pub\(crate\) enum InstallMode \{\s*InPlace,\s*ReleasePage \{ reason: String \},/u);
  assert.match(updates, /#\[serde\(tag = "state", rename_all = "camelCase"\)\]\s*pub\(crate\) enum UpdateCheck \{\s*Current \{/u);
  assert.match(updates, /#\[serde\(tag = "outcome", rename_all = "camelCase"\)\]\s*pub\(crate\) enum InstallOutcome \{[\s\S]*Current,[\s\S]*HeldForWork \{ sessions: usize \},[\s\S]*Restarting,/u);
  assert.match(updates, /#\[serde\(rename = "checkedAt"\)\]/u);
});

test("the install warning counts sessions and never invents one", () => {
  assert.equal(updateWarning(0), "Agent work may still be running. Installing restarts Wollipog and will stop it.");
  assert.equal(updateWarning(1), "1 session still has work running. Installing restarts Wollipog and will stop it.");
  assert.equal(updateWarning(3), "3 sessions still have work running. Installing restarts Wollipog and will stop them.");
});
