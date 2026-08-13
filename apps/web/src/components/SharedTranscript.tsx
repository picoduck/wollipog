import { useCallback, useEffect, useState } from "react";
import type { PublicTranscriptShare } from "@wollipog/protocol";
import { CONTROL_PLANE_HTTP } from "../config.js";
import { transcriptShareRequest } from "../transcript-share-client.js";

export function SharedTranscript({ token }: { token: string | null }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; value: PublicTranscriptShare }
    | { kind: "unavailable" }
    | { kind: "network"; message: string }
  >({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!token) {
      setState({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const request = transcriptShareRequest(CONTROL_PLANE_HTTP, token);
    void fetch(request.url, request.init)
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setState({ kind: "unavailable" });
          return;
        }
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        setState({ kind: "ready", value: await response.json() as PublicTranscriptShare });
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "network", message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [attempt, token]);

  return (
    <main className="shared-transcript-page">
      <section className="shared-transcript-card" aria-labelledby="shared-transcript-title">
        <h1 id="shared-transcript-title">Shared Operational Transcript</h1>
        {state.kind === "loading" && <p role="status">Loading shared transcript…</p>}
        {state.kind === "unavailable" && (
          <div role="alert">
            <h2>Shared Transcript Unavailable</h2>
            <p>This link is invalid, expired, revoked, or its source session was deleted.</p>
          </div>
        )}
        {state.kind === "network" && (
          <div role="alert">
            <h2>Could Not Reach the Control Plane</h2>
            <p>{state.message}</p>
            <button className="btn" type="button" onClick={retry}>Retry</button>
          </div>
        )}
        {state.kind === "ready" && (
          <>
            <div className="shared-transcript-warning" role="note">
              Cached and possibly partial. Message text is operationally redacted but may still contain secrets,
              source code, or personal data. This capability expires {new Date(state.value.expiresAt).toLocaleString()}.
            </div>
            <ol className="shared-transcript-messages" aria-label="Transcript Messages">
              {state.value.transcript.messages.map((message, index) => (
                <li key={index} className={`shared-transcript-message shared-transcript-${message.role}`}>
                  <h2>{message.role === "user" ? "User" : "Assistant"}</h2>
                  <pre>{message.text}</pre>
                </li>
              ))}
            </ol>
            {state.value.transcript.messages.length === 0 && <p className="shared-transcript-empty">No projected messages.</p>}
          </>
        )}
      </section>
    </main>
  );
}
