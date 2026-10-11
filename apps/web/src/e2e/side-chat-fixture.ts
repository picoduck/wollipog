import type { SessionEvent, SessionView, SideChatView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";

/**
 * Side Chat for the Sessions harness (#2863): `?sideChat=<state>` gives the open session a side chat
 * in one of the states the panel draws, and `window.__WOLLIPOG_SIDE_CHAT_E2E__.set(state)` moves it
 * to another. The child lives here, not in the harness's session model, so nothing else lists it.
 *
 * - `none`: no side chat yet; Start Side Chat creates one that is ready at once.
 * - `starting`: none yet, and a create request that stays in flight.
 * - `failed`: none yet, and a create request that gets no response.
 * - `conversation`: an idle side chat with one question and its answer.
 * - `replying`: the same, with a second question being answered.
 * - `ended`: a stopped side chat with its transcript.
 */
export type SideChatFixtureState = "none" | "starting" | "failed" | "conversation" | "replying" | "ended";

export const SIDE_CHAT_STATES: readonly SideChatFixtureState[] = ["none", "starting", "failed", "conversation", "replying", "ended"];

const CHILD_ID = "side-chat-child";

function event(seq: number, payload: SessionEvent["payload"]): SessionEvent {
  return { id: seq, sessionId: CHILD_ID, seq, ts: 1_700_000_000_000 + seq * 1000, payload };
}

const CONVERSATION: SessionEvent[] = [
  event(1, { kind: "user_message", text: "What does the --frozen-lockfile flag change in CI?", final: true }),
  event(2, { kind: "agent_message", final: true,
    text: "It makes `pnpm install` fail instead of updating `pnpm-lock.yaml` when the lockfile and `package.json` disagree, so CI installs exactly what was committed." }),
];
const REPLYING: SessionEvent[] = [
  ...CONVERSATION,
  event(3, { kind: "user_message", text: "Is it on by default?", final: true }),
  event(4, { kind: "agent_message", final: false, text: "In CI, yes: pnpm turns it on when it detects a CI environment" }),
];

export function installSideChatFixture(client: ApiClient, initial: SideChatFixtureState, lookup: (id: string) => SessionView | undefined) {
  let state = initial;
  let created: SideChatView | null = null;
  let parentId = "";
  const parentSession = () => lookup(parentId);

  const child = (status: SessionView["status"], activeTurnId?: string): SessionView => {
    const parent = parentSession();
    return {
      ...(parent ?? {} as SessionView),
      id: CHILD_ID,
      title: `Side chat: ${parent?.title ?? "Session"}`,
      status,
      activeTurnId,
      archived: true,
      useWorktree: true,
      eventEpoch: 0,
      pendingApproval: null,
      queued: [],
    } as SessionView;
  };
  const relation = (): SideChatView | null => {
    const parentSessionId = parentSession()?.id ?? "";
    if (state === "conversation") return { parentSessionId, session: child("idle"), createdAt: 1 };
    if (state === "replying") return { parentSessionId, session: child("running", "side-turn-2"), createdAt: 1 };
    if (state === "ended") return { parentSessionId, session: child("stopped"), createdAt: 1 };
    return created;
  };
  const events = (): SessionEvent[] => state === "replying" ? REPLYING
    : state === "conversation" || state === "ended" ? CONVERSATION : [];

  const base = {
    getSessionEventPage: client.getSessionEventPage,
    prompt: client.prompt,
    cancelTurn: client.cancelTurn,
  };
  Object.assign(client, {
    sideChat: async (id: string) => {
      parentId = id;
      return { sideChat: relation() };
    },
    createSideChat: async (id: string) => {
      if (state === "starting") return new Promise<never>(() => {});
      if (state === "failed") throw new TypeError("Failed to fetch");
      created = { parentSessionId: id, session: child("idle"), createdAt: Date.now() };
      return created;
    },
    getSessionEventPage: async (...args: Parameters<ApiClient["getSessionEventPage"]>) => {
      if (args[0] !== CHILD_ID) return base.getSessionEventPage(...args);
      const after = args[1] ?? 0;
      const page = events().filter((candidate) => candidate.seq > after);
      return { events: page, eventEpoch: 0, nextAfter: page.at(-1)?.seq ?? after, cacheComplete: true };
    },
    prompt: async (...args: Parameters<ApiClient["prompt"]>) => {
      if (args[0] !== CHILD_ID) return base.prompt(...args);
      return relation()?.session ?? child("idle");
    },
    cancelTurn: async (...args: Parameters<ApiClient["cancelTurn"]>) => {
      if (args[0] !== CHILD_ID) return base.cancelTurn(...args);
      if (state === "replying") state = "conversation";
      return relation()?.session ?? child("idle");
    },
  } satisfies Partial<ApiClient>);

  return {
    set(next: SideChatFixtureState) {
      state = next;
      created = null;
    },
    state: () => state,
  };
}
