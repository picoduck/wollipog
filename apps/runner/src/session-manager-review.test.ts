import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ReviewSessionUpdate, RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
import type { DriverOptions } from "./drivers/driver.js";
import { ReviewScopeRefusal } from "./review-snapshot.js";
import { reviewLaunchArgs, type ReviewSessionHooks } from "./review-sessions.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const HEAD = "c".repeat(40);
const OUTPUT = JSON.stringify({ schema_version: 2, vote: "UPVOTE" });

interface Harness {
  root: string;
  checkout: string;
  store: SessionStore;
  manager: SessionManager;
  sent: RunnerToControlPlane[];
  drivers: Array<{ options: DriverOptions; prompts: string[]; disposed: boolean }>;
  released: string[];
  prepared: Array<{ sessionId: string; brief: string }>;
  finishTurn(): void;
  updates(): ReviewSessionUpdate[];
}

function reviewSpec(overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return {
    sessionId: "s_review", agentId: "claude", workspaceId: "repo", workspacePath: "/requester/repo",
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    config: { permissionMode: "bypassPermissions" },
    review: { requesterSessionId: "s_requester", pullRequest: { repository: "acme/widget", number: 7 }, headSha: HEAD, harness: "claude-code" },
    ...overrides,
  };
}

/** A runner whose session slots, per-agent limit and active turns are already all taken. */
function harness(t: { after(fn: () => void): void }, options: {
  prepare?: ReviewSessionHooks["prepare"];
  output?: string | null;
  stop?: "end_turn" | "refusal";
  /** The turn finishes only when cancelled or finished explicitly. */
  hold?: boolean;
  /** Outcomes recorded for reviews that ended before their session was persisted. */
  outcomes?: ReviewSessionUpdate[];
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkouts", "s_review");
  mkdirSync(checkout, { recursive: true });
  const store = new SessionStore(join(root, "sessions"));
  const sent: RunnerToControlPlane[] = [];
  const drivers: Harness["drivers"] = [];
  let finish: (() => void) | undefined;
  const manager = new SessionManager(
    (message) => sent.push(message),
    () => {},
    store,
    "runner",
    (driver, _context, agentId) => agentId === "claude" && driver === "claude-code" ? { command: "claude", args: [], env: {} } : null,
    ((_kind: string, driverOptions: DriverOptions) => {
      const record = { options: driverOptions, prompts: [] as string[], disposed: false };
      drivers.push(record);
      return {
        pid: 1,
        initialize: async () => {},
        newSession: async () => "provider-session",
        prompt: async (text: string) => {
          record.prompts.push(text);
          await new Promise<void>((resolve) => { finish = resolve; if (!options.hold) resolve(); });
          return options.stop ?? "end_turn";
        },
        reviewOutput: () => options.output === undefined ? OUTPUT : options.output,
        cancel: () => finish?.(),
        dispose: () => { record.disposed = true; },
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => "provider-session",
      };
    }) as never,
    root,
    1,
    undefined,
    undefined,
    { agentLimits: { claude: 1 }, agentWeights: {}, activeTurnLimit: 1 },
  );
  t.after(() => manager.shutdownAll());
  const released: string[] = [];
  const prepared: Harness["prepared"] = [];
  const preparing: string[] = [];
  const recorded: ReviewSessionUpdate[] = [];
  manager.setReviewSessions({
    markPreparing: (sessionId) => { preparing.push(sessionId); },
    recordOutcome: (update) => { recorded.push(update); released.push(update.sessionId); },
    outcomes: () => [...(options.outcomes ?? []), ...recorded],
    prepare: options.prepare ?? (async (sessionId, _policy, launch, brief) => {
      assert.deepEqual(launch, { driver: "claude-code", agentId: "claude", command: "claude" }, "the authorized launch is re-verified");
      prepared.push({ sessionId, brief });
      return { checkout, prompt: "REVIEW PROMPT", baseSha: "b".repeat(40) };
    }),
    launchArgs: reviewLaunchArgs,
    release: (sessionId) => released.push(sessionId),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  assert.equal(internals.boxAdmission.acquire({ sessionId: "holder", agentId: "claude", weight: 1, agentLimit: 1 }), true);
  assert.equal(internals.activeTurnAdmission.acquire({ sessionId: "holder", agentId: "claude", weight: 1 }), true);
  return {
    root, checkout, store, manager, sent, drivers, released, prepared,
    finishTurn: () => finish?.(),
    updates: () => sent.filter((message): message is ReviewSessionUpdate => message.type === "review_session_update"),
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a review session launches past full capacity, read-only in its checkout, and reports its one output", async (t) => {
  const h = harness(t);
  assert.equal(await h.manager.start(reviewSpec(), "Intent and checks."), true);
  await until(() => h.updates().length > 0, "the review outcome");
  assert.deepEqual(h.prepared, [{ sessionId: "s_review", brief: "Intent and checks." }]);
  const [driver] = h.drivers;
  assert.ok(driver, "the reviewer launched although every slot, agent limit and active turn was taken");
  assert.equal(driver.options.cwd, h.checkout);
  assert.equal(driver.options.config.permissionMode, "dontAsk");
  assert.equal(driver.options.review, true);
  assert.equal(driver.options.artifactGuidance, "");
  assert.equal(driver.options.isolation, undefined, "outside every runner sandbox");
  assert.deepEqual(driver.options.args, reviewLaunchArgs("claude-code", h.checkout));
  assert.deepEqual(driver.prompts, ["REVIEW PROMPT"]);
  assert.deepEqual(h.updates(), [{ type: "review_session_update", sessionId: "s_review", state: "completed", output: OUTPUT }]);
  const meta = h.store.readMeta("s_review")!;
  assert.equal(meta.review?.checkout, h.checkout);
  assert.equal(meta.review?.update?.state, "completed");
  assert.equal(meta.repoPath, h.checkout);
  assert.deepEqual(h.released, ["s_review"]);
  await until(() => h.store.readMeta("s_review")?.status === "stopped", "the provider stop");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((h.manager as any).admitted.has("s_review"), false, "no runner slot was taken");
  assert.deepEqual(h.manager.reviewSessionUpdates(), h.updates(), "the outcome is re-sent at registration");
});

test("an ordinary start never replaces a review session, and nothing else opens on it", async (t) => {
  const h = harness(t);
  assert.equal(await h.manager.start(reviewSpec(), "brief"), true);
  await until(() => h.updates().length > 0, "the review outcome");
  const { review: _review, ...ordinary } = reviewSpec({ config: { permissionMode: "bypassPermissions" } });
  assert.equal(await h.manager.start(ordinary, "now implement it"), false);
  assert.equal(h.drivers.length, 1, "no ordinary provider launched");
  assert.equal(h.store.readMeta("s_review")?.review?.update?.state, "completed", "the review kind and outcome stand");
  assert.equal(h.manager.sessionCanOpen("s_review"), false, "no shell, Native TUI or worktree operation opens on it");
});

test("outcomes recorded before a session existed are re-sent at registration", (t) => {
  const lost = { type: "review_session_update" as const, sessionId: "s_lost", state: "failed" as const,
    reason: "the review session ended when its runner restarted" };
  const h = harness(t, { outcomes: [lost] });
  assert.deepEqual(h.manager.reviewSessionUpdates(), [lost]);
});

test("a review refused before its session exists keeps a durable outcome to re-send", async (t) => {
  const h = harness(t, { prepare: async () => { throw new ReviewScopeRefusal("the requested head is not the pull request's pushed head"); } });
  assert.equal(await h.manager.start(reviewSpec(), "brief"), false);
  assert.deepEqual(h.manager.reviewSessionUpdates(), [{
    type: "review_session_update", sessionId: "s_review", state: "failed", reason: "the requested head is not the pull request's pushed head",
  }], "a lost frame is re-sent at the next registration");
});

test("a review session takes no further prompts and is never relaunched", async (t) => {
  const h = harness(t);
  assert.equal(await h.manager.start(reviewSpec(), "brief"), true);
  await until(() => h.updates().length > 0, "the review outcome");
  assert.equal(h.manager.prompt("s_review", "now implement the fix"), false);
  assert.equal(await h.manager.start(reviewSpec(), "brief"), false);
  assert.equal(h.drivers.length, 1);
  assert.equal(h.store.readMeta("s_review")?.review?.update?.state, "completed", "the first outcome stands");
});

test("a turn without structured output or with a refusal fails the review", async (t) => {
  const empty = harness(t, { output: null });
  assert.equal(await empty.manager.start(reviewSpec(), "brief"), true);
  await until(() => empty.updates().length > 0, "the empty outcome");
  assert.deepEqual(empty.updates(), [{
    type: "review_session_update", sessionId: "s_review", state: "failed", reason: "the review ended without a result",
  }]);
  const refused = harness(t, { stop: "refusal" });
  assert.equal(await refused.manager.start(reviewSpec(), "brief"), true);
  await until(() => refused.updates().length > 0, "the refused outcome");
  assert.equal(refused.updates()[0]?.state, "failed");
});

test("stopping a running review cancels it once, and a later outcome changes nothing", async (t) => {
  const h = harness(t, { hold: true });
  // A prompt that only finishes when cancelled.
  const pending = h.manager.start(reviewSpec(), "brief");
  await until(() => (h.drivers[0]?.prompts.length ?? 0) > 0, "the review turn");
  h.manager.stop("s_review");
  await pending;
  await until(() => h.updates().length > 0, "the cancellation");
  assert.deepEqual(h.updates(), [{
    type: "review_session_update", sessionId: "s_review", state: "cancelled", reason: "the review was cancelled",
  }]);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(h.updates().length, 1);
});

test("a stop that arrives while the snapshot is prepared cancels the review before it launches", async (t) => {
  let release!: () => void;
  const h = harness(t, {
    prepare: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { checkout: "/never", prompt: "P", baseSha: "b".repeat(40) };
    },
  });
  const pending = h.manager.start(reviewSpec(), "brief");
  await until(() => release !== undefined, "the preparation");
  // A duplicate start while it prepares is refused without touching the first launch's resources.
  assert.equal(await h.manager.start(reviewSpec(), "brief"), false);
  assert.deepEqual(h.released, []);
  assert.deepEqual(h.updates(), []);
  h.manager.stop("s_review");
  // An unrelated stop of an unknown session leaves nothing behind.
  h.manager.stop("s_unrelated");
  release();
  assert.equal(await pending, false);
  assert.equal(h.drivers.length, 0, "nothing launched");
  assert.deepEqual(h.released, ["s_review"]);
  assert.deepEqual(h.updates(), [{
    type: "review_session_update", sessionId: "s_review", state: "cancelled", reason: "the review was cancelled",
  }]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.manager as any;
  assert.equal(internals.reviewsStoppedBeforeLaunch.size, 0);
  assert.equal(internals.reviewsPreparing.size, 0);
});

test("a review launch the runner cannot honor is refused and reported before anything runs", async (t) => {
  for (const [overrides, reason] of [
    [{ useWorktree: true }, "the runner cannot launch this reviewer"],
    [{ context: { kind: "wsl", distro: "Ubuntu" } }, "the runner cannot launch this reviewer"],
    [{ orchestrator: { strictProjectIsolation: true } }, "the runner cannot launch this reviewer"],
    [{ args: ["--dangerously-skip-permissions"] }, "the runner cannot launch this reviewer"],
  ] as const) {
    const h = harness(t);
    assert.equal(await h.manager.start(reviewSpec(overrides as Partial<SessionLaunchSpec>), "brief"), false);
    assert.equal(h.drivers.length, 0);
    assert.deepEqual(h.prepared, []);
    assert.deepEqual(h.updates(), [{ type: "review_session_update", sessionId: "s_review", state: "failed", reason }]);
    // The outcome precedes the terminal status, which would otherwise settle it with a generic reason.
    const order = h.sent.filter((message) => message.type === "review_session_update" ||
      (message.type === "session_status" && message.sessionId === "s_review")).map((message) => message.type);
    assert.deepEqual(order, ["review_session_update", "session_status"]);
  }
  const scoped = harness(t, {
    prepare: async () => { throw new ReviewScopeRefusal("the requested head is not the pull request's pushed head"); },
  });
  assert.equal(await scoped.manager.start(reviewSpec(), "brief"), false);
  assert.equal(scoped.updates()[0]?.reason, "the requested head is not the pull request's pushed head");
  const broken = harness(t, { prepare: async () => { throw new Error("/private/path exploded"); } });
  assert.equal(await broken.manager.start(reviewSpec(), "brief"), false);
  assert.equal(broken.updates()[0]?.reason, "the review snapshot could not be prepared", "no path leaves the runner");
});

test("an unsettled review session fails for good when its runner restarts", async (t) => {
  const h = harness(t, { hold: true });
  const pending = h.manager.start(reviewSpec(), "brief");
  await until(() => (h.drivers[0]?.prompts.length ?? 0) > 0, "the review turn");
  // The runner process dies with the review in flight: a new manager reads the same store.
  const sent: RunnerToControlPlane[] = [];
  const restarted = new SessionManager((message) => sent.push(message), () => {}, h.store, "runner", undefined, undefined, h.root);
  t.after(() => restarted.shutdownAll());
  restarted.reconcileStore();
  const meta = h.store.readMeta("s_review")!;
  assert.equal(meta.review?.update?.state, "failed");
  assert.equal(meta.review?.update?.reason, "the review session ended when its runner restarted");
  assert.equal(meta.status, "stopped");
  assert.deepEqual(restarted.reviewSessionUpdates().map((update) => update.state), ["failed"]);
  assert.equal(restarted.prompt("s_review", "continue"), false);
  h.finishTurn();
  await pending;
});
