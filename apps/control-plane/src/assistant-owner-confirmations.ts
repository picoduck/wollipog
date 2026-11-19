import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ASSISTANT_OWNER_CONFIRMATION_TTL_MS,
  type AssistantOwnerConfirmation,
  type AssistantOwnerConfirmationDetail,
  type AssistantOwnerConfirmationStatus,
  type OrchestratorCampaignBudgetDefault,
} from "@wollipog/protocol";
import { AssistantRefusal, type AssistantTarget } from "./assistant-connections.js";
import type { HumanPrincipal } from "./identity.js";

/** The exact command an owner confirmation is bound to. Equal to the binding the operation
 * computes again when the approved command runs; any difference refuses it. */
export interface OwnerConfirmationBinding {
  connectionId: string; grantRevision: number; operation: string; argumentsDigest: string; targetDigest: string;
}

/** What a destructive command needs to be shown to its owner and later run exactly as asked. */
export interface OwnerConfirmationRequest {
  /** The command's receipt key (`commandId`, or `operationId` for owner-management parity). */
  commandId: string;
  /** The arguments the command runs with, without any `confirmationId`. */
  args: Record<string, unknown>;
  target: AssistantTarget;
  targetLabel?: string;
  impact?: unknown;
  campaign?: CampaignConfirmationPreview;
}

export const ASSISTANT_CAMPAIGN_START = "campaign_start";
export const assistantCampaignLaunchId = (confirmationId: string) => `assistant-${confirmationId}`;
export interface CampaignConfirmationPreview {
  facts: AssistantOwnerConfirmationDetail[];
  budget: OrchestratorCampaignBudgetDefault | null;
  budgetOverride?: OrchestratorCampaignBudgetDefault;
}

/** Pending requests one thread may hold at once, so an assistant cannot flood its owner. */
export const ASSISTANT_OWNER_CONFIRMATION_PENDING_LIMIT = 10;
const ARGUMENTS_LIMIT = 16 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_LIMIT = 12;
const VALUE_LIMIT = 200;
const COMMAND_KEYS = new Set(["commandId", "operationId", "confirmationId"]);

interface Row {
  id: string; connection_id: string; thread_id: string; owner_user_id: string; organization_id: string;
  operation: string; command_id: string; binding_json: string; arguments_json: string; target_json: string;
  target_label: string; impact_json: string | null; status: AssistantOwnerConfirmationStatus;
  created_at: number; expires_at: number; resolved_at: number | null; outcome_json: string | null;
}

/** Title Case label for an operation: `session_archive` reads "Archive Session". */
const NOUNS: Record<string, string> = { auto: "Automation" };
const VERBS: Record<string, string> = { review_find_set: "Update Review Finding", campaign_branch_clean: "Clean Campaign Branches",
  queue_cancel: "Cancel Queued Prompt", session_git: "Discard File Changes", campaign_start: "Start Campaign" };
const titleWord = (word: string) => word ? word[0]!.toUpperCase() + word.slice(1) : word;
export function ownerConfirmationTitle(operation: string): string {
  const parts = operation.split("_");
  const special = VERBS[operation];
  if (special) return special;
  if (parts.length < 2) return titleWord(operation);
  const noun = NOUNS[parts[0]!] ?? titleWord(parts[0]!);
  return `${parts.slice(1).map(titleWord).join(" ")} ${noun}`;
}

/** What approving each destructive operation does, in plain sentences for its owner. Each states
 * only what the operation's service does, including what is kept and what is lost. Every operation
 * the registry marks destructive has one (#4675); the fallback is for an unregistered name. */
