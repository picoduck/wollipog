import React from "react";
import { createRoot } from "react-dom/client";
import type { OperationalTranscriptMessage, PublicTranscriptShare } from "@wollipog/protocol";
import { SharedTranscript } from "../components/SharedTranscript.js";
import "../styles.css";

/**
 * The page a transcript share link opens (#2173), in a real browser, where the gutters, the bubble
 * alignment and horizontal overflow are layout.
 *
 * `?state=` picks what the public endpoint answers: `ready` (the default: markdown, a table, a fenced
 * block, media links and an interrupted turn), `empty`, `loading` (it never answers), `unavailable`
 * (404) or `network` (the request fails). `?theme=light` switches theme.
 */

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "ready";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const TOKEN = "q7Lr2xVb9KcT4mWn8PzY3sHd6FgJ1aEu5oRi0tXkQwB";

const messages: OperationalTranscriptMessage[] = [
  { role: "user", text: "The login test fails on CI but passes locally. Can you find out why and fix it?" },
  {
    role: "assistant",
    text: [
      "## What Was Wrong",
      "",
      "The test read the session cookie before the redirect finished, so it only passed on a fast machine.",
      "",
      "| File | Change |",
      "| --- | --- |",
      "| `auth/login.test.ts` | Waits for the redirect before reading the cookie |",
      "| `auth/session.ts` | Sets `SameSite=Lax` explicitly |",
      "",
      "```ts",
      "await page.waitForURL(\"**/dashboard\");",
      "const cookie = (await context.cookies()).find((item) => item.name === \"session\");",
      "expect(cookie?.sameSite).toBe(\"Lax\");",
      "```",
      "",
      "The run before the fix is recorded here: ![CI run](https://media.example.com/ci-run.png?X-Amz-Signature=0123456789abcdef)",
      "",
      "Full log: https://ci.example.com/runs/48213/jobs/9921/logs?attempt=2&token=abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n"),
  },
  { role: "user", text: "Thanks. Also run the **whole** suite with `pnpm test`." },
  { role: "assistant", text: "Running the suite now." },
  { role: "assistant", text: "[Turn interrupted]" },
  { role: "user", text: "Stop, that's enough for today." },
  { role: "assistant", text: "Understood. The fix is committed on `fix/login-redirect`; the full suite has not run yet." },
];

const share: PublicTranscriptShare = {
  expiresAt: new Date(2026, 8, 26, 0, 49, 58).getTime(),
  transcript: {
    schemaVersion: 1,
    source: "control-plane-cache",
    completeness: "possibly-partial",
    messages: state === "empty" ? [] : messages,
  },
} as PublicTranscriptShare;

window.fetch = (async () => {
  if (state === "loading") return new Promise<never>(() => undefined);
  if (state === "unavailable") return new Response("not found", { status: 404 });
  if (state === "network") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(share), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SharedTranscript token={TOKEN} />
  </React.StrictMode>,
);
