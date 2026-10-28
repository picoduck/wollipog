import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_REVIEW_SETTINGS, agentHarnessIdentityKey, builtInAgentHarnessName, canonicalAgentHarnessIdentity,
  reviewModelSupported, reviewerHarnessFor, sameReviewFamily,
  type AgentCapabilities, type AgentDriverKind, type AgentHarnessIdentity, type ReviewConfiguration, type ReviewReviewerRule, type ReviewSettings, type ReviewSettingsView,
  type RunnerView, type SessionView,
  type OrchestratorReviewPolicy, type SessionReviewPolicySnapshot,
} from "@wollipog/protocol";
import { agentHarnessIdentityFor, parseAgentHarnessIdentity } from "./agent-harness-defaults.js";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\x00-\x1f\x7f]/u.test(v);

export function reviewReviewerCatalog(runners: readonly RunnerView[]): ReviewSettingsView["reviewers"] {
  return runners.filter(r => r.status === "online" && r.runtime?.reviewSession?.configuration === true).flatMap(r =>
    (r.runtime?.reviewSession?.reviewers ?? []).flatMap(entry => {
      const agent = r.agents.find(a => a.id === entry.agentId && a.available === true);
      return agent?.capabilities ? [{ ...entry, name: entry.harness === "codex" ? "Codex" : "Claude Code",
        runnerId: r.runnerId, capabilities: agent.capabilities }] : [];
    }));
}

export interface ReviewPolicyCapture {
  fields: OrchestratorReviewPolicy;
  implementer: AgentHarnessIdentity;
  resolveModel?: (harness: "codex" | "claude-code", model: string | null, effort: string) => string | null;
}

export function parseReviewSettings(value: unknown): ReviewSettings | null {
  if (!object(value) || Object.keys(value).some(k => !["version", "roundBudget", "reviewers"].includes(k)) || value.version !== 1 ||
      !Number.isSafeInteger(value.roundBudget) || (value.roundBudget as number) < 1 || (value.roundBudget as number) > 32 ||
      !Array.isArray(value.reviewers) || value.reviewers.length > 100) return null;
  const reviewers: ReviewReviewerRule[] = [];
  const keys = new Set<string>();
  for (const rule of value.reviewers) {
    if (!object(rule) || Object.keys(rule).some(k => !["implementer", "harness", "model", "effort", "allowSameFamily"].includes(k))) return null;
    const identity = parseAgentHarnessIdentity(rule.implementer);
    if (!identity || (rule.harness !== "codex" && rule.harness !== "claude-code") ||
        (rule.model !== null && !identifier(rule.model)) || (rule.effort !== null && !identifier(rule.effort)) ||
        typeof rule.allowSameFamily !== "boolean") return null;
    const implementer = canonicalAgentHarnessIdentity(identity);
    const key = agentHarnessIdentityKey(implementer);
    if (keys.has(key)) return null;
    keys.add(key);
    reviewers.push({ implementer, harness: rule.harness, model: rule.model, effort: rule.effort, allowSameFamily: rule.allowSameFamily });
  }
  return { version: 1, roundBudget: value.roundBudget as number, reviewers };
}