const SUMMARIES: Record<string, string> = {
  campaign_start: "Starts an independent Orchestrator campaign with the settings and authority shown here. Its usage is charged to its own campaign allowance.",
  // Sessions
  session_stop: "Stops the session and cancels its queued prompts and background jobs. Its transcript and worktree are kept, but it takes no further messages until it is restarted.",
  session_retry_stop: "Sends the session's pending Stop again. It cancels the session's queued prompts and background jobs; its transcript and worktree are kept.",
  session_archive: "Stops the session if it is running, then archives it and its side chat. Its transcript is kept, and it can be unarchived later.",
  session_delete: "Deletes the session and its side chat with their transcripts, and removes the worktrees Wollipog created for it, losing uncommitted changes. This cannot be undone.",
  session_rewind: "Restores the session's files to how they were before the chosen turn. The conversation is kept; file changes made since then, including uncommitted edits, are lost.",
  session_reprocess: "Imports the adopted session's transcript again, replacing its history in Wollipog. The original transcript file is not changed.",
  session_role: "Converts the session between a normal session and an Orchestrator on the same conversation. Its permissions and budgets are kept, and it can be converted back.",
  session_cancel: "Interrupts the session's current turn. The session stays open, and its transcript and queued prompts are kept.",
  session_invoke: "Runs the provider command shown in the arguments, such as /compact, in the session. What it changes depends on that command.",
  session_job_stop: "Ends one background job of the session. The session and its other jobs keep running.",
  session_hold_release: "Ends the background jobs the session's handoff is waiting for, then runs the handoff and its queued prompts. Those jobs cannot be resumed.",
  session_pending_resolve: "Cancels a prompt that has not reached the session, dismisses a failed one and erases its text, or sends it again, as the arguments say.",
  steering_resolve: "Queues an uncertain steering message again, or dismisses it and erases its text, as the arguments say. Queued again, it may run twice.",
  queue_cancel: "Asks to remove a queued prompt before the session starts it; its text is not kept. If the session has already started it, nothing changes.",
  session_git: "Discards the staged and unstaged changes to one file in the session's worktree, deleting the file if it was newly added. The changes cannot be recovered.",
  worktree_discard: "Removes the session's worktree folder. Wollipog refuses unless the worktree is clean and its commits are pushed or already merged.",
  shell_close: "Closes the session's terminal, ending its processes, and deletes its saved output. If the Machine is offline, the processes end when it reconnects.",
  reminder_set: "Sets your reminder for the session, replacing any reminder you already have on it.",
  reminder_remove: "Deletes your reminder for the session. Setting one again creates a new reminder.",
  // Results
  result_ack: "Marks the session's current result as reviewed by you, so it no longer needs your attention. The result is kept, and a newer result asks again.",
  result_handoff: "Hands the session's current result from its Orchestrator to you for review. Nothing is sent or deleted, and a newer result goes back to the Orchestrator.",
  result_blocked_ack: "Stops flagging finished background results that wait for another job from the same turn. They are still delivered when that job finishes.",
  result_missing_ack: "Stops flagging a background delivery that was accepted but never returned a result. Nothing is retried, and a result that arrives later still counts.",
  result_retry_ack: "Stops flagging a background delivery that ran out of retries. It is not sent again.",
  // Campaigns and reviews
  campaign_branch_clean: "Deletes on GitHub the campaign's merged branches whose deletion was already approved, if each still points at its merged head. The merged work is kept.",
  review_find_set: "Resolves or dismisses the review finding. It can be reopened later; while resolved or dismissed, a required finding no longer blocks merging.",
  // Projects and Machines
  project_delete: "Deletes the Project and its Locations. Its sessions are kept but leave the Project, and no files are touched. This cannot be undone.",
  project_archive_sessions: "Stops and archives every session in the Project, with their side chats. Transcripts and worktrees are kept, and each session can be unarchived.",
  location_move: "Moves the Location and all its sessions to another Project. No files are touched, and it can be moved back.",
  location_remove: "Removes the Location from the Project. Its sessions stay in the Project, and the workspace's files are not touched.",
  runner_remove: "Deletes the offline Machine from Wollipog with all its sessions and their transcripts. Files on the Machine are not touched. This cannot be undone.",
  workspace_remove: "Unregisters the workspace from its Machine. Its folder, files, sessions and worktrees are not touched.",
  // Automations and callbacks
  auto_delete: "Deletes the automation and its triggers, so it does not run again. Its run history and the sessions it started are kept.",
  auto_trigger_remove: "Removes the trigger and its signing secret, so its URL stops working. The automation and its other triggers are kept.",
  delivery_resume: "Resumes delivery to this callback, sending the deliveries that were waiting. Events from while it was paused are not sent.",
  // Skills
  skill_remove: "Deletes the skill and all its versions from the Skill Library and removes it from every Machine. This cannot be undone.",
  skill_unassign: "Deletes this assignment of the skill, so the Machines it covered lose the skill unless another assignment gives it. The skill stays in the Library.",
  skill_group_remove: "Deletes the skill group and its assignments. Its skills stay in the Library, but Machines lose the ones only this group gave them.",
  skill_group_unassign: "Deletes this assignment of the skill group, so the Machines it covered lose the group's skills unless another assignment gives them.",
  skill_builtin_apply: "Adds the built-in release as a new version of the skill and has it follow future releases. Earlier versions are kept and can be restored.",
  skill_git_import: "Imports the previewed skill from Git into the Skill Library, as a new skill or a new version. Earlier versions are kept; Machines on the latest version get it.",
  skill_git_preview_discard: "Discards the Git import preview. Nothing in the Skill Library or on any Machine changes.",
  skill_machine_adopt: "Replaces the Machine's own copy of the skill with the Library version. The original folder is kept on the Machine and can be restored.",
  skill_machine_import: "Imports the skill found on the Machine into the Skill Library, as a new skill or a new version. Earlier versions are kept; the Machine's files are not changed.",
  skill_machine_discard: "Discards the Machine skill preview. Nothing in the Skill Library or on the Machine changes.",
  skill_recovery_restore: "Puts the Machine's original skill folder back in place of the adopted Library version. Nothing is deleted.",
  skill_drift_restore: "Replaces the hand-edited copy of the skill on the Machine with the Library version. The edits are deleted, or set aside if they cannot be removed safely.",
  skill_drift_import: "Saves the Machine's hand-edited copy as a new version of the skill and uses it there. Earlier versions are kept; Machines on the latest version get it.",
  skill_drift_discard: "Discards the review of the edited skill copy. Nothing in the Skill Library or on the Machine changes.",
  skill_orphan_discard: "Deletes the left-over skill copy from the Machine, or sets it aside if it cannot be removed safely. The Skill Library is not changed.",
  skill_orphan_import: "Imports the left-over skill copy into the Skill Library, then deletes it from the Machine, or sets it aside, unless it is deployed there again.",
  skill_orphan_preview_discard: "Discards the review of the left-over skill copy. Nothing in the Skill Library or on the Machine changes.",
};
const SUMMARY_FALLBACK = "Runs this destructive command once, exactly as shown. Its effect may not be reversible.";
export function ownerConfirmationSummary(operation: string): string {
  return Object.hasOwn(SUMMARIES, operation) ? SUMMARIES[operation]! : SUMMARY_FALLBACK;
}
/** The operations with their own sentence, so a test can hold them to the registry's destructive set. */
export function ownerConfirmationSummaryOperations(): string[] {
  return Object.keys(SUMMARIES).sort();
}

