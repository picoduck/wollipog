import type { SessionEventsResponse } from "@wollipog/protocol";

/** Test fixtures that inspect the whole transcript must drain pages, including an unfinished cache.
 * Keep the generation pinned so a replaced log cannot be spliced into the collected transcript. */
export async function readSessionEventHistory(
  origin: string,
  token: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionEventsResponse> {
  const deadline = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const events: SessionEventsResponse["events"] = [];
  let after = 0;
  let eventEpoch: number | undefined;
  for (;;) {
    requestSignal.throwIfAborted();
    const query = new URLSearchParams({ after: String(after), limit: "200" });
    if (eventEpoch !== undefined) query.set("eventEpoch", String(eventEpoch));
    const response = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`event lookup failed: ${response.status} ${await response.text()}`);
    const page = await response.json() as SessionEventsResponse;
    if (page.eventEpoch === undefined || page.nextAfter === undefined || page.cacheComplete === undefined) {
      throw new Error("event lookup did not return paging metadata");
    }
    if (eventEpoch !== undefined && page.eventEpoch !== eventEpoch) {
      throw new Error("session event history was replaced");
    }
    eventEpoch = page.eventEpoch;
    if (page.nextAfter < after || ((page.events.length > 0 || page.hasMoreCached) && page.nextAfter <= after)) {
      throw new Error("event lookup did not advance its cursor");
    }
    events.push(...page.events);
    after = page.nextAfter;
    if (!page.hasMoreCached && page.cacheComplete) return { ...page, events };
    if (!page.hasMoreCached) await new Promise(resolve => setTimeout(resolve, 50));
  }
}
