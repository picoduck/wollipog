/**
 * The one-line form of a session title for every place that shows it as a name: the session bar,
 * the phone top bar, the window title and the More Actions sheet (#2146), and later the Sessions
 * list rows, preview bar and Board cards.
 *
 * A generated title can be the opening of the first prompt, blank lines and requirement lists
 * included. Only its first non-empty line names the session; whitespace runs collapse to one space
 * and a single trailing period is dropped, since a name is not a sentence. An ellipsis keeps its
 * dots. The stored title is never changed.
 */
export function sessionDisplayTitle(title: string): string {
  const line = title.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== "") ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  return /[^.]\.$/.test(collapsed) ? collapsed.slice(0, -1).trimEnd() : collapsed;
}