/** `worktreePath` reads "Worktree Path"; established acronyms keep their capitals. */
const ACRONYMS: Record<string, string> = { id: "ID", ids: "IDs", url: "URL", pr: "PR", sha: "SHA", api: "API" };
const labelOf = (key: string) => key.replace(/[_-]+/gu, " ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(" ").filter(Boolean)
  .map((word) => ACRONYMS[word.toLowerCase()] ?? titleWord(word)).join(" ");
const valueOf = (value: unknown): string => {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "";
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT - 1)}…` : text;
};
/** A preview value as people read it: a status such as `input_required` reads "Input Required",
 * and a flag reads Yes or No. */
const impactValue = (key: string, value: unknown): string => {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && /status$/iu.test(key) && /^[a-z_]+$/u.test(value)) return value.split("_").map(titleWord).join(" ");
  return valueOf(value);
};
/** Bounded display lines for the control plane's own preview of a command's effect. Empty fields
 * say nothing and are left out. */
function impactLines(value: unknown): AssistantOwnerConfirmationDetail[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return [{ label: "Impact", value: valueOf(value) }];
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null && item !== "");
  const lines = entries.slice(0, DETAIL_LIMIT).map(([key, item]) => ({ label: labelOf(key), value: impactValue(key, item) }));
  if (entries.length > DETAIL_LIMIT) lines.push({ label: "More", value: `${entries.length - DETAIL_LIMIT} more fields` });
  return lines;
}

/** Every argument the approved run uses, by its exact name and with its whole value: the owner
 * approves what the assistant sent, so nothing of it is relabeled, merged or cut short. Requests
 * whose arguments are too large to show are refused when they are recorded. */
function argumentLines(args: Record<string, unknown>): AssistantOwnerConfirmationDetail[] {
  return Object.entries(args).filter(([key]) => !COMMAND_KEYS.has(key))
    .map(([key, item]) => ({ label: key, value: typeof item === "string" ? item : JSON.stringify(item) ?? "null" }));
}

/** Owner confirmations for Wollipog Assistant threads (#4665). A thread's destructive command is
 * recorded here instead of returning a confirmation ID to its assistant. Only the owner's
 * approval moves it to `approved`, and only the control plane's run of that approval, inside the
 * command's receipt reservation, moves it to `executed`. */
export class AssistantOwnerConfirmations {
  private listeners = new Set<(threadId: string) => void>();
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_owner_confirmations (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL, organization_id TEXT NOT NULL, operation TEXT NOT NULL,
      command_id TEXT NOT NULL, binding_json TEXT NOT NULL, arguments_json TEXT NOT NULL,
      target_json TEXT NOT NULL, target_label TEXT NOT NULL, impact_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','executed','denied','expired','refused')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER, outcome_json TEXT,
      notified_at INTEGER);
      CREATE INDEX IF NOT EXISTS assistant_owner_confirmations_thread ON assistant_owner_confirmations(thread_id, status);
      CREATE INDEX IF NOT EXISTS assistant_owner_confirmations_status ON assistant_owner_confirmations(status, expires_at);`);
  }
  constructor(private readonly db: DatabaseSync) {}

  /** Hint for publishing the thread; readers always read current rows. */
  onChange(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(threadId: string): void {
    for (const listener of this.listeners) {
      try { listener(threadId); } catch { /* A publish hint never rolls back a recorded answer. */ }
    }
  }

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM assistant_owner_confirmations WHERE id=?").get(id) as Row | undefined;
  }

  /** The thread a connection belongs to, or null for an external Assistant connection. */
  threadOf(connectionId: string): { threadId: string; ownerUserId: string; organizationId: string } | null {
    const row = this.db.prepare("SELECT thread_id, owner_user_id, organization_id FROM assistant_connections WHERE id=?").get(connectionId) as
      { thread_id: string | null; owner_user_id: string; organization_id: string } | undefined;
    return row?.thread_id ? { threadId: row.thread_id, ownerUserId: row.owner_user_id, organizationId: row.organization_id } : null;
  }

  /** Records the owner's pending decision for this exact command. Asking again for the same
   * command while it waits returns the same request. */
  request(binding: OwnerConfirmationBinding, input: OwnerConfirmationRequest, targetLabel: string, now = Date.now()): AssistantOwnerConfirmation {
    const thread = this.threadOf(binding.connectionId);
    if (!thread) throw new Error("Owner confirmation requested for a connection without a thread");
    const bindingJson = JSON.stringify(binding);
    if (input.campaign) {
      const prior = this.db.prepare(`SELECT * FROM assistant_owner_confirmations
        WHERE connection_id=? AND operation=? AND command_id=? AND status IN ('pending','approved') AND expires_at>?`)
        .get(binding.connectionId, binding.operation, input.commandId, now) as Row | undefined;
      if (prior) {
        if ((JSON.parse(prior.binding_json) as OwnerConfirmationBinding).argumentsDigest !== binding.argumentsDigest) {
          throw new AssistantRefusal("This command ID already belongs to a different campaign proposal.");
        }
        return this.view(prior);
      }
    }
    const existing = this.db.prepare(`SELECT id FROM assistant_owner_confirmations
      WHERE connection_id=? AND binding_json=? AND status='pending' AND expires_at>?`).get(binding.connectionId, bindingJson, now) as {id: string} | undefined;
    if (existing) return this.view(this.row(existing.id)!);
    const pending = (this.db.prepare(`SELECT COUNT(*) AS n FROM assistant_owner_confirmations
      WHERE thread_id=? AND status='pending' AND expires_at>?`).get(thread.threadId, now) as {n: number}).n;
    if (pending >= ASSISTANT_OWNER_CONFIRMATION_PENDING_LIMIT) {
      throw new AssistantRefusal(`Your owner already has ${pending} of your requests waiting. Nothing ran. Wait for them to answer before asking for another destructive command.`);
    }
    const argumentsJson = JSON.stringify(input.args);
    if (argumentsJson.length > ARGUMENTS_LIMIT) throw new AssistantRefusal("This command's arguments are too large to show your owner for approval. Nothing ran. Use smaller arguments.");
    let impactJson: string | null = input.campaign ? JSON.stringify(input.campaign) : input.impact === undefined ? null : JSON.stringify(input.impact);
    if (input.campaign && impactJson!.length > ARGUMENTS_LIMIT) throw new AssistantRefusal("This campaign's settings are too large to review. No campaign was started.");
    if (impactJson && impactJson.length > ARGUMENTS_LIMIT) impactJson = JSON.stringify("The preview is too large to show here; open the target to inspect it.");
    this.db.prepare(`DELETE FROM assistant_owner_confirmations AS c WHERE status NOT IN ('pending','approved') AND resolved_at<?
      AND NOT EXISTS (SELECT 1 FROM human_campaign_launches h
        WHERE c.operation=? AND h.user_id=c.owner_user_id AND h.request_id='assistant-'||c.id)`).run(now - RETENTION_MS, ASSISTANT_CAMPAIGN_START);
    const id = `aoc_${randomUUID()}`;
    this.db.prepare(`INSERT INTO assistant_owner_confirmations
      (id,connection_id,thread_id,owner_user_id,organization_id,operation,command_id,binding_json,arguments_json,target_json,target_label,impact_json,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, binding.connectionId, thread.threadId, thread.ownerUserId, thread.organizationId, binding.operation, input.commandId,
        bindingJson, argumentsJson, JSON.stringify(input.target), targetLabel, impactJson, now, now + ASSISTANT_OWNER_CONFIRMATION_TTL_MS);
    this.changed(thread.threadId);
    return this.view(this.row(id)!);
  }

  get(id: string): AssistantOwnerConfirmation | null {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }

  /** The stored command, for the control plane's run of an approval. */
  command(id: string): { connectionId: string; threadId: string; ownerUserId: string; organizationId: string; operation: string;
    commandId: string; args: Record<string, unknown>; campaign?: CampaignConfirmationPreview } | null {
    const row = this.row(id);
    return row ? { connectionId: row.connection_id, threadId: row.thread_id, ownerUserId: row.owner_user_id, organizationId: row.organization_id,
      operation: row.operation, commandId: row.command_id, args: JSON.parse(row.arguments_json) as Record<string, unknown>,
      ...(row.operation === ASSISTANT_CAMPAIGN_START && row.impact_json ? { campaign: JSON.parse(row.impact_json) as CampaignConfirmationPreview } : {}) } : null;
  }

  reviseCampaign(id: string, expectedDigest: string, binding: OwnerConfirmationBinding, campaign: CampaignConfirmationPreview,
    targetLabel: string, now = Date.now()): AssistantOwnerConfirmation | null {
    const row = this.row(id);
    if (!row || row.operation !== ASSISTANT_CAMPAIGN_START || (JSON.parse(row.binding_json) as OwnerConfirmationBinding).targetDigest !== expectedDigest) return null;
    const json = JSON.stringify(campaign);
    if (json.length > ARGUMENTS_LIMIT) throw new AssistantRefusal("This campaign's settings are too large to review. No campaign was started.");
    const changed = this.db.prepare(`UPDATE assistant_owner_confirmations SET binding_json=?, impact_json=?, target_label=?
      WHERE id=? AND status='pending' AND expires_at>? AND binding_json=?`)
      .run(JSON.stringify(binding), json, targetLabel, id, now, row.binding_json).changes;
    if (!changed) return null;
    this.changed(row.thread_id);
    return this.get(id);
  }

  /** Durable record of independent roots. The Human launch and its identity commit together. */
  launchedCampaignIds(threadId: string): string[] {
    return (this.db.prepare(`SELECT h.session_id FROM assistant_owner_confirmations c
      JOIN human_campaign_launches h ON h.user_id=c.owner_user_id AND h.request_id='assistant-'||c.id
      WHERE c.thread_id=? AND c.operation=? AND c.status='executed' ORDER BY c.resolved_at, h.session_id`)
      .all(threadId, ASSISTANT_CAMPAIGN_START) as {session_id: string}[]).map(row => row.session_id);
  }

  /** The thread's requests waiting for its owner, oldest first. */
  pendingForThread(threadId: string, now = Date.now()): AssistantOwnerConfirmation[] {
    return (this.db.prepare(`SELECT * FROM assistant_owner_confirmations WHERE thread_id=? AND status='pending' AND expires_at>?
      ORDER BY created_at, id`).all(threadId, now) as unknown as Row[]).map(row => this.view(row));
  }

  /** The owner's answer is recorded before anything runs. Returns whether this request is now
   * approved and not yet run: `pending` moves to `approved`, and an `approved` one left by an
   * interrupted run is returned for its run to finish. */
  approve(id: string, owner: HumanPrincipal, now = Date.now()): boolean {
    const row = this.row(id);
    if (!row || row.owner_user_id !== owner.userId || row.organization_id !== owner.organizationId) return false;
    if (row.status === "approved") return true;
    const changed = this.db.prepare("UPDATE assistant_owner_confirmations SET status='approved' WHERE id=? AND status='pending' AND expires_at>?").run(id, now).changes > 0;
    if (changed) this.changed(row.thread_id);
    return changed;
  }

  /** Called inside the command's receipt reservation: the approved request is spent together
   * with the reservation, or not at all. It must match the binding the command computed now. */
  consumeApproved(id: string, binding: OwnerConfirmationBinding, now = Date.now()): boolean {
    return this.db.prepare(`UPDATE assistant_owner_confirmations SET status='executed', resolved_at=?
      WHERE id=? AND status='approved' AND binding_json=?`).run(now, id, JSON.stringify(binding)).changes > 0;
  }

  /** Records what happened to a request that ended. Only an open request (or, for `executed`,
   * the outcome of one that ran) is changed. */
  finish(id: string, status: Exclude<AssistantOwnerConfirmationStatus, "pending" | "approved">,
    outcome: AssistantOwnerConfirmation["outcome"], now = Date.now()): AssistantOwnerConfirmation | null {
    const row = this.row(id);
    if (!row) return null;
    const from = status === "executed" ? ["executed"] : status === "refused" ? ["pending", "approved"] : ["pending"];
    const changed = this.db.prepare(`UPDATE assistant_owner_confirmations SET status=?, resolved_at=COALESCE(resolved_at, ?), outcome_json=?
      WHERE id=? AND status IN (${from.map(() => "?").join(",")})`).run(status, now, outcome ? JSON.stringify(outcome) : null, id, ...from).changes > 0;
    if (changed) this.changed(row.thread_id);
    return changed ? this.view(this.row(id)!) : null;
  }

  /** Pending requests whose time is up. */
  due(now = Date.now()): string[] {
    return (this.db.prepare("SELECT id FROM assistant_owner_confirmations WHERE status='pending' AND expires_at<=?").all(now) as {id: string}[]).map(row => row.id);
  }

  /** Open requests of one connection, for refusing them all when it is revoked. */
  openForConnection(connectionId: string): string[] {
    return (this.db.prepare("SELECT id FROM assistant_owner_confirmations WHERE connection_id=? AND status IN ('pending','approved')").all(connectionId) as {id: string}[]).map(row => row.id);
  }

  /** Approved requests whose run was interrupted, for finishing after a restart. */
  approved(): string[] {
    return (this.db.prepare("SELECT id FROM assistant_owner_confirmations WHERE status='approved'").all() as {id: string}[]).map(row => row.id);
  }

  /** Requests whose run spent them but whose outcome was never recorded (a restart in between). */
  executedWithoutOutcome(): string[] {
    return (this.db.prepare("SELECT id FROM assistant_owner_confirmations WHERE status='executed' AND outcome_json IS NULL").all() as {id: string}[]).map(row => row.id);
  }

  /** Ended requests whose outcome has not reached the assistant yet, oldest first. */
  unnotified(): Array<{ id: string; resolvedAt: number }> {
    return (this.db.prepare(`SELECT id, resolved_at FROM assistant_owner_confirmations
      WHERE status IN ('executed','denied','expired','refused') AND notified_at IS NULL AND outcome_json IS NOT NULL
      ORDER BY resolved_at, id`).all() as {id: string; resolved_at: number}[]).map(row => ({ id: row.id, resolvedAt: row.resolved_at }));
  }

  markNotified(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE assistant_owner_confirmations SET notified_at=? WHERE id=? AND notified_at IS NULL").run(now, id);
  }

  view(row: Row): AssistantOwnerConfirmation {
    const target = JSON.parse(row.target_json) as AssistantTarget;
    const campaign = row.operation === ASSISTANT_CAMPAIGN_START && row.impact_json ? JSON.parse(row.impact_json) as CampaignConfirmationPreview : undefined;
    const args = JSON.parse(row.arguments_json) as Record<string, unknown>;
    return {
      id: row.id,
      threadId: row.thread_id,
      operation: row.operation,
      title: ownerConfirmationTitle(row.operation),
      summary: ownerConfirmationSummary(row.operation),
      target: { kind: target.kind, id: target.id, label: row.target_label },
      impact: campaign?.facts ?? impactLines(row.impact_json === null ? undefined : JSON.parse(row.impact_json)),
      arguments: campaign ? [{ label: "First Message", value: String(args.prompt) }] : argumentLines(args),
      ...(campaign ? { campaign: { digest: (JSON.parse(row.binding_json) as OwnerConfirmationBinding).targetDigest, budget: campaign.budget } } : {}),
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
      ...(row.outcome_json ? { outcome: JSON.parse(row.outcome_json) as AssistantOwnerConfirmation["outcome"] } : {}),
    };
  }
}

/** Marks the stored arguments as owner-approved for the operation's own confirmation check. The
 * value grants nothing: only `assistantCallContext` during the approved run can spend a request. */
export const OWNER_APPROVED_CONFIRMATION = "owner-approved";

export class AssistantOwnerConfirmationRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface AssistantOwnerConfirmationServiceDeps {
  store: AssistantOwnerConfirmations;
  /** The command's receipt status after the approved run. */
  receiptStatus(connectionId: string, commandId: string): NonNullable<AssistantOwnerConfirmation["outcome"]>["receiptStatus"] | undefined;
  campaignOutcome?(confirmationId: string): AssistantOwnerConfirmation["outcome"];
  /** `AssistantOperations.callOwnerApproved`. */
  run(connectionId: string, operation: string, args: Record<string, unknown>, ownerConfirmationId: string): Promise<unknown>;
  /** Tells the thread's assistant how its request ended, as a message in its own conversation.
   * `delivered` once its session admitted it; `retry` when it could not now (its runner is
   * offline, say); `gone` when the thread or its session ended, so nobody can hear it. */
  tell(threadId: string, text: string): "delivered" | "retry" | "gone";
  now?(): number;
}

const NOTICE = "[Wollipog Owner Confirmation]";
/** An outcome undelivered this long after its request ended is no longer news to the assistant. */
export const OWNER_CONFIRMATION_NOTICE_RETRY_MS = 24 * 60 * 60 * 1000;

/** The owner's answers to Wollipog Assistant thread confirmations (#4665). Approving runs the
 * exact bound command once through its operation's receipt path; denial, expiry or a revoked
 * thread refuse it. The assistant hears how each request ended and resumes. */
export class AssistantOwnerConfirmationService {
  /** One run per request in this process; a repeated Approve waits for the same run. */
  private readonly running = new Map<string, Promise<AssistantOwnerConfirmation>>();
  constructor(private readonly deps: AssistantOwnerConfirmationServiceDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private owned(owner: HumanPrincipal, threadId: string, id: string): AssistantOwnerConfirmation {
    const confirmation = this.deps.store.get(id);
    const command = this.deps.store.command(id);
    if (!confirmation || !command || confirmation.threadId !== threadId || command.ownerUserId !== owner.userId ||
      command.organizationId !== owner.organizationId) throw new AssistantOwnerConfirmationRefusal("Confirmation not found for this thread.", 404);
    return confirmation;
  }

  /** Approve Once. Records the approval, then runs the bound command and returns how it ended.
   * Approving a request that already ended returns it unchanged and runs nothing. */
  async approve(owner: HumanPrincipal, threadId: string, id: string, campaignDigest?: string): Promise<AssistantOwnerConfirmation> {
    const current = this.owned(owner, threadId, id);
    if (current.campaign?.digest !== campaignDigest || (current.operation === ASSISTANT_CAMPAIGN_START && !current.campaign)) {
      throw new AssistantOwnerConfirmationRefusal("Review the current campaign settings before approving this launch.", 409);
    }
    if (current.campaign && !current.campaign.budget) {
      throw new AssistantOwnerConfirmationRefusal("Set a campaign budget before approving this launch.", 409);
    }
    const inFlight = this.running.get(id);
    if (inFlight) return inFlight;
    if (!this.deps.store.approve(id, owner, this.now())) {
      if (current.status === "pending" && current.expiresAt <= this.now()) return this.end(id, "expired") ?? this.deps.store.get(id)!;
      return this.deps.store.get(id)!;
    }
    return this.execute(id);
  }

  deny(owner: HumanPrincipal, threadId: string, id: string): AssistantOwnerConfirmation {
    this.owned(owner, threadId, id);
    return this.end(id, "denied") ?? this.deps.store.get(id)!;
  }

  /** Expires every request whose time is up. */
  expireDue(): void {
    for (const id of this.deps.store.due(this.now())) this.end(id, "expired");
  }

  /** The thread's connection was revoked (archive, deletion or the owner): nothing it asked runs. */
  refuseOpen(connectionId: string): void {
    for (const id of this.deps.store.openForConnection(connectionId)) {
      if (!this.running.has(id)) this.deps.store.finish(id, "refused", { reason: "The thread's Assistant connection was revoked." }, this.now());
    }
    this.deliverNotices();
  }

  /** After a restart: finishes approved runs that were interrupted. A run whose receipt
   * reservation already committed spent its request then, so it cannot run again; only its
   * outcome is recorded from its receipt. Then delivers every outcome the assistant missed. */
  async resumeInterrupted(): Promise<void> {
    for (const id of this.deps.store.approved()) if (!this.running.has(id)) await this.execute(id);
    for (const id of this.deps.store.executedWithoutOutcome()) {
      if (this.running.has(id)) continue;
      const command = this.deps.store.command(id)!;
      const receiptStatus = this.deps.receiptStatus(command.connectionId, command.commandId);
      this.deps.store.finish(id, "executed", this.deps.campaignOutcome?.(id) ?? (receiptStatus ? { receiptStatus } : {}), this.now());
    }
    this.deliverNotices();
  }

  /** Delivers each ended request's outcome to its assistant until its session admits it, so a
   * runner that was offline, or a restart, never loses one. Called after each outcome and on a
   * timer. A thread that ended, or an outcome older than a day, is not retried. */
  deliverNotices(): void {
    const now = this.now();
    for (const { id, resolvedAt } of this.deps.store.unnotified()) {
      const view = this.deps.store.get(id), command = this.deps.store.command(id);
      if (!view || !command) continue;
      let delivery: "delivered" | "retry" | "gone";
      try { delivery = this.deps.tell(view.threadId, this.notice(view, command.commandId)); } catch { delivery = "retry"; }
      if (delivery !== "retry" || now - resolvedAt >= OWNER_CONFIRMATION_NOTICE_RETRY_MS) this.deps.store.markNotified(id, now);
    }
  }

  private execute(id: string): Promise<AssistantOwnerConfirmation> {
    const run = this.runApproved(id).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  private async runApproved(id: string): Promise<AssistantOwnerConfirmation> {
    const command = this.deps.store.command(id)!;
    let reason: string | undefined;
    try {
      const result = await this.deps.run(command.connectionId, command.operation, { ...command.args, confirmationId: OWNER_APPROVED_CONFIRMATION }, id);
      const error = result && typeof result === "object" ? (result as { error?: unknown }).error : undefined;
      if (typeof error === "string") reason = error;
    } catch (error) {
      // Refusals are written for the assistant and owner; anything else may hold private detail.
      reason = error instanceof AssistantRefusal ? error.message : "The command failed. Inspect its target in Wollipog.";
    }
    const after = this.deps.store.get(id)!;
    if (after.status === "executed") {
      const receiptStatus = this.deps.receiptStatus(command.connectionId, command.commandId);
      const view = this.deps.store.finish(id, "executed", { ...(receiptStatus ? { receiptStatus } : {}),
        ...this.deps.campaignOutcome?.(id), ...(reason ? { reason } : {}) }, this.now()) ?? after;
      this.deliverNotices();
      return view;
    }
    if (after.status === "approved") {
      const view = this.deps.store.finish(id, "refused", { reason: reason ?? "The command did not run." }, this.now()) ?? after;
      this.deliverNotices();
      return view;
    }
    return after;
  }

  private end(id: string, status: "denied" | "expired"): AssistantOwnerConfirmation | null {
    const view = this.deps.store.finish(id, status, { reason: status === "denied" ? "The owner denied it." : "The owner did not answer in time." }, this.now());
    if (view) this.deliverNotices();
    return view;
  }

  private notice(view: AssistantOwnerConfirmation, commandId: string): string {
    const what = `"${view.title}" (${view.operation}) on ${view.target.kind} ${view.target.label} (${view.target.id}), command ${commandId}`;
    return view.status === "executed"
      ? `${NOTICE} Your owner approved ${what}. Wollipog ran it once; its receipt reads ${view.outcome?.receiptStatus ?? "unknown"}.` +
        `${view.outcome?.sessionId ? ` Campaign Session: ${view.outcome.sessionId}.` : ""}` +
        `${view.outcome?.reason ? ` ${view.outcome.reason}` : ""} Never send that command again: read its receipt and target, then continue.`
      : view.status === "denied"
        ? `${NOTICE} Your owner denied ${what}. Nothing ran. Continue without it, and ask your owner before requesting it again.`
        : view.status === "expired"
          ? `${NOTICE} Your request for ${what} expired before your owner answered. Nothing ran. Ask your owner before requesting it again.`
          : `${NOTICE} Your request for ${what} was refused, so nothing ran: ${view.outcome?.reason ?? "it no longer matched."}`;
  }
}
