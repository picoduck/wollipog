import {createHash} from "node:crypto";
import {AssistantRefusal, type AssistantOperations} from "./assistant-connections.js";
import {AssistantSessionManagement, sessionArgumentObject as obj, sessionArgumentText as text, type SessionManagementContext} from "./assistant-session-management.js";
import type {AssistantCommandReceipts} from "./assistant-command-receipts.js";
import type {ControlPlaneDb} from "./db.js";
import type {Hub} from "./hub.js";
import type {SessionsService, ServiceResult} from "./sessions.js";
import {OwnerManagement, type OwnerManagementReply, type OwnerManagementResult} from "./owner-management.js";
import type {createSessionContentManagement} from "./session-content-management.js";
import {readPromptHistory} from "./prompt-history-route.js";
import {buildAuthorizedSessionTranscriptExport} from "./session-exports.js";
import {listAuthorizedTranscriptShares} from "./transcript-shares.js";
import {failureBody} from "./capability-refusal.js";
import type {createSessionShellManagement} from "./session-shell-management.js";

const str = {type: "string"}, integer = {type: "integer", minimum: 0};
export const ASSISTANT_SESSION_CONTENT_ROUTES = {
  "GET /api/sessions/:id/shells": "shell_list",
  "POST /api/sessions/:id/shells": "shell_open",
  "DELETE /api/sessions/:id/shells/:shellId": "shell_close",
  "POST /api/sessions/:id/pull-request-watch": "session_watch",
  "POST /api/sessions/:id/waits": "session_wait_report",
  "GET /api/sessions/:id/side-chat": "side_chat_get",
  "POST /api/sessions/:id/side-chat": "side_chat_create",
  "GET /api/sessions/:id/prompt-history": "prompt_history",
  "GET /api/sessions/:id/history-preview": "history_preview",
  "GET /api/sessions/:id/retained-attachment-events": "attachment_history",
  "GET /api/sessions/:id/export": "session_export",
  "GET /api/sessions/:id/artifacts": "session_artifacts",
  "GET /api/sessions/:id/transcript-shares": "transcript_shares",
  "GET /api/sessions/:id/reminder": "reminder_get",
  "PUT /api/sessions/:id/reminder": "reminder_set",
  "DELETE /api/sessions/:id/reminder": "reminder_remove",
} as const;

