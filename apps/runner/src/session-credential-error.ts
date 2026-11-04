/** Session callers cannot repair device pairing. Also works against older control planes. */
export function sessionCredentialRefusal(detail: string): string {
  return detail.startsWith("session agent credential refused:") ? detail
    : "session agent credential refused: credential invalid or unavailable; ask the Orchestrator to check the session and runner connection, then restart the session if it cannot recover";
}
