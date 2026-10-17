import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { mediaActiveStopIdentityBody, pacedVideoReviewWindowPlan, pacedVideoReviewWindowPlanBody,
  parsePacedVideoReviewWindowNotes, validPacedVideoReviewWindowNotes, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  PACED_VIDEO_REVIEW_WINDOW_LIMITS, type ClaudeMediaReviewerAttestation, type MediaActiveStopIdentity,
  type MediaActiveStopRequest, type MediaDispatchFenceIdentity, type MediaReviewDispatch, type MediaReviewFinished,
  type PacedVideoReviewWindow, type PacedVideoReviewWindowNotes, type PacedVideoTransportGrant, type RunnerToControlPlane } from "@wollipog/protocol";
import { claudeMediaReviewerArgs, claudeMediaReviewerAttestation, ClaudeMediaReviewerStream, CLAUDE_MEDIA_REVIEWER_ENV,
  CLAUDE_MEDIA_REVIEWER_TOOLS, inspectClaudeMediaReviewer, mediaReviewerAttestationSha256, mediaReviewerCredentialPath,
  readMediaReviewerCredential, type ClaudeMediaReviewerInstallation } from "./claude-media-reviewer.js";
import { prepareEvidenceReviewNamespace, type EvidenceReviewNamespace } from "./evidence-review-namespace.js";
import { RunnerMediaActiveStops, type OwnedMediaStopHandle } from "./media-active-stops.js";
import { RunnerMediaDispatchFences } from "./media-dispatch-fences.js";
import { openMediaReviewRelay, type MediaReviewRelay } from "./media-review-relay.js";
import { detectRunnerSea } from "./runner-reentry.js";
import type { VideoReviewTransport } from "./video-evidence-review-transport.js";

const run = promisify(execFile);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);

export interface MediaReviewerInstalled {
  attestation: ClaudeMediaReviewerAttestation;
  install: ClaudeMediaReviewerInstallation;
  /** Dedicated runner-local reviewer key; read at launch, never persisted by the dispatcher. */
  credential(): string;
}
export interface MediaReviewerDispatcherDeps {
  db: DatabaseSync;
  root: string;
  runnerId(): string | null;
  controlPlaneHttpUrl(): string;
  fetch: typeof fetch;
  send(message: RunnerToControlPlane): void;
  /** Hash-only registration of the reviewer's own Session credential, awaiting acknowledgement. */
  registerCredential(sessionId: string, tokenHash: string): Promise<void>;
  /** Current verified installation for a configured agent, or a specific refusal reason. */
  reviewer(agentId: string): Promise<MediaReviewerInstalled | { refused: string }>;
  forbiddenRoots(): string[];
  nodeExecutable: string;
  reserve(id: string, agentId: string): boolean;
  release(id: string): void;
  log(message: string): void;
  /** Operator probe only: each window's outcome and validated notes. Never frame bytes or keys. */
  observe?(event: { window: PacedVideoReviewWindow; notes?: PacedVideoReviewWindowNotes; failure?: string;
    costUsd?: number; priced: boolean; toolCalls: number }): void;
  now?(): number;
  /** Test seam. Production spawns bwrap, passing every namespace and provider argument (including
   * the dedicated key) through a private NUL-separated `--args` pipe instead of argv. */
  spawnProvider?(namespace: EvidenceReviewNamespace, privateArgs: string[]): ChildProcess;
}

interface Running {
  identity: MediaActiveStopIdentity;
  stopRequested: boolean;
  /** The current window's provider proved its startup surface. stream-json emits init only after
   * the first user turn arrives, so media tools refuse until that proof, never in parallel. */
  startupProven: boolean;
  child: ChildProcess | null;
  handle: OwnedMediaStopHandle;
}

