import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../apps/runner/src/config.js";
import { providerStateKey } from "../apps/runner/src/execution-isolation.js";
import {
  anchorTurnRef,
  captureWorktreeTree,
  readTurnRef,
  synchronizeCheckpointRefs,
} from "../apps/runner/src/git-ops.js";
import { reconcileProviderState } from "../apps/runner/src/provider-state-reconciliation.js";
import { SessionStore } from "../apps/runner/src/session-store.js";
import {
  instanceStorageKey,
  legacyBrowserStorageKey,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "../apps/web/src/instance-storage.js";

const LEGACY_RUNNER_TOKEN = `mamr_${"a".repeat(43)}`;

class MemoryStorage {
  values = new Map();

  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "compatibility@example.com"]);
  git(cwd, ["config", "user.name", "Compatibility QA"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
}

function sessionMeta(repoPath) {
  return {
    sessionId: "legacy-session",
    agentId: "codex",
    workspaceId: "repo",
    repoPath,
    worktreePath: null,
    driver: "codex",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "legacy-thread",
    status: "idle",
    title: "Existing session",
    config: {},
    tokensIn: 1,
    tokensOut: 2,
    costUsd: 0,
    preview: "Existing output",
    pendingApproval: null,
    seq: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function withTemporaryHome(home, run) {
  const names = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    });
}

test("current config and runner storage preserve an existing legacy home", async () => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-existing-home-"));
  try {
    await withTemporaryHome(home, async () => {
      const xdgRoot = join(home, ".config");
      const configPath = join(xdgRoot, "agent-manager", "runner.config.json");
      const dataDir = join(home, ".agent-manager");
      const sessionsRoot = join(dataDir, "sessions");
      const sessionRoot = join(sessionsRoot, "legacy-session");
      const repoPath = join(home, "repo");
      const providerTranscript = join(
        dataDir,
        "provider-state",
        "codex",
        providerStateKey("legacy-session"),
        "sessions",
        "legacy-thread.jsonl",
      );
      const configBytes = `${JSON.stringify({
        runnerId: "legacy-runner",
        controlPlaneUrl: "ws://127.0.0.1:4317/runner",
        token: LEGACY_RUNNER_TOKEN,
        workspaces: [{ id: "repo", name: "Repo", path: repoPath }],
        agents: [{ id: "codex", name: "Codex", command: "codex", driver: "codex" }],
      }, null, 2)}\n`;
      const eventBytes = `${JSON.stringify({
        seq: 1,
        ts: 2,
        payload: { kind: "agent_message", text: "Existing output" },
      })}\n`;
      const providerBytes = "{\"type\":\"response_item\",\"text\":\"preserve me\"}\n";

      mkdirSync(dirname(configPath), { recursive: true });
      mkdirSync(sessionRoot, { recursive: true });
      mkdirSync(dirname(providerTranscript), { recursive: true });
      writeFileSync(configPath, configBytes);
      writeFileSync(join(sessionRoot, "meta.json"), JSON.stringify(sessionMeta(repoPath)));
      writeFileSync(join(sessionRoot, "events.ndjson"), eventBytes);
      writeFileSync(providerTranscript, providerBytes);

      const config = loadConfig(configPath, {}, true);
      assert.equal(config.token, LEGACY_RUNNER_TOKEN);
      assert.equal(config.dataDir, dataDir, "the established .agent-manager data root remains authoritative");
      assert.equal(config.workspaces[0]?.path, repoPath);

      const store = new SessionStore(join(config.dataDir, "sessions"));
      assert.equal(store.readMeta("legacy-session")?.agentSessionId, "legacy-thread");
      assert.deepEqual(store.readEvents("legacy-session").map((event) => event.payload), [
        { kind: "agent_message", text: "Existing output" },
      ]);

      const reconciled = await reconcileProviderState(
        config.executionIsolation,
        config.dataDir,
        store.listSessions(),
        providerStateKey(config.runnerId),
      );
      assert.deepEqual(reconciled.removed, []);
      assert.deepEqual(reconciled.errors, []);
      assert.equal(readFileSync(providerTranscript, "utf8"), providerBytes);
      assert.equal(readFileSync(configPath, "utf8"), configBytes, "credential-bearing legacy config stays byte-identical");
      assert.equal(readFileSync(join(sessionRoot, "events.ndjson"), "utf8"), eventBytes);
      assert.equal(existsSync(join(dataDir, "provider-state", "codex", providerStateKey("legacy-session"))), true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh, upgrade, rollback, and re-upgrade keep storage and real Git compatibility boundaries", {
  skip: !gitAvailable(),
}, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-compatibility-window-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "state.txt"), "first\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    const firstTree = await captureWorktreeTree(repo);

    // Fresh current installs write only current browser identities while checkpoint producers
    // intentionally dual-write the rollback namespace during the compatibility window.
    const freshStorage = new MemoryStorage();
    assert.equal(saveInstanceStorageValue("wollipog.sessions.seen", "fresh", "local", freshStorage), true);
    assert.equal(freshStorage.values.get(instanceStorageKey("wollipog.sessions.seen")), "fresh");
    assert.equal([...freshStorage.values.keys()].some((key) => key.startsWith("mam.")), false);
    await anchorTurnRef(repo, "fresh-session", 1, firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/fresh-session/turn-1"]), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/fresh-session/turn-1"]), firstTree);

    // An upgraded install copies legacy browser state forward without deleting rollback input and
    // mirrors a one-sided legacy checkpoint into the canonical namespace.
    const upgradedStorage = new MemoryStorage();
    const logicalKey = "wollipog.sessions.seen";
    const legacyKey = legacyBrowserStorageKey(logicalKey);
    upgradedStorage.setItem(legacyKey, "before-upgrade");
    git(repo, ["update-ref", "refs/mam/upgraded-session/turn-1", firstTree]);
    assert.equal(loadInstanceStorageValue(logicalKey, "local", upgradedStorage), "before-upgrade");
    assert.equal(upgradedStorage.values.get(instanceStorageKey(logicalKey)), "before-upgrade");
    assert.equal(upgradedStorage.values.get(legacyKey), "before-upgrade");
    assert.equal(await readTurnRef(repo, "upgraded-session", 1), firstTree);
    assert.deepEqual(await synchronizeCheckpointRefs(repo, "upgraded-session"), {
      mirroredToCurrent: 1,
      mirroredToLegacy: 0,
      conflicts: [],
    });
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/upgraded-session/turn-1"]), firstTree);

    // A rolled-back build can still read and change its retained browser key. Current-first
    // storage deliberately keeps the already-migrated value, while checkpoint divergence is a
    // correctness boundary and must fail closed instead of silently choosing either tree.
    upgradedStorage.setItem(legacyKey, "changed-during-rollback");
    writeFileSync(join(repo, "state.txt"), "second\n");
    const secondTree = await captureWorktreeTree(repo);
    git(repo, ["update-ref", "refs/mam/upgraded-session/turn-1", secondTree]);
    assert.equal(loadInstanceStorageValue(logicalKey, "local", upgradedStorage), "before-upgrade");
    assert.equal(upgradedStorage.values.get(legacyKey), "changed-during-rollback");
    await assert.rejects(
      readTurnRef(repo, "upgraded-session", 1),
      /checkpoint refs diverged.*upgraded-session turn 1/,
    );

    // Once the stale canonical side is absent, re-upgrade reconciliation can safely mirror the
    // rollback-owned legacy tree and restore dual visibility without guessing through divergence.
    git(repo, ["update-ref", "-d", "refs/wollipog/upgraded-session/turn-1"]);
    assert.deepEqual(await synchronizeCheckpointRefs(repo, "upgraded-session"), {
      mirroredToCurrent: 1,
      mirroredToLegacy: 0,
      conflicts: [],
    });
    assert.equal(await readTurnRef(repo, "upgraded-session", 1), secondTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/upgraded-session/turn-1"]), secondTree);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
