import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import type { AgentTuiProviderHome } from "./shell-manager.js";

/** Record raw calls, not only their idempotent effects, so double settlement cannot hide. */
class RecordingRegistry {
  readonly references: Array<{ home: string; releases: number; retains: number }> = [];
  async acquireReference(request: { env?: Record<string, string> }) {
    const home = request.env?.CODEX_HOME ?? request.env?.CLAUDE_CONFIG_DIR;
    assert.ok(home);
    const reference = { home, releases: 0, retains: 0 };
    this.references.push(reference);
    return {
      first: this.references.length === 1,
      release: async () => { reference.releases++; return true; },
      retain: async () => { reference.retains++; },
    };
  }
  async acquire(): Promise<void> { assert.fail("settlement leaked the TUI handle-budget slot"); }
  stopAcquisitions(): void {}
}

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(provider: "claude" | "codex", orchestrator: boolean) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tui-plugin-retention-"));
  const account = join(root, "account");
  const source = join(root, `.${provider}`);
  const scratch = join(root, "scratch");
  for (const dir of [account, source, scratch]) mkdirSync(dir);
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId: "tui-plugins", agentId: provider, workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: provider === "claude" ? "claude-code" : "codex-app-server", command: provider, args: [],
    env: { HOME: root, [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: account },
    providerCredentialHome: account, providerAccountId: "selected-account", providerAccountProvider: provider,
    context: { kind: "native" }, agentSessionId: null, status: "idle", title: "Fixture",
    config: orchestrator ? { permissionMode: "orchestrator" } : {},
    ...(orchestrator ? { orchestrator: { strictProjectIsolation: false } } : {}),
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    (() => assert.fail("no structured provider should start")) as never, join(root, "data"));
  const registry = new RecordingRegistry();
  const internals = manager as unknown as {
    providerHomeLeases: RecordingRegistry;
    driverProviderHomes: Map<unknown, unknown>;
    agentTuiProviderHomeHandles: number;
  };
  internals.providerHomeLeases = registry;
  const handles: AgentTuiProviderHome[] = [];
  const settlements: Array<boolean | null> = [];
  const dependencies: Parameters<typeof prepareAgentTuiLaunch>[1] = {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    prepareScratch: async () => scratch,
    provision: (prepared) => {
      assert.equal(prepared.providerAccountId, meta.providerAccountId);
      assert.equal(prepared.providerCredentialHome, account);
    },
    acquireProviderHome: async (prepared) => {
      assert.equal(prepared.providerCredentialHome, account);
      const handle = await manager.acquireAgentTuiProviderHome(prepared);
      assert.ok(handle);
      handles.push(handle);
      return { ...handle, settle: async (proof) => { settlements.push(proof); await handle.settle(proof); } };
    },
    assertSessionNotDeleted: () => {},
    provisionManagedWorktreeGuard: () => assert.fail("inheritance must fail before guard/provider startup"),
    probe: async () => assert.fail("inheritance must fail before MCP/provider startup"),
    permissionProfile: async () => assert.fail("inheritance must fail before permission/provider startup"),
  };
  return { root, source, account, meta, manager, registry, internals, handles, settlements, dependencies,
    cleanup() { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); } };
}

/** The first marketplace loses its stale inherited link before enumeration of the second loops. */
function codexPartialFailure(h: ReturnType<typeof fixture>) {
  const first = "a-stale", second = "b-loop";
  const sourceMarket = join(h.source, "plugins/cache", first);
  const accountMarket = join(h.account, "plugins/cache", first);
  mkdirSync(sourceMarket, { recursive: true });
  mkdirSync(accountMarket, { recursive: true });
  const removed = join(accountMarket, "obsolete");
  symlinkSync(join(sourceMarket, "obsolete"), removed, "dir");
  const loop = join(h.source, "plugins/cache", second);
  symlinkSync(loop, loop, "dir");
  writeFileSync(join(h.source, "config.toml"), '[plugins."enabled@b-loop"]\nenabled = true\n');
  assert.deepEqual(readdirSync(join(h.source, "plugins/cache")), [first, second]);
  assert.throws(() => readdirSync(loop), { code: "ELOOP" });
  assert.ok(lstatSync(removed).isSymbolicLink());
  return () => assert.throws(() => lstatSync(removed), { code: "ENOENT" });
}