export function registerAssistantSessionContent(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService; receipts: AssistantCommandReceipts;
  content: ReturnType<typeof createSessionContentManagement>;
  shells: ReturnType<typeof createSessionShellManagement>;
}) {
  const {db, hub, svc, content} = deps, adapter = new AssistantSessionManagement(operations, db, deps.receipts);
  const result = (r: ServiceResult<unknown>): OwnerManagementResult => ({status: r.status, body: r.ok ? r.data : failureBody(r)});
  const invoke = (ctx: SessionManagementContext, handler: (reply: OwnerManagementReply) => unknown) => {
    const management = new OwnerManagement(); management.define("GET", "/read", (_input, reply) => handler(reply));
    return management.execute("GET /read", {principal: ctx.owner, params: {}, body: {}, query: {}});
  };
  const accessible = (ctx: SessionManagementContext, operation: string, id: string) => {
    const s = db.getSession(id); if (!s) return false;
    try {operations.authorize(ctx.connection.id, operation, {kind: "session", id, ...(s.projectId ? {projectId: s.projectId} : {})}); return true;} catch {return false;}
  };
  adapter.register({name: "shell_list", description: "Inspect terminal process metadata for an authorized session. Raw terminal output remains workspace I/O.",
    run: a => ({status: 200, body: deps.shells.list(text(a, "sessionId"))})});
  adapter.register({name: "shell_open", description: "Open a session terminal or supported Native TUI through the owner's runner path. Existing protocol, provider-home, role-conversion and launch fences remain mandatory; no arbitrary command or terminal input is accepted.",
    properties: {kind: {type: "string", enum: ["shell", "agent_tui"]}, cols: {type: "integer", minimum: 1}, rows: {type: "integer", minimum: 1}}, mutate: true,
    run: async (a, ctx) => {
      const opened = await deps.shells.open(text(a, "sessionId"), {kind: a.kind, cols: a.cols, rows: a.rows}, {recheck: ctx.recheck});
      return {status: opened.status, body: opened.ok ? {shell: opened.shell} : failureBody(opened)};
    }});
  adapter.register({name: "shell_close", description: "Close and forget the exact session terminal through the owner's durable tombstone path. Honors destructiveConfirmation, including while the runner is offline.",
    properties: {shellId: str}, required: ["shellId"], mutate: true, destructive: true,
    impact: a => deps.shells.list(text(a, "sessionId")).shells.filter(s => s.shellId === a.shellId)
      .map(s => ({shellId: s.shellId, sessionId: s.sessionId, kind: s.kind, createdAt: s.createdAt, status: s.status})),
    run: a => deps.shells.close(text(a, "sessionId"), text(a, "shellId"))});
  adapter.register({name: "session_watch_get", description: "Inspect a session's durable PR watch and classified wait state. Watched-session identities stay masked by the owner service.",
    run: a => ({status: 200, body: {watch: db.pullRequestWatches.visibleFor(text(a, "sessionId")), waits: db.sessionWaits.views(text(a, "sessionId")) ?? []}})});
  adapter.register({name: "session_watch", description: "Park authorized work on an exact GitHub PR head using the durable owner/session watch service. Replaces a previous watch; never merges or grants merge approval.",
    properties: {repository: str, number: {type: "integer", minimum: 1}, headSha: str}, required: ["repository", "number", "headSha"], mutate: true,
    run: (a, ctx) => result(svc.requestPullRequestWatch(text(a, "sessionId"), {repository: a.repository, number: a.number, headSha: a.headSha}, id => accessible(ctx, "session_watch", id)))});
  adapter.register({name: "session_wait_report", description: "Record an observed wait's progress or end through the shared service. Telemetry only: this does not block, poll, create a wake or prove a remote call ran. Report actual measured durations, never invented progress.",
    properties: {report: {type: "object"}}, required: ["report"], mutate: true,
    run: (a, ctx) => result(svc.reportSessionWait(text(a, "sessionId"), a.report, id => accessible(ctx, "session_wait_report", id)))});
  const sideAccess = (name: string, a: Record<string, unknown>, ctx: SessionManagementContext) => {
    const child = db.getSideChat(text(a, "sessionId"))?.childSessionId;
    if (child && !accessible(ctx, name, child)) throw new AssistantRefusal("The side-chat session is outside current access.");
  };
  adapter.register({name: "side_chat_get", description: "Read the existing auxiliary work session and its live queue, under current access to both parent and side chat.",
    check: (a, ctx) => sideAccess("side_chat_get", a, ctx), run: a => {
      const r = svc.sideChat(text(a, "sessionId"));
      return r.ok ? {status: 200, body: {sideChat: r.data ? {...r.data, session: hub.withQueue(r.data.session, true)} : null}} : result(r);
    }});
  adapter.register({name: "side_chat_create", description: "Create or reuse a side-chat work session through the owner's launch service. Optionally replace an ended relation while retaining the old child's history and accounting.",
    properties: {replaceEnded: {type: "boolean"}}, mutate: true,
    check: (a, ctx) => {if (a.replaceEnded !== undefined && typeof a.replaceEnded !== "boolean") throw new AssistantRefusal("replaceEnded must be a boolean."); sideAccess("side_chat_create", a, ctx);},
    run: a => result(svc.createSideChat(text(a, "sessionId"), a.replaceEnded === true))});
  adapter.register({name: "prompt_history", description: "Read a bounded prompt-history page using the owner's hydration, epoch and access checks. Incomplete caches are explicitly marked.",
    properties: {before: {type: "integer", minimum: 1}, limit: {type: "integer", minimum: 1, maximum: 100}, eventEpoch: integer}, required: ["eventEpoch"],
    run: (a, ctx) => invoke(ctx, reply => readPromptHistory({db, hydrateHistory: id => svc.hydrateHistory(id)}, text(a, "sessionId"), a, ctx.owner, reply, ctx.recheck))});
  adapter.register({name: "history_preview", description: "Read a bounded authoritative history window or handoff using the owner's exact epoch/cursor contract. A preview is not a fully hydrated export.",
    properties: Object.fromEntries(["eventEpoch", "logEpoch", "throughSeq", "turnStartSeq", "afterSeq", "beforeSeq", "handoffSeq", "handoffFirstSeq", "handoffLastSeq", "handoffAfter", "limit"].map(k => [k, integer])),
    required: ["eventEpoch", "logEpoch", "throughSeq", "turnStartSeq", "limit"],
    run: (a, ctx) => invoke(ctx, reply => content.preview(text(a, "sessionId"), a, reply))});
  adapter.register({name: "attachment_history", description: "Read retained attachment-bearing event references after history replacement. Epoch and bounded pagination match the owner route; this does not upload or inspect file bytes.",
    properties: {after: integer, limit: {type: "integer", minimum: 1, maximum: 200}, eventEpoch: integer}, required: ["after", "limit", "eventEpoch"],
    run: (a, ctx) => invoke(ctx, reply => content.retained(text(a, "sessionId"), a, reply))});
  adapter.register({name: "session_export", description: "Export the owner's redacted cached transcript as bounded UTF-8 pages. Cache may be partial. Continue only with the returned sha256 and nextOffset; this does not publish a share or hydrate remote history.",
    properties: {format: {type: "string", enum: ["json", "markdown"]}, offset: integer, limitBytes: {type: "integer", minimum: 1, maximum: 65536}, sha256: str}, required: ["format"],
    run: (a, ctx) => {
      if (a.format !== "json" && a.format !== "markdown") throw new AssistantRefusal("format must be json or markdown.");
      const offset = a.offset ?? 0, limit = a.limitBytes ?? 16384;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 65536) throw new AssistantRefusal("Supply a nonnegative byte offset and limitBytes between 1 and 65536.");
      const exported = buildAuthorizedSessionTranscriptExport(db, ctx.owner, text(a, "sessionId"), a.format);
      if (!exported.ok) return {status: exported.status, body: {error: exported.error, code: exported.code}};
      const sha256 = createHash("sha256").update(exported.body).digest("hex");
      if (((offset as number) > 0 || a.sha256 !== undefined) && a.sha256 !== sha256) throw new AssistantRefusal("Export snapshot changed or sha256 is missing. Restart from offset 0 before continuing.");
      if ((offset as number) > exported.body.length || ((offset as number) < exported.body.length && (exported.body[offset as number]! & 0xc0) === 0x80)) throw new AssistantRefusal("offset must be a UTF-8 boundary inside the current export.");
      let end = Math.min(exported.body.length, (offset as number) + (limit as number));
      while (end < exported.body.length && (exported.body[end]! & 0xc0) === 0x80) end--;
      if (end === offset && end < exported.body.length) throw new AssistantRefusal("limitBytes is smaller than this UTF-8 character; increase it.");
      return {status: 200, body: {format: a.format, sha256, throughSeq: exported.throughSeq, completeness: "possibly-partial", source: "control-plane-cache",
        text: exported.body.subarray(offset as number, end).toString("utf8"), nextOffset: end < exported.body.length ? end : null, sizeBytes: exported.body.length}};
    }});
  adapter.register({name: "session_artifacts", description: "List authorized session attachment/artifact metadata and exact hashes using the owner service. Listing does not inspect evidence or approve it.",
    properties: {cursor: str, limit: {type: "integer", minimum: 1, maximum: 100}},
    run: a => result(svc.sessionWorkflowArtifacts(text(a, "sessionId"), a.cursor as string | undefined, a.limit === undefined ? 50 : a.limit as number))});
  adapter.register({name: "transcript_shares", description: "Inspect metadata for existing transcript shares. No bearer capability or public conversation bytes are returned. Share credential issuance/revocation stays on the authenticated owner path.",
    run: (a, ctx) => {const r = listAuthorizedTranscriptShares(db, ctx.owner, text(a, "sessionId")); return r.ok ? {status: 200, body: {shares: r.value}} : {status: r.status, body: {error: r.error}};}});
  adapter.register({name: "reminder_get", description: "Read the granting owner's reminder for this authorized session, including indefinite Someday reminders.",
    run: (a, ctx) => ({status: 200, body: {reminder: db.getSessionReminder(text(a, "sessionId"), ctx.owner.userId)}})});
  adapter.register({name: "reminder_set", description: "Set the granting owner's session reminder through the owner service, preserving schedule and optimistic-revision validation.",
    properties: {reminder: {type: "object"}}, required: ["reminder"], mutate: true,
    run: (a, ctx) => result(svc.setReminder(text(a, "sessionId"), ctx.owner.userId, obj(a.reminder)))});
  adapter.register({name: "reminder_remove", description: "Remove the granting owner's exact reminder using optional revision/reminder identity fences; cannot alter another user's reminder.",
    properties: {revision: integer, reminderId: str}, mutate: true, destructive: true,
    check: a => {
      if (a.revision !== undefined && (!Number.isSafeInteger(a.revision) || (a.revision as number) < 0)) throw new AssistantRefusal("revision must be a nonnegative integer.");
      if (a.reminderId !== undefined && (typeof a.reminderId !== "string" || !a.reminderId || a.reminderId.length > 128 || a.revision === undefined)) throw new AssistantRefusal("reminderId must be a bounded string paired with revision.");
    }, impact: (a, ctx) => db.getSessionReminder(text(a, "sessionId"), ctx.owner.userId),
    run: (a, ctx) => result(svc.removeReminder(text(a, "sessionId"), ctx.owner.userId, a.revision as number | undefined, a.reminderId as string | undefined))});
}
