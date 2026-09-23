import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHarnessLaunchCommand } from "./harness-command.js";

test("launch guidance quotes every argument in the stated native or WSL shell", () => {
  assert.deepEqual(formatHarnessLaunchCommand("/opt/My Tools/node", ["/opt/Agent's CLI/main.js", "two words"],
    { kind: "native" }, "linux"), {
    command: "'/opt/My Tools/node' '/opt/Agent'\"'\"'s CLI/main.js' 'two words'",
    shell: "a POSIX shell on this Machine",
  });
  assert.deepEqual(formatHarnessLaunchCommand("/opt/My Tools/node", ["/opt/Agent's CLI/main.js"],
    { kind: "wsl", distro: "Team Ubuntu" }, "windows"), {
    command: "'/opt/My Tools/node' '/opt/Agent'\"'\"'s CLI/main.js'",
    shell: "a POSIX shell inside WSL: Team Ubuntu",
  });
  assert.deepEqual(formatHarnessLaunchCommand("C:\\Program Files\\Codex\\codex.exe", ["O'Brien", "Team’s Profile"],
    { kind: "native" }, "windows"), {
    command: "& 'C:\\Program Files\\Codex\\codex.exe' 'O''Brien' 'Team’’s Profile'",
    shell: "PowerShell 7.3 or later on this Machine",
  });
});
