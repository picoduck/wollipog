/** Give an isolated live verifier existing access credentials without the shared refresh token.
 * A copied refresh token could rotate server-side state despite an unchanged source file. */
export function codexProbeAccessCredentials(source: unknown, now = Date.now()) {
  const auth = source as { auth_mode?: unknown; tokens?: Record<string, unknown> } | null;
  const tokens = auth?.tokens;
  if (auth?.auth_mode !== "chatgpt" || !tokens ||
      !["id_token", "access_token", "account_id"].every(key => typeof tokens[key] === "string" && tokens[key])) {
    throw new Error("existing_access_credentials_unavailable");
  }
  let expiresAt: number;
  try {
    const claims = JSON.parse(Buffer.from((tokens.access_token as string).split(".")[1]!, "base64url").toString("utf8"));
    expiresAt = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1_000 : 0;
  } catch { throw new Error("existing_access_credentials_unavailable"); }
  // The verifier's bounded six-case run must fit within the existing token lifetime. Never
  // renew authentication; an expired/revoked token is an explicit human-only dependency.
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt - now < 60 * 60 * 1_000) {
    throw new Error("existing_access_credentials_expiring");
  }
  return {
    auth_mode: "chatgpt",
    // Codex's file-backed format requires a refresh_token string. Empty means there is no
    // credential with which this process can rotate the source account's refresh token.
    tokens: { id_token: tokens.id_token as string, access_token: tokens.access_token as string,
      account_id: tokens.account_id as string, refresh_token: "" },
    // Suppress Codex's age-based proactive refresh in this temporary, access-only snapshot.
    last_refresh: new Date(now).toISOString(),
  };
}
