import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import { ApiError } from "./api.js";
import {
  MACHINE_SKILL_RESULT_FACT,
  MACHINE_SKILL_RESULT_LABEL,
  MATCHING_FOLDER_REASON,
  MATCHING_FOLDER_TITLE,
  adoptionAdvisoryText,
  adoptionBlockerText,
  createRequestQueue,
  machineSkillImportLabel,
  machineSkillLocation,
  machineSkillRowResult,
  runnerCanImportSkills,
  userFacingMachineError,
} from "./skill-machine.js";

test("a machine can import when its runner has the snapshot capability for its platform", () => {
  const cases = [
    ["linux", RUNNER_CAPABILITY_MIN_PROTOCOL.machineSkillSnapshots],
    ["macos", RUNNER_CAPABILITY_MIN_PROTOCOL.nativeMacosMachineSkillSnapshots],
    ["windows", RUNNER_CAPABILITY_MIN_PROTOCOL.nativeWindowsMachineSkillSnapshots],
  ] as const;
  for (const [os, minimum] of cases) {
    assert.equal(runnerCanImportSkills({ os, protocolVersion: minimum }), true, `${os} at its minimum`);
    assert.equal(runnerCanImportSkills({ os, protocolVersion: minimum - 1 }), false, `${os} one below`);
    assert.equal(runnerCanImportSkills({ os, protocolVersion: undefined }), false, `${os} unknown`);
  }
});

test("a row says New Skill for a name the library lacks, In Library until reviewed, then the result", () => {
  const library = new Set(["code-review"]);
  assert.equal(machineSkillRowResult("alpha", undefined, library), "New Skill");
  assert.equal(machineSkillRowResult("code-review", undefined, library), "In Library");
  assert.equal(machineSkillRowResult("code-review", "update", library), "New Version");
  assert.equal(machineSkillRowResult("code-review", "identical", library), "Matches Latest");
  // A review is authoritative even where the library list disagrees (an inaccessible name).
  assert.equal(machineSkillRowResult("alpha", "update", library), "New Version");
});

test("the primary names what importing does", () => {
  assert.equal(machineSkillImportLabel("new"), "Import as New Skill");
  assert.equal(machineSkillImportLabel("update"), "Import as New Version");
  assert.equal(machineSkillImportLabel("identical"), "Import Skill");
  assert.equal(machineSkillImportLabel(undefined), "Import Skill");
});

test("the matched version is named in one place, as the latest version until versions are numbered", () => {
  assert.equal(MACHINE_SKILL_RESULT_LABEL.identical, "Matches Latest");
  assert.equal(MACHINE_SKILL_RESULT_FACT.identical, "Matches the Latest Version");
  assert.equal(MATCHING_FOLDER_TITLE, "This Folder Matches the Latest Version");
  assert.equal(MATCHING_FOLDER_REASON, "This folder matches the latest version; there is nothing to import.");
});

test("a folder's location names its account and WSL distro, never a transport path", () => {
  const runner = { providerAccounts: [{ id: "acct", label: "Work Account", provider: "claude" as const, authStatus: "authenticated" as const }] };
  assert.equal(machineSkillLocation({ name: "review", sourceDirectory: ".codex/skills" }), ".codex/skills/review");
  assert.equal(machineSkillLocation({ name: "review", sourceDirectory: ".codex/skills", context: { kind: "wsl", distro: "Ubuntu" } }),
    "WSL: Ubuntu · .codex/skills/review");
  assert.match(machineSkillLocation({ name: "review", sourceDirectory: ".claude/skills", providerAccountId: "acct" }, runner),
    /^Account: .+ · \.claude\/skills\/review$/u);
});

test("safety-check findings read as sentences, including ones this build does not know", () => {
  assert.equal(adoptionBlockerText("source_not_targeted"), "No assigned agent reads this folder.");
  assert.equal(adoptionBlockerText("brand_new_reason"), "The safety check failed: brand new reason.");
  assert.match(adoptionAdvisoryText("manual_variant_may_change_content"), /manual invocation/u);
  for (const blocker of ["library_skill_missing", "executable_mode_adoption_unsupported", "effective_assignment_missing",
    "assigned_version_mismatch", "library_version_invalid", "source_not_targeted", "invocation_unsupported",
    "manual_variant_adoption_unsupported", "shared_invocation_conflict", "wsl_account_adoption_unsupported",
    "provider_account_scope_unavailable"]) {
    const text = adoptionBlockerText(blocker);
    assert.doesNotMatch(text, /_|protocol/iu, `${blocker} reads as words`);
    assert.match(text, /^[A-Z].*\.$/u, `${blocker} is one sentence`);
  }
});

test("a server refusal phrased with runner protocol numbers becomes the runner-update sentence", () => {
  assert.equal(
    userFacingMachineError(new Error("Machine skill adoption requires runner protocol v115 or newer; this runner is v12."), "Build Machine"),
    "Build Machine needs a runner update to do this.",
  );
  assert.equal(userFacingMachineError(new Error("Source changed. Discover it again."), "Build Machine"), "Source changed. Discover it again.");
});

test("a capability refusal is recognized by its structured versions, not its wording", () => {
  const sentence = "This machine needs a newer runner for machine skill adoption. Update and restart the runner.";
  assert.equal(
    userFacingMachineError(new ApiError(sentence, 409, undefined, {
      error: sentence,
      requiredRunnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.machineSkillAdoption,
      runnerProtocolVersion: 12,
    }), "Build Machine"),
    "Build Machine needs a runner update to do this.",
  );
  assert.equal(
    userFacingMachineError(new ApiError("Machine is offline.", 409, undefined, { error: "Machine is offline." }), "Build Machine"),
    "Machine is offline.",
  );
});

test("machine requests run one at a time, in order, even after a failure, and are counted until they settle", async () => {
  const events: string[] = [];
  const queue = createRequestQueue();
  const run = <T,>(request: () => Promise<T>) => queue.run(request);
  let notified = 0;
  queue.subscribe(() => { notified += 1; });
  const gate = (name: string, fail = false) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const request = async () => {
      events.push(`start ${name}`);
      await released;
      events.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    return { request, release };
  };
  const first = gate("first", true);
  const second = gate("second");
  const firstRun = run(first.request).catch((cause: Error) => `failed ${cause.message}`);
  const secondRun = run(second.request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.pending(), 2, "both are counted while one runs and one waits");
  assert.deepEqual(events, ["start first"], "the second waits for the first");
  first.release();
  assert.equal(await firstRun, "failed first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["start first", "end first", "start second"], "a failure still lets the next one start");
  second.release();
  assert.equal(await secondRun, "second");
  assert.equal(queue.pending(), 0);
  assert.equal(notified, 4, "subscribers hear every change");
});