/** Window prompt. The controlling review's own task text (criteria included) follows verbatim. */
function windowPrompt(window: PacedVideoReviewWindow, frameCount: number, windows: number,
  notes: PacedVideoReviewWindowNotes[], task: string): string {
  const [frameTool, verdictTool] = CLAUDE_MEDIA_REVIEWER_TOOLS;
  const lines = [
    `You are reviewing delivery window ${window.index + 1} of ${windows} of a silent screen recording: source frames ` +
      `${window.firstIndex} through ${window.endIndex - 1} of ${frameCount} (0-based indices). Each image arrives with its ` +
      `receipt, which states the frame's native presentation time (ptsUs) and duration.`,
    `Call ${frameTool} with index ${window.firstIndex}, then with each returned nextIndex, until nextIndex reaches ${window.endIndex}. ` +
      `Inspect every image; frames are never sampled or skipped.`,
  ];
  if (window.final) {
    lines.push(`This is the final window. After inspecting every frame here, call ${verdictTool} once, covering every pinned ` +
      `criterion. Use the validated notes from earlier windows for frames before ${window.firstIndex}; observedFrameIndices may cite any window.`);
  } else {
    lines.push(`Do not submit a verdict in this window. After inspecting every frame here, reply with ONLY one JSON object, no prose:`,
      json({ window: { firstIndex: window.firstIndex, endIndex: window.endIndex },
        observations: [{ fromIndex: window.firstIndex, toIndex: window.endIndex - 1, description: "what is visible across this range" }],
        transients: [{ index: window.firstIndex, ptsUs: 0, description: "any brief or one-off state, with its exact index and ptsUs" }],
        defects: [{ criterionId: "a pinned criterion id", frameIndices: [window.firstIndex], description: "criterion-relevant defect" }] }),
      `observations must be ordered, contiguous ranges covering every index from ${window.firstIndex} to ${window.endIndex - 1}. ` +
        `List EVERY transient or one-off visual state in transients with its exact index and ptsUs; use [] when there are none. ` +
        `Each description is at most 1000 characters and the whole object at most ${PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesChars} characters. ` +
        `Later windows see only these notes, not these images.`);
  }
  if (notes.length) lines.push(`Validated notes from every earlier window, in order:`, json(notes));
  lines.push(`Task from the controlling review:`, task);
  return lines.join("\n\n");
}
/** A window covers at most 60 frames; a provider still running after this is stopped, unpriced. */
export const MEDIA_REVIEW_WINDOW_TIMEOUT_MS = 30 * 60_000;
const userTurn = (text: string) => json({ type: "user", message: { role: "user", content: text } }) + "\n";

/** Runner owner of one dedicated media reviewer per prepared command. It never replays a claimed
 * command: a lost reply, restart or duplicate dispatch only reads back the durable outcome. */
export class MediaReviewerDispatcher {
  private readonly fences: RunnerMediaDispatchFences;
  readonly stops: RunnerMediaActiveStops;
  private readonly running = new Map<string, Running>();
  private readonly dispatching = new Set<string>();
  private readonly now: () => number;
  constructor(private readonly deps: MediaReviewerDispatcherDeps) {
    this.fences = new RunnerMediaDispatchFences(deps.db);
    this.now = deps.now ?? Date.now;
    deps.db.exec("CREATE TABLE IF NOT EXISTS runner_media_review_results (session_id TEXT NOT NULL,generation TEXT NOT NULL," +
      "result TEXT NOT NULL,PRIMARY KEY(session_id,generation));");
    this.stops = new RunnerMediaActiveStops(deps.db, {
      current: (identity) => {
        const running = this.running.get(identity.sessionId);
        return running && json(running.identity) === json(mediaActiveStopIdentityBody(identity)) ? running.handle : null;
      },
      currentAuthority: (identity) => this.running.get(identity.sessionId)?.identity.generation === identity.generation,
    });
  }

  /** Authenticated control-plane Stop. Unowned, finished or mismatched identities get no signal. */
  stop(request: MediaActiveStopRequest): void {
    const ack = this.stops.request(request) ?? this.stops.readback(request);
    if (ack) this.deps.send({ type: "media_review_stop_acknowledged", receipt: ack });
  }

