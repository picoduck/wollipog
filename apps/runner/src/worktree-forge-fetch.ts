/** Anonymous, HTTPS-only fetches for retirement proofs. Repository configuration may be
 * session-written: never execute its hooks, fsmonitor, SSH command, credential helpers or askpass,
 * and never send its extra headers. Global/system config is excluded by the companion environment.
 * Private heads needing credentials remain unavailable proof. */
export const CONTAINMENT_FETCH_GIT_CONFIG: readonly string[] = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.sslVerify=true", "-c", "http.extraHeader=", "-c", "http.https://github.com/.extraHeader=",
  "-c", "credential.helper=", "-c", "credential.interactive=false", "-c", "core.askPass=",
];
export const CONTAINMENT_FETCH_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