export class ReviewSettingsStore {
  constructor(private readonly sql: DatabaseSync) {
    sql.exec(`CREATE TABLE IF NOT EXISTS review_settings (
      user_id TEXT NOT NULL REFERENCES identity_users(user_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS review_settings_session_users (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES identity_users(user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS session_review_policy_snapshots (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      policy TEXT NOT NULL
    )`);
  }
  sessionUser(sessionId: string): string | null {
    const row = this.sql.prepare("SELECT user_id FROM review_settings_session_users WHERE session_id=?")
      .get(sessionId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }
  attributeSession(sessionId: string, userId: string): void {
    this.sql.prepare(`INSERT INTO review_settings_session_users(session_id,user_id)
      SELECT ?,user_id FROM identity_users WHERE user_id=?`).run(sessionId, userId);
  }
  get(userId: string, projectId: string | null = null): ReviewSettings | null {
    const row = this.sql.prepare("SELECT settings FROM review_settings WHERE user_id=? AND project_id=?")
      .get(userId, projectId ?? "") as { settings: string } | undefined;
    return row ? parseReviewSettings(JSON.parse(row.settings)) : null;
  }
  set(userId: string, projectId: string | null, settings: ReviewSettings | null): void {
    if (!settings) { this.sql.prepare("DELETE FROM review_settings WHERE user_id=? AND project_id=?").run(userId, projectId ?? ""); return; }
    const parsed = parseReviewSettings(settings);
    if (!parsed) throw new Error("invalid review settings");
    this.sql.prepare(`INSERT INTO review_settings(user_id,project_id,settings,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,project_id) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at`)
      .run(userId, projectId ?? "", JSON.stringify(parsed), Date.now());
  }
  effective(userId: string, projectId: string | null): { settings: ReviewSettings; source: ReviewSettingsView["source"] } {
    const project = projectId ? this.get(userId, projectId) : null;
    const user = this.get(userId);
    return project ? { settings: project, source: "project_override" } : user ? { settings: user, source: "user_default" }
      : { settings: structuredClone(DEFAULT_REVIEW_SETTINGS), source: "system_default" };
  }
  captureSessionPolicy(sessionId: string, userId: string | null, projectId: string | null, capture: ReviewPolicyCapture): void {
    const effective = userId ? this.effective(userId, projectId) : { settings: DEFAULT_REVIEW_SETTINGS, source: "system_default" as const };
    const rule = effective.settings.reviewers.find(r => agentHarnessIdentityKey(r.implementer) === agentHarnessIdentityKey(capture.implementer));
    const fields = capture.fields;
    const fixed = Object.values(fields).some(value => value !== null);
    const harness = fields.reviewHarness ?? rule?.harness ?? reviewerHarnessFor(capture.implementer.driver);
    // A model/effort saved for Codex cannot become a Claude choice when policy fixes the harness.
    const matchingRule = rule?.harness === harness ? rule : undefined;
    const effort = fields.reviewEffort ?? matchingRule?.effort ?? "high";
    const requestedModel = fields.reviewModel ?? matchingRule?.model ?? null;
    const policy: SessionReviewPolicySnapshot = {
      reviewHarness: harness,
      reviewModel: requestedModel ?? (harness ? capture.resolveModel?.(harness, requestedModel, effort) : null) ?? null,
      reviewEffort: effort,
      reviewRoundBudget: fields.reviewRoundBudget ?? effective.settings.roundBudget,
      configured: fixed || effective.source !== "system_default",
      source: fixed ? "campaign_policy" : effective.source,
    };
    this.sql.prepare("INSERT INTO session_review_policy_snapshots(session_id,policy) VALUES (?,?)").run(sessionId, JSON.stringify(policy));
  }
  sessionPolicy(sessionId: string): SessionReviewPolicySnapshot | undefined {
    const row = this.sql.prepare("SELECT policy FROM session_review_policy_snapshots WHERE session_id=?").get(sessionId) as { policy: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.policy) as SessionReviewPolicySnapshot;
  }
}

export class ReviewSettingsService {
  constructor(private readonly db: ControlPlaneDb) {}
  view(principal: HumanPrincipal, projectId: string | null): ReviewSettingsView {
    if (projectId && !this.db.canAccessProject(principal, projectId)) throw new ReviewSettingsError("Project not found.", 404);
    const effective = this.db.reviewSettings.effective(principal.userId, projectId);
    const runners = this.db.listRunnersForPrincipal(principal);
    const implementers = new Map<string, AgentHarnessIdentity & { name: string }>();
    for (const runner of runners) for (const agent of runner.agents) {
      const identity = canonicalAgentHarnessIdentity(agentHarnessIdentityFor(agent));
      implementers.set(agentHarnessIdentityKey(identity), { ...identity, name: builtInAgentHarnessName(identity.driver) ?? agent.name });
    }
    // A saved rule stays editable when its implementing harness disappears.
    for (const rule of effective.settings.reviewers) if (!implementers.has(agentHarnessIdentityKey(rule.implementer))) {
      implementers.set(agentHarnessIdentityKey(rule.implementer), { ...rule.implementer,
        name: builtInAgentHarnessName(rule.implementer.driver) ?? rule.implementer.agentId });
    }
    // Runtime diagnostics are redacted from ordinary members' runner projections. Discover the
    // safe reviewer catalog internally after filtering runner access; expose no diagnostic paths.
    const reviewers = reviewReviewerCatalog(runners.map(r => this.db.getRunner(r.runnerId)!));
    return { ...effective, projectId, projects: this.db.listProjectsForPrincipal(principal).map(p => ({ id: p.id, name: p.name })),
      implementers: [...implementers.values()], reviewers };
  }
  update(principal: HumanPrincipal, projectId: string | null, value: unknown): ReviewSettingsView {
    const view = this.view(principal, projectId);
    const parsed = value === null ? null : parseReviewSettings(value);
    if (value !== null && !parsed) throw new ReviewSettingsError("Choose valid review settings and a whole round budget from 1 to 32.", 400);
    for (const rule of parsed?.reviewers ?? []) {
      const previous = view.settings.reviewers.find(r => agentHarnessIdentityKey(r.implementer) === agentHarnessIdentityKey(rule.implementer));
      // Previously admitted choices remain editable while their machine is offline. New choices
      // still need live discovery; retaining a rule never authorizes a fallback at review time.
      if (previous && JSON.stringify(previous) === JSON.stringify(rule)) continue;
      if (!view.implementers.some(i => agentHarnessIdentityKey(i) === agentHarnessIdentityKey(rule.implementer))) {
        throw new ReviewSettingsError("Choose a configured implementing harness.", 400);
      }
      if (!rule.allowSameFamily && sameReviewFamily(rule.implementer.driver, null, rule.harness, rule.model)) {
        throw new ReviewSettingsError("This reviewer belongs to the implementer's model family. Explicitly allow same-family reviews to use it.", 409);
      }
      if (!view.reviewers.some(r => r.harness === rule.harness && reviewModelSupported(r.capabilities, rule.model ?? undefined, rule.effort ?? "high"))) {
        throw new ReviewSettingsError(`The configured ${rule.harness} reviewer (${rule.model ?? "default model"}, ${rule.effort ?? "high"} effort) is unavailable. Connect a machine with that reviewer or choose another discovered combination.`, 409);
      }
    }
    this.db.reviewSettings.set(principal.userId, projectId, parsed);
    return this.view(principal, projectId);
  }
}

export class ReviewSettingsError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** Null preserves the legacy launch exactly when there is no settings row. */
export function configuredReview(db: ControlPlaneDb, session: SessionView, runner: RunnerView | null,
  resolveModelEffort: (config: { model?: string; effort?: string }, capabilities: AgentCapabilities | undefined,
    driver: AgentDriverKind) => { value?: { model: string; effort: string }; error?: string }):
  { harness: "codex" | "claude-code"; configuration: ReviewConfiguration } | null {
  const scope = db.sessionScope(session.id);
  const userId = db.reviewSettings.sessionUser(session.id) ?? (scope?.owner.kind === "user" ? scope.owner.userId : null);
  const snapshot = db.reviewSettings.sessionPolicy(session.id);
  if (!userId && !snapshot) return null;
  const effective = userId ? db.reviewSettings.effective(userId, session.projectId ?? null)
    : { settings: DEFAULT_REVIEW_SETTINGS, source: "system_default" as const };
  if (snapshot ? !snapshot.configured : effective.source === "system_default") return null;
  const agent = runner?.agents.find(a => a.id === session.agentId);
  const identity = agent ? agentHarnessIdentityFor(agent) : { agentId: session.agentId ?? "unknown", driver: session.driver ?? "acp", context: { kind: "native" as const } };
  const rule = effective.settings.reviewers.find(r => agentHarnessIdentityKey(r.implementer) === agentHarnessIdentityKey(identity));
  const harness = snapshot ? snapshot.reviewHarness : rule?.harness ?? reviewerHarnessFor(session.driver);
  if (!harness) throw new ReviewSettingsError("Choose a reviewer for this implementing harness in Settings → Reviews.", 409);
  const requestedModel = snapshot ? snapshot.reviewModel : rule?.model;
  const effort = (snapshot ? snapshot.reviewEffort : rule?.effort) ?? "high";
  if (runner?.runtime?.reviewSession?.configuration !== true) {
    throw new ReviewSettingsError(`This machine cannot apply the configured ${harness} reviewer (${requestedModel ?? "default model"}, ${effort} effort). Update Wollipog on it before requesting a review.`, 409);
  }
  const reviewerId = runner.runtime.reviewSession.reviewers.find(r => r.harness === harness)?.agentId;
  const reviewer = runner.agents.find(a => a.id === reviewerId && a.available === true);
  // Use the same concrete-model resolution as createSession. The catalog's "default" entry is a
  // UI placeholder, never an immutable launch model that the runner can compare with its spec.
  const resolved = resolveModelEffort({ ...(requestedModel ? { model: requestedModel } : {}), effort }, reviewer?.capabilities,
    harness === "codex" ? "codex-app-server" : "claude-code");
  const model = resolved.value?.model;
  if (!reviewer || resolved.error || !model ||
      requestedModel != null && !reviewModelSupported(reviewer.capabilities, requestedModel, effort) ||
      !reviewModelSupported(reviewer.capabilities, model, effort)) {
    throw new ReviewSettingsError(`The configured ${harness} reviewer (${requestedModel ?? "default model"}, ${effort} effort) is unavailable on this session's machine. ${snapshot ? "Restore it or launch a new child with an updated review policy." : "Restore it or change Settings → Reviews."}`, 409);
  }
  if (!rule?.allowSameFamily && sameReviewFamily(session.driver, session.model, harness, model)) {
    throw new ReviewSettingsError("The configured reviewer belongs to the implementer's model family. Explicitly allow same-family reviews in Settings → Reviews or choose another reviewer.", 409);
  }
  return { harness, configuration: { ...(model ? { model } : {}), effort,
    allowSameFamily: rule?.allowSameFamily ?? false, roundBudget: snapshot?.reviewRoundBudget ?? effective.settings.roundBudget } };
}
