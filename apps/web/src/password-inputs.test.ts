import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A React-controlled `<input type="password">` mirrors what is typed into its `value` attribute, so
 * a pairing link, an API key or a secret answer lands in `innerHTML` and every DOM snapshot (#3529,
 * #3814). Secret fields are uncontrolled instead: see `components/ui/secret-input.ts`.
 *
 * This guard fails on an `<input>` that can be a password field (its `type` is `"password"`, or an
 * expression that can yield it) and is given `value` or `defaultValue`, which writes the attribute
 * too, or a spread, which could carry either. A field that must stay controlled goes in ALLOWED
 * with its reason.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** `file` relative to apps/web/src, mapped to why its password field must stay controlled. */
const ALLOWED = new Map<string, string>();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".tsx") && !/\.test\.tsx$/.test(path)) out.push(path);
  }
  return out;
}

/** Does this `type` attribute's value say, or possibly evaluate to, "password"? */
function canBePassword(initializer: ts.JsxAttributeValue | undefined): boolean {
  if (!initializer) return false;
  if (ts.isStringLiteral(initializer)) return initializer.text === "password";
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "password") found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(initializer);
  return found;
}

/** `line: reason` for every password-capable `<input>` in `source` that is given its value. */
function controlledPasswordInputs(source: string, fileName = "input.tsx"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === "input") {
      const attributes = node.attributes.properties;
      const type = attributes.find((attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "type");
      if (type && canBePassword(type.initializer)) {
        for (const attribute of attributes) {
          const name = ts.isJsxAttribute(attribute) ? attribute.name.getText(file) : "a spread";
          if (ts.isJsxAttribute(attribute) && name !== "value" && name !== "defaultValue") continue;
          const { line } = file.getLineAndCharacterOfPosition(attribute.getStart(file));
          offenders.push(`${line + 1}: ${ts.isJsxAttribute(attribute) ? `\`${name}\`` : name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
}

test("the guard flags a password-capable input given its value, and passes an uncontrolled one", () => {
  const flagged = (jsx: string) => controlledPasswordInputs(`const field = ${jsx};`);
  assert.deepEqual(flagged(`<input type="password" value={secret} />`), ["1: `value`"]);
  assert.deepEqual(flagged(`<input type={masked ? "password" : "text"} value={text} />`), ["1: `value`"]);
  assert.deepEqual(flagged("<input type={`password`} defaultValue={saved} />"), ["1: `defaultValue`"]);
  assert.deepEqual(flagged(`<input type="password" {...props} />`), ["1: a spread"]);
  assert.deepEqual(flagged(`<input type="password" ref={ref} onChange={remember} />`), []);
  assert.deepEqual(flagged(`<input type="text" value={text} />`), [], "a plain field may be controlled");
  assert.deepEqual(flagged(`<Select type="password" value={choice} />`), [], "only native inputs are checked");
});

test("no password input in apps/web/src is given a value prop", () => {
  const offenders: string[] = [];
  const allowedSeen = new Set<string>();
  for (const path of sourceFiles(SRC)) {
    const name = relative(SRC, path);
    const found = controlledPasswordInputs(readFileSync(path, "utf8"), path);
    if (found.length === 0) continue;
    if (ALLOWED.has(name)) {
      allowedSeen.add(name);
      continue;
    }
    offenders.push(...found.map((entry) => `${name}:${entry}`));
  }
  assert.deepEqual(offenders, [],
    "make these secret fields uncontrolled (components/ui/secret-input.ts), or add the file to ALLOWED with its reason");
  assert.deepEqual([...ALLOWED.keys()].filter((name) => !allowedSeen.has(name)), [],
    "an ALLOWED entry whose field is now uncontrolled should be removed");
});
