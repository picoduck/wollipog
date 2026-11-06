// Shared by Playwright discovery and the rolling validator. Workflow contracts pin
// the full matrix to this inventory; this module must not discover files or load profiles.
export const BROWSER_SHARD_COUNT = 10;
export const BROWSER_SHARDS = Object.freeze(Array.from({ length: BROWSER_SHARD_COUNT }, (_, i) => i + 1));
