import type { FastifyInstance } from "fastify";
import { CAMPAIGN_SESSION_PROTOCOL_ROUTES, RESIDUAL_SESSION_PROTOCOL_ROUTES } from "./campaign-session-protocol.js";

export type OwnerOperationCoverage =
  | {tools: string[]}
  | {exclusion: "human_authority" | "external_limitation" | "interactive_workspace_io"; reason: string; remedy: string}
  | {exclusion: "session_protocol"; reason: string; remedy: string; ownerTools?: string[]};
export interface OwnerParityGap {route: string; reason: string}

// These are runtime self-attestations, not owner API capabilities. Do not broaden this to a
// prefix/category matcher: every additional route needs its own owner-counterpart adjudication.
const SESSION_PROTOCOL_WRITES = new Set([
  "POST /api/sessions/:id/waits",
  "POST /api/sessions/:id/pull-request-watch",
]);
const CAMPAIGN_SESSION_PROTOCOL = new Set<string>([...CAMPAIGN_SESSION_PROTOCOL_ROUTES, ...RESIDUAL_SESSION_PROTOCOL_ROUTES]);

/** Observe actual Fastify registration, including routes generated in loops and shared services.
 * Source-string snapshots miss those routes and cannot prove that the production composition
 * registered a tool. No resource identifiers, request data, credentials or callbacks are observed. */
export class OwnerManagementInventory {
  private readonly routes = new Set<string>();
  attach(app: FastifyInstance): void {
    app.addHook("onRoute", route => {
      if (!/^\/api\/(?:sessions|projects|runners|automations|skills|skill-[\w-]+|orphaned-skill-copies|assistant-connections)(?:\/|$)/.test(route.url)) return;
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD" && method !== "OPTIONS") this.routes.add(`${method} ${route.url}`);
      }
    });
  }
  list(): string[] { return [...this.routes].sort(); }
  gaps(coverage: Readonly<Record<string, OwnerOperationCoverage>>, registeredTools: ReadonlySet<string>): OwnerParityGap[] {
    const gaps: OwnerParityGap[] = [];
    for (const route of this.list()) {
      const entry = coverage[route];
      if (!entry) { gaps.push({route, reason: "No Assistant operation or documented exclusion."}); continue; }
      if ("tools" in entry) {
        if (!entry.tools.length) gaps.push({route, reason: "Coverage must name an actual registered tool."});
        for (const tool of entry.tools) if (!registeredTools.has(tool)) gaps.push({route, reason: `Assistant operation ${tool} is not registered.`});
      } else if (entry.exclusion === "session_protocol") {
        if (!SESSION_PROTOCOL_WRITES.has(route) && !CAMPAIGN_SESSION_PROTOCOL.has(route)) gaps.push({route, reason: "Session-protocol classification is restricted to the explicitly adjudicated session-credential routes verified by production owner-403 tests."});
        if (!entry.reason.trim() || !entry.remedy.trim()) gaps.push({route, reason: "Session protocol requires the proven identity fence and supported runtime remedy."});
        if (SESSION_PROTOCOL_WRITES.has(route)) {
          if (!Array.isArray(entry.ownerTools) || entry.ownerTools.length !== 1 || entry.ownerTools[0] !== "session_watch_get") gaps.push({route, reason: "Session protocol requires the exact registered owner-facing read counterpart session_watch_get."});
          else for (const tool of entry.ownerTools) if (!registeredTools.has(tool)) gaps.push({route, reason: `Owner read counterpart ${tool} is not registered.`});
        } else if (CAMPAIGN_SESSION_PROTOCOL.has(route) && entry.ownerTools !== undefined) {
          gaps.push({route, reason: "Campaign session protocol must not claim an equivalent owner tool; the genuine matching credential is its remedy."});
        }
      } else if (!entry.reason.trim() || !entry.remedy.trim() || !["human_authority", "external_limitation", "interactive_workspace_io"].includes(entry.exclusion)) {
        gaps.push({route, reason: "Exclusions require human authority, a real external limitation, or defensible interactive workspace I/O, with a reason and supported remedy."});
      }
    }
    return gaps;
  }
  assertComplete(coverage: Readonly<Record<string, OwnerOperationCoverage>>, registeredTools: ReadonlySet<string>): void {
    const gaps = this.gaps(coverage, registeredTools);
    if (gaps.length) throw new Error(`Owner/Assistant parity is incomplete:\n${gaps.map(g => `${g.route}: ${g.reason}`).join("\n")}`);
  }
}
