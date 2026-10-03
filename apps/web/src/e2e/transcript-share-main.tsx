import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CreateTranscriptShareRequest, CreateTranscriptShareResult, TranscriptShareView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { TranscriptShareDialog } from "../components/TranscriptShareDialog.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import "../styles.css";

/**
 * Share Transcript (#2148) in a real browser, where control heights, row anatomy, the stacked Revoke
 * Link confirmation and the phone sheet are layout.
 *
 * `?state=` picks what the server holds: `ready` (the default: an active, an expired and a revoked
 * link), `empty`, `loading` (the list never arrives), `load-error`, or `unavailable` (the page is on
 * loopback, so no other browser could open a link). `?delay=<ms>` holds Create Link and Revoke Link
 * that long, `?theme=light` switches theme, and `?untitled=1` gives the session no title. The active
 * link includes the session title (#2189). The dialog opens on load; Share reopens it.
 */

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "ready";
const delay = Number(params.get("delay") ?? 0);
const sessionTitle = params.get("untitled") === "1" ? "" : "Fix the flaky login test on CI";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOKEN = "q7Lr2xVb9KcT4mWn8PzY3sHd6FgJ1aEu5oRi0tXkQwB";
const now = Date.now();
let sequence = 0;

let shares: TranscriptShareView[] = state === "ready" || state === "unavailable" ? [
  { shareId: "share-active", sessionId: "s_1", createdByUserId: "user-1", createdAt: now - 2 * HOUR, expiresAt: now + 7 * DAY - 2 * HOUR, status: "active", includesTitle: true },
  { shareId: "share-revoked", sessionId: "s_1", createdByUserId: "user-1", createdAt: now - 3 * DAY, expiresAt: now + 27 * DAY, status: "revoked", revokedAt: now - 2 * DAY },
  { shareId: "share-expired", sessionId: "s_1", createdByUserId: "user-1", createdAt: now - 10 * DAY, expiresAt: now - 9 * DAY, status: "expired" },
] : [];

const wait = () => new Promise((resolve) => window.setTimeout(resolve, delay));

const client: ApiClient = {
  ...api,
  async transcriptShares() {
    if (state === "loading") return new Promise<never>(() => undefined);
    if (state === "load-error") throw new Error("GET /api/sessions/s_1/transcript-shares failed: 502 Bad Gateway");
    return { shares };
  },
  async createTranscriptShare(_id: string, body: CreateTranscriptShareRequest): Promise<CreateTranscriptShareResult> {
    await wait();
    const created = Date.now();
    const share: TranscriptShareView = {
      shareId: `share-new-${++sequence}`,
      sessionId: "s_1",
      createdByUserId: "user-1",
      createdAt: created,
      expiresAt: created + body.expiresInSeconds * 1000,
      status: "active",
      ...(body.includeTitle === true ? { includesTitle: true as const } : {}),
    };
    shares = [share, ...shares];
    return { share, token: TOKEN };
  },
  async revokeTranscriptShare(_id: string, shareId: string) {
    await wait();
    const share = { ...shares.find((item) => item.shareId === shareId)!, status: "revoked" as const, revokedAt: Date.now() };
    shares = shares.map((item) => item.shareId === shareId ? share : item);
    return { share };
  },
};

/** A remote instance another browser can reach, as from a LAN or Tailscale address. */
const reachable: InstanceManager = {
  ...browserInstanceManager,
  activeProfile: {
    id: "remote-studio",
    serverInstanceId: "remote-studio",
    kind: "remote",
    label: "Studio",
    origin: "https://studio.tailnet.ts.net",
    createdAt: "",
  },
};

function Harness() {
  const [open, setOpen] = useState(true);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <ApiProvider client={client}>
      <InstancesContextProvider value={state === "unavailable" ? browserInstanceManager : reachable}>
        <FeedbackProvider>
          <main className="page">
            <button ref={opener} className="btn" type="button" onClick={() => setOpen(true)}>Share</button>
          </main>
          {open && <TranscriptShareDialog sessionId="s_1" sessionTitle={sessionTitle} onClose={() => setOpen(false)} returnFocusRef={opener} />}
        </FeedbackProvider>
      </InstancesContextProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
