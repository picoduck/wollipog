import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = join(root, "apps", "runner", "src", "discovery", "fixtures", "codex-app-server-required-contract.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const command = process.env.CODEX_BIN || "codex";
const providedSchemaDir = process.env.CODEX_SCHEMA_DIR ? resolve(process.env.CODEX_SCHEMA_DIR) : null;
const out = providedSchemaDir || mkdtempSync(join(tmpdir(), "wollipog-codex-schema-"));

function run(args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

/** Check one named `oneOf` branch. A missing branch is a rename or a dropped variant: either way
 * the consuming code stops recognizing requests it used to normalize. */
function checkVariant(variant, names, label, title, diffs) {
  if (!variant) {
    diffs.push(`- ${label}: variant removed: ${title}`);
    return;
  }
  const variantRequired = new Set(variant.required || []);
  const variantProperties = new Set(Object.keys(variant.properties || {}));
  for (const name of names) {
    if (!variantRequired.has(name)) diffs.push(`- ${label}/${title}: required field removed: ${name}`);
    if (!variantProperties.has(name)) diffs.push(`- ${label}/${title}: property removed: ${name}`);
  }
}

/** Compare one schema node — a whole file or a single definition — against the curated subset the
 * driver consumes. Additive fields are tolerated; removals and renames are reported. */
function checkShape(node, expected, label, diffs) {
  const required = new Set(node.required || []);
  const properties = new Set(Object.keys(node.properties || {}));
  const variants = node.oneOf || [];
  for (const name of expected.required || []) if (!required.has(name)) diffs.push(`- ${label}: required field removed: ${name}`);
  for (const name of expected.properties || []) if (!properties.has(name)) diffs.push(`- ${label}: property removed: ${name}`);
  for (const name of expected.requiredInEveryVariant || []) {
    if (!variants.length || variants.some((variant) => !(variant.required || []).includes(name))) {
      diffs.push(`- ${label}: variant-required field removed: ${name}`);
    }
  }
  for (const [name, expectedValues] of Object.entries(expected.propertyEnumValues || {})) {
    const actualValues = new Set(variants.flatMap((variant) => variant.properties?.[name]?.enum || []));
    for (const value of expectedValues) {
      if (!actualValues.has(value)) diffs.push(`- ${label}: enum value removed from ${name}: ${value}`);
    }
  }
  for (const [title, names] of Object.entries(expected.variantRequiredProperties || {})) {
    checkVariant(variants.find((candidate) => candidate.title === title), names, label, title, diffs);
  }
  // The MCP elicitation request modes are untitled variants, so they are identified by the enum
  // value of their discriminator property instead of by `title`.
  for (const [discriminator, byValue] of Object.entries(expected.discriminatedVariants || {})) {
    for (const [value, names] of Object.entries(byValue)) {
      const variant = variants.find((candidate) => (candidate.properties?.[discriminator]?.enum || []).includes(value));
      checkVariant(variant, names, label, `${discriminator}=${value}`, diffs);
    }
  }
  const variantEnumValues = new Set(variants.flatMap((variant) => variant.enum || []));
  for (const value of expected.enumValuesInVariants || []) {
    if (!variantEnumValues.has(value)) diffs.push(`- ${label}: enum variant removed: ${value}`);
  }
  for (const value of expected.enumValues || []) {
    if (!(node.enum || []).includes(value)) diffs.push(`- ${label}: enum value removed: ${value}`);
  }
}

try {
  let actualVersion = "provided schema directory";
  if (!providedSchemaDir) {
    const versionRun = run(["--version"]);
    if (versionRun.error || versionRun.status !== 0) {
      throw new Error(`Could not run ${command} --version: ${versionRun.error?.message || versionRun.stderr || `exit ${versionRun.status}`}`);
    }
    actualVersion = `${versionRun.stdout}\n${versionRun.stderr}`.match(/\d+\.\d+\.\d+/)?.[0];
    if (!actualVersion) throw new Error("Codex version output did not contain a semantic version.");

    const generated = run(["app-server", "generate-json-schema", "--out", out]);
    if (generated.error || generated.status !== 0) {
      throw new Error(`Schema generation failed: ${generated.error?.message || generated.stderr || `exit ${generated.status}`}`);
    }
  }

  const diffs = [];
  for (const [relative, expected] of Object.entries(fixture.files)) {
    let schema;
    try {
      schema = JSON.parse(readFileSync(join(out, ...relative.split("/")), "utf8"));
    } catch (error) {
      diffs.push(`- missing or unreadable schema: ${relative} (${error.message})`);
      continue;
    }
    checkShape(schema, expected, relative, diffs);
    for (const [definitionName, expectedDefinition] of Object.entries(expected.definitions || {})) {
      const definition = schema.definitions?.[definitionName];
      if (!definition) {
        diffs.push(`- ${relative}: definition removed: ${definitionName}`);
        continue;
      }
      checkShape(definition, expectedDefinition, `${relative}#${definitionName}`, diffs);
    }
  }
  if (diffs.length) {
    throw new Error(
      `Codex app-server schema drifted from ${fixture.contractFingerprint} (${fixture.generatedWith}).\n` +
      `${diffs.join("\n")}\nRegenerate with the intended supported Codex version, inspect the diff, and update the fixture deliberately.`,
    );
  }
  console.log(`Codex ${actualVersion} matches ${fixture.contractFingerprint} (${Object.keys(fixture.files).length} required schemas).`);
} finally {
  if (!providedSchemaDir) rmSync(out, { recursive: true, force: true });
}
