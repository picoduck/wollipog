const CREDENTIAL_SHAPED_ENVIRONMENT =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|COOKIE|AUTHORIZATION)/iu;
const WOLLIPOG_ENVIRONMENT = /^(?:WOLLIPOG|MAM)_/iu;

/** Runner authentication belongs to the daemon, never to a provider, shell, or helper child. */
export const RUNNER_CREDENTIAL_ENVIRONMENT = ["RUNNER_TOKEN", "RUNNER_TOKEN_FILE"] as const;

/** Runner policy and credential-shaped host variables never cross remote trust boundaries. */
export function sensitiveEnvironmentName(name: string): boolean {
  return CREDENTIAL_SHAPED_ENVIRONMENT.test(name) || WOLLIPOG_ENVIRONMENT.test(name);
}
