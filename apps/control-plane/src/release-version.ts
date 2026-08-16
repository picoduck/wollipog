/**
 * Packaged application release whose standalone runner artifacts this control plane expects.
 * The release workflow verifies this value against the tag, desktop packages, root package, and
 * runner VERSION before producing any installer or runner binary.
 */
export const APP_RELEASE_VERSION = "0.19.0";

declare const __WOLLIPOG_RUNNER_RELEASE_TAG__: string;

/** Build-time injected for throwaway/manual release tags; direct development uses the app version. */
export const RUNNER_RELEASE_TAG =
  typeof __WOLLIPOG_RUNNER_RELEASE_TAG__ === "string"
    ? __WOLLIPOG_RUNNER_RELEASE_TAG__
    : `v${APP_RELEASE_VERSION}`;
