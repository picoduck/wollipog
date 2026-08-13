const CREDENTIAL_SHAPED_ENVIRONMENT =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|COOKIE|AUTHORIZATION)/iu;
const WOLLIPOG_ENVIRONMENT = /^(?:WOLLIPOG|MAM)_/iu;

/** Runner policy and credential-shaped host variables never cross remote trust boundaries. */
export function sensitiveEnvironmentName(name: string): boolean {
  return CREDENTIAL_SHAPED_ENVIRONMENT.test(name) || WOLLIPOG_ENVIRONMENT.test(name);
}