/** Claude copies one real plugin before refusing the next plugin's operator-owned cache link. */
function claudePartialFailure(h: ReturnType<typeof fixture>) {
  const payload = join(h.source, "plugins/cache/local/copied/1");
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "payload.txt"), "copied before failure");
  json(join(h.source, "plugins/installed_plugins.json"), { version: 2, plugins: {
    "copied@local": [{ scope: "user", installPath: payload, version: "1" }],
    "refused@linked": [{ scope: "user", installPath: payload, version: "1" }],
  } });
  mkdirSync(join(h.account, "plugins/cache"), { recursive: true });
  const linked = join(h.account, "plugins/cache/linked");
  symlinkSync(linked, linked, "dir");
  const copied = join(h.account, "plugins/cache/local/copied/1/payload.txt");
  assert.throws(() => lstatSync(copied), { code: "ENOENT" });
  return () => assert.equal(readFileSync(copied, "utf8"), "copied before failure");
}

for (const orchestrator of [false, true]) {
  for (const provider of ["codex", "claude"] as const) {
    test(`${orchestrator ? "Orchestrator" : "ordinary"} ${provider} TUI retains its exact reference after partial plugin inheritance`,
      { skip: process.platform === "win32" }, async () => {
        const h = fixture(provider, orchestrator);
        try {
          const checkMutation = provider === "codex" ? codexPartialFailure(h) : claudePartialFailure(h);
          // An overlapping consumer on the same HOME must never be settled by this preparation.
          const other = await h.manager.acquireAgentTuiProviderHome(h.meta);
          assert.ok(other);
          // Put the failed preparation in the last available slot to expose a leaked manager budget.
          for (let i = 0; i < 510; i++) h.internals.driverProviderHomes.set({}, {});
          await assert.rejects(prepareAgentTuiLaunch(h.meta, h.dependencies),
            new Error(`${provider === "codex" ? "Codex" : "Claude"} plugin inheritance could not reconcile the account plugin cache.`));
          checkMutation();
          assert.deepEqual(h.settlements, [null], "failed preparation settles once without starting a TUI");
          assert.deepEqual(h.registry.references, [
            { home: h.account, releases: 0, retains: 0 },
            { home: h.account, releases: 0, retains: 1 },
          ], "only the exact acquired reference is retained");
          assert.equal(h.internals.agentTuiProviderHomeHandles, 1, "only the overlapping TUI occupies a slot");
          const next = await h.manager.acquireAgentTuiProviderHome(h.meta);
          assert.ok(next, "the failed preparation freed its handle-budget slot");
          await next.settle(true);
          await h.handles[0]!.settle(null);
          assert.equal(h.registry.references[1]!.retains, 1, "the settled handle is idempotent");
          await other.settle(true);
          assert.equal(h.registry.references[0]!.releases, 1, "the other consumer releases its own reference");
          assert.equal(h.internals.agentTuiProviderHomeHandles, 0);
        } finally { h.internals.driverProviderHomes.clear(); h.cleanup(); }
      });
  }

  test(`${orchestrator ? "Orchestrator" : "ordinary"} successful plugin preparation releases with all process proofs true`, async () => {
    const h = fixture("claude", orchestrator);
    try {
      const launch = await prepareAgentTuiLaunch(h.meta, {
        ...h.dependencies,
        provisionManagedWorktreeGuard: (spec, _cwd, observer) => {
          observer?.onProcess(Promise.resolve(true));
          observer?.onProcess(Promise.resolve(true));
          return { protections: [], args: spec.args, guardActive: true };
        },
      });
      assert.ok(launch?.providerHome);
      assert.deepEqual(h.settlements, [], "the launched TUI still owns its reference");
      await launch.providerHome.settle(true);
      assert.deepEqual(h.registry.references, [{ home: h.account, releases: 1, retains: 0 }]);
      assert.equal(h.internals.agentTuiProviderHomeHandles, 0);
    } finally { h.cleanup(); }
  });
}
