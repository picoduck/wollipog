/**
 * The one grammar for a slash-command name (#2602), shared by every runner catalog parser and the
 * web composer's registry and trigger. A name starts with a letter, digit or underscore (any
 * script) and continues with those or `.`, `:`, `@` and `-`; no whitespace, no slash. The runner
 * drops a name this rejects before advertising it, so every advertised command can be listed and
 * chosen in the `/` picker.
 *
 * Length limits are each parser's own resource bound, not part of the grammar.
 */

/** The characters a name may continue with, as the body of a Unicode (`u`) character class. */
export const SLASH_COMMAND_NAME_CHARACTERS = "\\p{L}\\p{N}_.:@-";

const NAME = new RegExp(`^[\\p{L}\\p{N}_][${SLASH_COMMAND_NAME_CHARACTERS}]*$`, "u");
const CHARACTER = new RegExp(`^[${SLASH_COMMAND_NAME_CHARACTERS}]$`, "u");

/** Whether `name` (without its leading slash) is a command name every peer accepts. */
export function isSlashCommandName(name: string): boolean {
  return NAME.test(name);
}

/** Whether one character can continue a command name: what the composer's trigger extends over. */
export function isSlashCommandNameCharacter(character: string): boolean {
  return CHARACTER.test(character);
}