  readback(identity: MediaActiveStopIdentity): void {
    let fence: MediaDispatchFenceIdentity;
    try { const { childSessionId: _child, ...rest } = mediaActiveStopIdentityBody(identity); fence = rest; } catch { return; }
    if (fence.runnerId !== this.deps.runnerId()) return;
    const cancelled = this.fences.cancelBeforeLaunch(fence);
    if (cancelled) { this.deps.send({ type: "media_review_never_dispatched", receipt: cancelled }); return; }
    if (!this.fences.claimed(fence)) return;
    const row = this.deps.db.prepare("SELECT result FROM runner_media_review_results WHERE session_id=? AND generation=?")
      .get(fence.sessionId, fence.generation) as { result: string } | undefined;
    const finished = row ? JSON.parse(row.result) as MediaReviewFinished : null;
    if (finished && json({ ...fence }) === json({ rootSessionId: finished.rootSessionId, sessionId: finished.sessionId,
      runnerId: finished.runnerId, generation: finished.generation, commandSha256: finished.commandSha256,
      dispatchSha256: finished.dispatchSha256 })) { this.deps.send({ type: "media_review_finished", result: finished }); return; }
    // A claimed command without a durable result is running here or died with an earlier runner
    // process (bwrap --die-with-parent). Either way it is possibly dispatched, never relaunched.
    this.receipt(fence, this.running.has(fence.sessionId) ? "accepted" : "unknown", "");
  }

  async dispatch(dispatch: MediaReviewDispatch): Promise<void> {
    let identity: MediaActiveStopIdentity, fence: MediaDispatchFenceIdentity;
    try {
      identity = mediaActiveStopIdentityBody(dispatch.identity);
      const { childSessionId: _child, ...rest } = identity; fence = rest;
    } catch { this.deps.log("ignored malformed media review dispatch identity"); return; }
    if (fence.runnerId !== this.deps.runnerId()) { this.deps.log("ignored media review dispatch for another runner"); return; }
    // A transport retry while the first delivery is still being admitted waits for that outcome.
    const key = `${fence.sessionId}\0${fence.generation}`;
    if (this.dispatching.has(key)) return;
    this.dispatching.add(key);
    try { await this.dispatchOnce(dispatch, identity, fence); } finally { this.dispatching.delete(key); }
  }

  private async dispatchOnce(dispatch: MediaReviewDispatch, identity: MediaActiveStopIdentity, fence: MediaDispatchFenceIdentity): Promise<void> {
    if (this.fences.claimed(fence)) { this.readback(identity); return; }
    const refuse = (reason: string) => {
      const receipt = this.fences.cancelBeforeLaunch(fence);
      this.deps.log(`media review ${fence.sessionId} not dispatched: ${reason}`);
      if (receipt) this.deps.send({ type: "media_review_never_dispatched", receipt });
      else this.readback(identity);
    };
    let plan: ReturnType<typeof pacedVideoReviewWindowPlan>;
    const command = dispatch.command, spec = command?.spec, purpose = spec?.mediaReviewPurpose, grant = dispatch.grant;
    try {
      plan = pacedVideoReviewWindowPlan(grant?.frames);
      if (command?.type !== "start_session" || sha(json(command)) !== fence.commandSha256 || !purpose ||
        spec.sessionId !== fence.sessionId || purpose.rootSessionId !== fence.rootSessionId ||
        purpose.childSessionId !== identity.childSessionId || purpose.generation !== fence.generation ||
        spec.campaignBudgetDispatch?.generation !== fence.generation) return refuse("prepared command identity mismatch");
      if (grant.reviewerSessionId !== spec.sessionId || grant.childSessionId !== purpose.childSessionId ||
        grant.occurrenceId !== purpose.occurrenceId || grant.sourceEvidenceId !== purpose.evidenceId ||
        json(grant.operatorValidation) !== json(purpose.operatorValidation) || !(grant.expiresAt > this.now())) {
        return refuse("media grant does not bind this prepared command");
      }
      if (sha(pacedVideoReviewWindowPlanBody(plan)) !== dispatch.deliveryPlanSha256) return refuse("delivery window plan mismatch");
      if (spec.driver === "codex" || spec.driver === "codex-app-server") return refuse("builtin_tool_allowlist_unavailable");
      if (spec.driver !== "claude-code") return refuse("media_reviewer_unsupported");
      if (typeof spec.config?.model !== "string" || !spec.config.model) return refuse("admitted reviewer model is missing");
    } catch { return refuse("prepared media dispatch is malformed"); }
    const reviewer = await this.deps.reviewer(spec.agentId).catch(() => ({ refused: "media reviewer installation is unavailable" }));
    if ("refused" in reviewer) return refuse(reviewer.refused);
    if (mediaReviewerAttestationSha256(reviewer.attestation) !== dispatch.attestationSha256) return refuse("media reviewer attestation changed");
    if (!this.deps.reserve(`media:${fence.sessionId}`, spec.agentId)) return refuse("host provider admission is unavailable");
    // Claim BEFORE any provider action. From here on the outcome is possibly dispatched.
    let claimed = false;
    try { claimed = this.fences.claim(fence); } catch {}
    if (!claimed) { this.deps.release(`media:${fence.sessionId}`); this.readback(identity); return; }
    const running: Running = { identity, stopRequested: false, startupProven: false, child: null, handle: {
      identity, requestStop: () => {
        running.stopRequested = true;
        const pid = running.child?.pid;
        if (pid) try { process.kill(-pid, "SIGTERM"); } catch {}
      } } };
    this.running.set(fence.sessionId, running);
    let finished: MediaReviewFinished;
    try {
      finished = await this.run(dispatch, fence, plan, reviewer, running);
    } catch (error) {
      finished = this.finished(fence, dispatch.deliveryPlanSha256, { outcome: "failed", reason: "media reviewer launch failed",
        windowsCompleted: 0, verdictConfirmed: false, toolCalls: 0, priced: false });
      this.deps.log(`media review ${fence.sessionId} failed: ${(error as Error).message.slice(0, 200)}`);
    } finally {
      this.running.delete(fence.sessionId);
      this.deps.release(`media:${fence.sessionId}`);
    }
    this.deps.db.prepare("INSERT OR IGNORE INTO runner_media_review_results VALUES (?,?,?)")
      .run(fence.sessionId, fence.generation, json(finished));
    this.deps.send({ type: "media_review_finished", result: finished });
  }

