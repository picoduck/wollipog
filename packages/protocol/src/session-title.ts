/** The longest title derived from a first prompt, its ellipsis included. */
export const PROMPT_TITLE_MAX = 120;

/**
 * A new session's default title, derived from its first prompt (#2209): the prompt's first
 * non-empty line, whitespace collapsed. A line longer than `PROMPT_TITLE_MAX` is cut at a word
 * boundary and ends in "…", the whole title staying within the limit; a single word longer than the
 * limit is cut mid-word, since it has no boundary to cut at. Stored titles are never rewritten.
 * `max` is a smaller budget for a title that something else is appended to.
 */
export function titleFromPrompt(prompt: string, max = PROMPT_TITLE_MAX): string {
  const line = prompt.split(/\r\n|\r|\n/).map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .find((candidate) => candidate !== "") ?? "";
  if (line.length <= max) return line;
  const room = line.slice(0, max - 1);
  const boundary = room.lastIndexOf(" ");
  const cut = boundary > 0 ? room.slice(0, boundary) : room;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}
