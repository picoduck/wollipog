import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHarnessLaunchCommand } from "./harness-command.js";

test("launch guidance quotes every argument in the stated native or WSL shell", () => {
  assert.deepEqual(formatHarnessLaunchCommand("/opt/My Tools/node", ["/opt/Agent's CLI/main.js", "two words"],
    { kind: "native" }, "linux"), {
    command: "'/opt/My Tools/node' '/opt/Agent'\"'\"'s CLI/main.js' 'two words'",
    shell: "POSIX shell on this Machine",
  });
  assert.deepEqual(formatHarnessLaunchCommand("/opt/My Tools/node", ["/opt/Agent's CLI/main.js"],
    { kind: "wsl", distro: "Team Ubuntu" }, "windows"), {
    command: "'/opt/My Tools/node' '/opt/Agent'\"'\"'s CLI/main.js'",
    shell: "POSIX shell inside WSL: Team Ubuntu",
  });
  assert.deepEqual(formatHarnessLaunchCommand("C:\\Program Files\\Codex\\codex.exe", ["O'Brien", "two words"],
    { kind: "native" }, "windows"), {
    command: "& 'C:\\Program Files\\Codex\\codex.exe' 'O''Brien' 'two words'",
    shell: "PowerShell on this Machine",
  });
});
