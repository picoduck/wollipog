/**
 * Command names both peers must agree on (#2602). The runner's catalog parsers and the web
 * composer's registry each test this one list against the shared grammar in `@wollipog/protocol`,
 * so a name one side accepts and the other drops fails a test on both.
 *
 * Names are distinct case-insensitively, carry no surrounding whitespace, and none starts with `__`
 * (Claude Code's plumbing prefix, which its parser skips by rule rather than by grammar).
 */
export const SLASH_COMMAND_NAME_CASES: ReadonlyArray<{ name: string; accepted: boolean }> = [
  { name: "compact", accepted: true },
  { name: "security-review", accepted: true },
  { name: "superpowers:brainstorming", accepted: true },
  { name: "mcp__docs__summarize@latest", accepted: true },
  { name: "deploy@v1.2", accepted: true },
  { name: "_private", accepted: true },
  { name: "1password", accepted: true },
  { name: "résumé", accepted: true },
  { name: "日本語", accepted: true },
  { name: "Überprüfen", accepted: true },
  { name: "٣-steps", accepted: true },
  { name: "𝒜lpha", accepted: true },
  { name: "@scope", accepted: false },
  { name: ".hidden", accepted: false },
  { name: "-flag", accepted: false },
  { name: ":namespace", accepted: false },
  { name: "deploy+prod", accepted: false },
  { name: "a/b", accepted: false },
  { name: "two words", accepted: false },
  { name: "party🎉", accepted: false },
  // A decomposed accent is a combining mark, not a letter.
  { name: "café", accepted: false },
];