  private receipt(fence: MediaDispatchFenceIdentity, outcome: "accepted" | "unknown", deliveryPlanSha256: string, namespaceLaunchSha256?: string): void {
    const body = { ...fence, outcome, deliveryPlanSha256, ...(namespaceLaunchSha256 ? { namespaceLaunchSha256 } : {}) };
    this.deps.send({ type: "media_review_dispatch_receipt", receipt: { ...body, receiptSha256: sha(json(body)) } });
  }
  private finished(fence: MediaDispatchFenceIdentity, deliveryPlanSha256: string,
    result: Omit<MediaReviewFinished, keyof MediaDispatchFenceIdentity | "deliveryPlanSha256" | "receiptSha256">): MediaReviewFinished {
    const body = { ...fence, deliveryPlanSha256, ...result };
    return { ...body, receiptSha256: sha(json(body)) };
  }

  /** HTTP transport authenticated as the reviewer Session itself, bounded to the current window. */
  private transport(grant: PacedVideoTransportGrant, token: string, window: { current: PacedVideoReviewWindow },
    seen: { acknowledged: Set<number>; verdict: boolean; pending: Map<string, number> }): VideoReviewTransport {
    // `seen.acknowledged` is replaced per window, so every read below goes through `seen`.
    const base = this.deps.controlPlaneHttpUrl().replace(/\/+$/u, "");
    const post = async (action: string, body: Record<string, unknown>): Promise<unknown> => {
      const response = await this.deps.fetch(`${base}/api/sessions/${encodeURIComponent(grant.reviewerSessionId)}/video-evidence-review/${action}`, {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: grant.reviewerSessionId },
        body: json(body),
      });
      const text = await response.text();
      if (!response.ok || text.length > 12 * 1024 * 1024) throw new Error("media route refused");
      return JSON.parse(text);
    };
    return {
      grant, now: this.now,
      request: async (action, body) => {
        const w = window.current;
        if (action === "frames") {
          const index = body.index as number;
          if (!Number.isSafeInteger(index) || index < w.firstIndex || index >= w.endIndex) throw new Error("outside the current window");
          const batch = await post("frames", { reviewId: body.reviewId, index, end: w.endIndex }) as {
            deliveries?: Array<{ receipt?: { receiptId?: string; videoFrame?: { index?: number } } }>; nextIndex?: number };
          if (typeof batch?.nextIndex !== "number" || batch.nextIndex > w.endIndex) throw new Error("batch crossed the window");
          seen.pending.clear();
          for (const delivery of batch.deliveries ?? []) {
            if (typeof delivery?.receipt?.receiptId === "string" && Number.isSafeInteger(delivery.receipt.videoFrame?.index)) {
              seen.pending.set(delivery.receipt.receiptId, delivery.receipt.videoFrame!.index!);
            }
          }
          return batch;
        }
        if (action === "acknowledge-frames") {
          const receipts = body.receipts as Array<{ receiptId: string }>;
          const result = await post("acknowledge-frames", body) as { acknowledged?: boolean };
          if (result?.acknowledged === true) for (const receipt of receipts) {
            const index = seen.pending.get(receipt.receiptId);
            if (index !== undefined) seen.acknowledged.add(index);
          }
          return result;
        }
        if (action === "verdict") {
          const complete = Array.from({ length: w.endIndex - w.firstIndex }, (_, i) => w.firstIndex + i).every((i) => seen.acknowledged.has(i));
          if (!w.final || !complete || seen.verdict) throw new Error("verdict is only accepted once, after the final window's frames");
          const result = await post("verdict", body);
          seen.verdict = true;
          return result;
        }
        // Single-frame delivery is not part of the windowed reviewer surface.
        throw new Error("unsupported media action");
      },
    };
  }

  private async run(dispatch: MediaReviewDispatch, fence: MediaDispatchFenceIdentity,
    plan: ReturnType<typeof pacedVideoReviewWindowPlan>, reviewer: MediaReviewerInstalled, running: Running): Promise<MediaReviewFinished> {
    const spec = dispatch.command.spec, grant = dispatch.grant;
    const model = spec.config!.model!, effort = spec.config?.effort ?? undefined;
    const budget = spec.config?.costBudgetUsd, maxToolCalls = spec.config?.maxToolCalls;
    const token = randomBytes(32).toString("base64url");
    await this.deps.registerCredential(spec.sessionId, sha(token));
    const key = reviewer.credential();
    const state = join(this.deps.root, sha(`${fence.sessionId}\0${fence.generation}`).slice(0, 32));
    mkdirSync(state, { recursive: false, mode: 0o700 }); // Fresh provider HOME; a replay never reuses one.
    const window = { current: plan.windows[0]! };
    const seen = { acknowledged: new Set<number>(), verdict: false, pending: new Map<string, number>() };
    const transport = this.transport(grant, token, window, seen);
    const notes: PacedVideoReviewWindowNotes[] = [];
    // Unpriced unless at least one provider window reported priced final usage and none failed to.
    let costUsd = 0, priced = true, ran = 0, toolCalls = 0, windowsCompleted = 0, reason: string | undefined;
    let accepted = false;
    try {
      for (const current of plan.windows) {
        window.current = current;
        // Acknowledgements count only within the window's own conversation: an earlier window's
        // receipt for the overlap frame never stands in for this conversation having seen it.
        seen.acknowledged = new Set<number>(); seen.pending.clear();
        if (running.stopRequested) { reason = "stop requested"; break; }
        const remaining = budget === undefined ? undefined : budget - costUsd;
        if (remaining !== undefined && !(remaining > 0)) { reason = "cost budget exhausted"; break; }
        const relay: MediaReviewRelay = await openMediaReviewRelay({ transport, actualSessionId: spec.sessionId,
          current: () => running.startupProven && !running.stopRequested && grant.expiresAt > this.now() });
        try {
          const namespace = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: reviewer.install.claude,
            forbiddenRoots: this.deps.forbiddenRoots(), network: "inherit",
            relay: { directory: relay.directory, nodeExecutable: this.deps.nodeExecutable }, providerEnv: CLAUDE_MEDIA_REVIEWER_ENV });
          if (namespace.namespaceSha256 !== reviewer.attestation.namespacePolicySha256) { reason = "namespace policy changed"; break; }
          if (!accepted) { this.receipt(fence, "accepted", dispatch.deliveryPlanSha256, namespace.launchSha256); accepted = true; }
          const outcome = await this.window(namespace, key, claudeMediaReviewerArgs({ providerCommand: namespace.providerCommand,
            mcpConfig: namespace.relay!.mcpConfig, model, effort, maxBudgetUsd: remaining }),
          windowPrompt(current, plan.frameCount, plan.windows.length, notes, dispatch.command.initialPrompt ?? ""),
          current, grant, seen, running, maxToolCalls === undefined ? undefined : maxToolCalls - toolCalls, model);
          ran++; toolCalls += outcome.toolCalls;
          this.deps.observe?.({ window: current, notes: outcome.notes, failure: outcome.failure, costUsd: outcome.costUsd,
            priced: outcome.priced, toolCalls: outcome.toolCalls });
          if (outcome.costUsd !== undefined) costUsd += outcome.costUsd;
          priced = priced && outcome.priced;
          if (outcome.failure) { reason = outcome.failure; break; }
          // Unknown spend would make every later window's remaining budget a guess.
          if (!outcome.priced) { reason = "window usage was not priced"; break; }
          if (outcome.notes) notes.push(outcome.notes);
          windowsCompleted++;
        } finally { await relay.close(); }
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
    priced = priced && ran > 0;
    const completed = windowsCompleted === plan.windows.length && seen.verdict;
    return this.finished(fence, dispatch.deliveryPlanSha256, { outcome: completed ? "completed" : "failed",
      ...(completed ? {} : { reason: reason ?? "verdict was not confirmed" }),
      windowsCompleted, verdictConfirmed: seen.verdict, toolCalls, priced, ...(priced ? { costUsd } : {}) });
  }

  /** One fresh provider conversation. Notes or verdict corrections stay in the same conversation
   * (which still holds the frames); there is at most one correction turn and never truncation. */
  private window(namespace: EvidenceReviewNamespace, key: string, providerArgs: string[], prompt: string,
    window: PacedVideoReviewWindow, grant: PacedVideoTransportGrant,
    seen: { acknowledged: Set<number>; verdict: boolean }, running: Running, toolBudget: number | undefined, model: string,
  ): Promise<{ toolCalls: number; costUsd?: number; priced: boolean; notes?: PacedVideoReviewWindowNotes; failure?: string }> {
    const privateArgs = [...namespace.args, "--setenv", "ANTHROPIC_API_KEY", key, "--", ...providerArgs];
    const child = (this.deps.spawnProvider ?? spawnNamespaced)(namespace, privateArgs);
    running.child = child;
    const stream = new ClaudeMediaReviewerStream({ model });
    running.startupProven = false;
    return new Promise((resolveWindow) => {
      // `sent` counts user turns written. Usage is priced only when every sent turn produced its final
      // result: a window killed mid-turn has spent more than its last cumulative total shows.
      let attempts = 1, sent = 1, settled = false, failure: string | undefined, notes: PacedVideoReviewWindowNotes | undefined;
      const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
      const fail = (reason: string) => { failure ??= reason; running.startupProven = false; kill(); };
      const complete = () => Array.from({ length: window.endIndex - window.firstIndex }, (_, i) => window.firstIndex + i)
        .every((index) => seen.acknowledged.has(index));
      let turns = 0;
      const afterTurn = () => {
        if (failure) return;
        // Unknown spend makes any further turn unaccountable; no correction is ever paid for.
        if (!stream.result.priced) return fail("window usage was not priced");
        if (!complete()) return fail("window ended before every frame was delivered");
        if (window.final) {
          if (seen.verdict) { child.stdin?.end(); return; }
          if (attempts++ >= PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesAttempts) return fail("final window ended without a confirmed verdict");
          sent++; child.stdin?.write(userTurn(`Every frame is inspected but no verdict was confirmed. Call ${CLAUDE_MEDIA_REVIEWER_TOOLS[1]} now.`));
          return;
        }
        const parsed = parsePacedVideoReviewWindowNotes(stream.result.finalText);
        if (validPacedVideoReviewWindowNotes(parsed, window, grant.frames)) { notes = parsed; child.stdin?.end(); return; }
        if (attempts++ >= PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesAttempts) return fail("window notes were missing or invalid");
        sent++; child.stdin?.write(userTurn("Those notes were not valid. Reply with ONLY the JSON object described earlier: exact window, " +
          "ordered contiguous observations covering every frame of this window, every transient with its exact index and ptsUs, and defects."));
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        const refusal = stream.push(chunk);
        if (refusal) { running.startupProven = false; return fail(refusal); }
        if (stream.result.initialized && !failure) running.startupProven = true;
        if (toolBudget !== undefined && stream.result.toolCalls > toolBudget) return fail("tool-call ceiling reached");
        if (stream.result.turns > turns) { turns = stream.result.turns; afterTurn(); }
      });
      child.stderr?.resume();
      child.stdin?.on("error", () => {});
      const timer = setTimeout(() => fail("window exceeded its wall-clock bound"), MEDIA_REVIEW_WINDOW_TIMEOUT_MS);
      timer.unref?.();
      const done = (code: number | null) => {
        if (settled) return; settled = true; clearTimeout(timer); running.child = null; running.startupProven = false;
        if (!failure && running.stopRequested) failure = "stop requested";
        if (!failure && (code !== 0 || !stream.result.initialized)) failure = "provider exited before completing the window";
        if (!failure && !window.final && !notes) failure = "window notes were missing or invalid";
        resolveWindow({ toolCalls: stream.result.toolCalls, costUsd: stream.result.costUsd,
          priced: stream.result.priced && stream.result.costUsd !== undefined && stream.result.turns === sent, notes, failure });
      };
      child.on("error", () => { failure ??= "provider could not start"; done(null); });
      child.on("close", (code) => done(code));
      child.stdin?.write(userTurn(prompt));
    });
  }
}

