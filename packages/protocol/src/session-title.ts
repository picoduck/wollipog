/** The longest title derived from a first prompt, its ellipsis included. */
export const PROMPT_TITLE_MAX = 120;

/**
 * A new session's default title, derived from its first prompt (#2209): the prompt's first
 * non-empty line, whitespace collapsed. A line longer than `PROMPT_TITLE_MAX` is cut at a word
 * boundary and ends in "…", the whole title staying within the limit; a single word longer than the
 * limit is cut mid-word, since it has no boundary to cut at. Stored titles are never rewritten.
 */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.split(/\r\n|\r|\n/).map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .find((candidate) => candidate !== "") ?? "";
  if (line.length <= PROMPT_TITLE_MAX) return line;
  const room = line.slice(0, PROMPT_TITLE_MAX - 1);
  const boundary = room.lastIndexOf(" ");
  const cut = boundary > 0 ? room.slice(0, boundary) : room;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}
