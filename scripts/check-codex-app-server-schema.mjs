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
    const required = new Set(schema.required || []);
    const properties = new Set(Object.keys(schema.properties || {}));
    for (const name of expected.required || []) if (!required.has(name)) diffs.push(`- ${relative}: required field removed: ${name}`);
    for (const name of expected.properties || []) if (!properties.has(name)) diffs.push(`- ${relative}: property removed: ${name}`);
    for (const [definitionName, expectedDefinition] of Object.entries(expected.definitions || {})) {
      const definition = schema.definitions?.[definitionName];
      if (!definition) {
        diffs.push(`- ${relative}: definition removed: ${definitionName}`);
        continue;
      }
      const definitionRequired = new Set(definition.required || []);
      const definitionProperties = new Set(Object.keys(definition.properties || {}));
      for (const name of expectedDefinition.required || []) {
        if (!definitionRequired.has(name)) diffs.push(`- ${relative}#${definitionName}: required field removed: ${name}`);
      }
      for (const name of expectedDefinition.properties || []) {
        if (!definitionProperties.has(name)) diffs.push(`- ${relative}#${definitionName}: property removed: ${name}`);
      }
      for (const name of expectedDefinition.requiredInEveryVariant || []) {
        const variants = definition.oneOf || [];
        if (!variants.length || variants.some((variant) => !(variant.required || []).includes(name))) {
          diffs.push(`- ${relative}#${definitionName}: variant-required field removed: ${name}`);
        }
      }
      for (const [name, expectedValues] of Object.entries(expectedDefinition.propertyEnumValues || {})) {
        const actualValues = new Set(
          (definition.oneOf || []).flatMap((variant) => variant.properties?.[name]?.enum || []),
        );
        for (const value of expectedValues) {
          if (!actualValues.has(value)) diffs.push(`- ${relative}#${definitionName}: enum value removed from ${name}: ${value}`);
        }
      }
      for (const [title, names] of Object.entries(expectedDefinition.variantRequiredProperties || {})) {
        const variant = (definition.oneOf || []).find((candidate) => candidate.title === title);
        if (!variant) {
          diffs.push(`- ${relative}#${definitionName}: variant removed: ${title}`);
          continue;
        }
        const variantRequired = new Set(variant.required || []);
        const variantProperties = new Set(Object.keys(variant.properties || {}));
        for (const name of names) {
          if (!variantRequired.has(name)) diffs.push(`- ${relative}#${definitionName}/${title}: required field removed: ${name}`);
          if (!variantProperties.has(name)) diffs.push(`- ${relative}#${definitionName}/${title}: property removed: ${name}`);
        }
      }
      const variantEnumValues = new Set((definition.oneOf || []).flatMap((variant) => variant.enum || []));
      for (const value of expectedDefinition.enumValuesInVariants || []) {
        if (!variantEnumValues.has(value)) {
          diffs.push(`- ${relative}#${definitionName}: enum variant removed: ${value}`);
        }
      }
      for (const value of expectedDefinition.enumValues || []) {
        if (!(definition.enum || []).includes(value)) {
          diffs.push(`- ${relative}#${definitionName}: enum value removed: ${value}`);
        }
      }
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