/** bwrap reads every argument from a private pipe, so the key never appears in any argv. */
function spawnNamespaced(namespace: EvidenceReviewNamespace, privateArgs: string[]): ChildProcess {
  const child = spawn(namespace.command, ["--args", "3"], { env: {}, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const pipe = child.stdio[3] as NodeJS.WritableStream | null;
  pipe?.end(privateArgs.map((arg) => arg + "\0").join(""));
  return child;
}

/** Offline installed-reviewer proof used for discovery and re-checked before every dispatch:
 * pinned CLI, dedicated key present, and an actual (provider-less) namespace launch that yields
 * the stable policy digest. No model request is made and the key is not read into the result. */
export async function installedMediaReviewer(input: { agentId: string; command: string; dataDir: string; root: string;
  nodeExecutable: string; forbiddenRoots: string[] }): Promise<MediaReviewerInstalled | { refused: string }> {
  if (process.platform !== "linux" || process.getuid?.() === 0) return { refused: "media reviewer needs a native non-root Linux runner" };
  // The in-namespace relay runs on Node. A single-executable runner has no Node to mount.
  if (detectRunnerSea()) return { refused: "media reviewer relay needs a Node runtime; single-executable runners are unsupported" };
  let keyPath: string;
  try { keyPath = mediaReviewerCredentialPath(input.dataDir, input.agentId); readMediaReviewerCredential(keyPath); }
  catch { return { refused: "dedicated media reviewer key is not provisioned" }; }
  let install: ClaudeMediaReviewerInstallation;
  try { install = await inspectClaudeMediaReviewer(input.command); } catch (error) { return { refused: (error as Error).message.slice(0, 200) }; }
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const state = mkdtempSync(join(input.root, "probe-"));
  let relay: MediaReviewRelay | null = null;
  try {
    relay = await openMediaReviewRelay({ transport: { grant: {} as PacedVideoTransportGrant, now: Date.now,
      request: async () => { throw new Error("probe relay serves no media"); } }, actualSessionId: "", current: () => false });
    const namespace = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: install.claude,
      forbiddenRoots: input.forbiddenRoots, network: "inherit",
      relay: { directory: relay.directory, nodeExecutable: input.nodeExecutable }, providerEnv: CLAUDE_MEDIA_REVIEWER_ENV });
    // Proves the namespace launches and that the mounted relay runtime really is Node (a bundled
    // runner's own executable would not be), without starting the provider.
    await run(namespace.command, [...namespace.args, "--", namespace.relay!.nodeCommand, "-e", "require('node:net')"],
      { env: {}, timeout: 10_000 });
    return { attestation: claudeMediaReviewerAttestation(input.agentId, install, namespace.namespaceSha256), install,
      credential: () => readMediaReviewerCredential(keyPath) };
  } catch { return { refused: "media reviewer namespace is unavailable on this host" }; }
  finally { await relay?.close(); rmSync(state, { recursive: true, force: true }); }
}
