import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  CODEX_APP_SERVER_CONTRACT_FINGERPRINT,
  MIN_VERIFIED_CODEX_APP_SERVER_VERSION,
} from "./codex-app-server.js";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const fixturePath = join(import.meta.dirname, "fixtures", "codex-app-server-required-contract.json");
const script = join(root, "scripts", "check-codex-app-server-schema.mjs");

interface ExpectedShape {
  required?: string[];
  properties?: string[];
  requiredInEveryVariant?: string[];
  propertyEnumValues?: Record<string, string[]>;
  variantRequiredProperties?: Record<string, string[]>;
  discriminatedVariants?: Record<string, Record<string, string[]>>;
  enumValues?: string[];
  enumValuesInVariants?: string[];
}

/** Build the minimal schema node the fixture claims to require. The checker treats the fixture as a
 * required subset, so a node synthesized this way must pass unmodified — every drift assertion below
 * then isolates exactly one removal. */
function synthesizeShape(expected: ExpectedShape): Record<string, unknown> {
  return {
    required: expected.required ?? [],
    properties: Object.fromEntries((expected.properties ?? []).map((name) => [name, {}])),
    oneOf: [
      ...(expected.enumValuesInVariants ?? []).map((value) => ({ enum: [value] })),
      ...Object.entries(expected.propertyEnumValues ?? {}).flatMap(([property, values]) => values.map((value) => ({
        required: expected.requiredInEveryVariant ?? [],
        properties: { [property]: { enum: [value] } },
      }))),
      ...Object.entries(expected.variantRequiredProperties ?? {}).map(([title, names]) => ({
        title,
        required: names,
        properties: Object.fromEntries(names.map((name) => [name, {}])),
      })),
      ...Object.entries(expected.discriminatedVariants ?? {}).flatMap(([discriminator, byValue]) =>
        Object.entries(byValue).map(([value, names]) => ({
          required: names,
          properties: {
            ...Object.fromEntries(names.map((name) => [name, {}])),
            [discriminator]: { enum: [value] },
          },
        }))),
    ],
    enum: expected.enumValues,
  };
}

test("pinned schema fixture matches discovery metadata and reports a useful drift diff", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    contractFingerprint: string;
    minimumVerifiedVersion: string;
    files: Record<string, ExpectedShape & { definitions?: Record<string, ExpectedShape> }>;
  };
  assert.equal(fixture.contractFingerprint, CODEX_APP_SERVER_CONTRACT_FINGERPRINT);
  assert.equal(fixture.minimumVerifiedVersion, MIN_VERIFIED_CODEX_APP_SERVER_VERSION);

  const dir = mkdtempSync(join(tmpdir(), "wollipog-codex-contract-test-"));
  try {
    for (const [relative, expected] of Object.entries(fixture.files)) {
      const path = join(dir, ...relative.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        ...synthesizeShape(expected),
        definitions: Object.fromEntries(
          Object.entries(expected.definitions ?? {}).map(([name, definition]) => [name, synthesizeShape(definition)]),
        ),
      }));
    }
    const ok = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.equal(ok.status, 0, ok.stderr);

    const resumePath = join(dir, "v2", "ThreadResumeParams.json");
    writeFileSync(resumePath, JSON.stringify({ required: [], properties: {} }));
    const shapeDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(shapeDrift.status, 0);
    assert.match(shapeDrift.stderr, /required field removed: threadId/);
    assert.match(shapeDrift.stderr, /property removed: threadId/);

    // Additive required/properties are tolerated: the fixture is a required subset, not a closed schema.
    writeFileSync(resumePath, JSON.stringify({
      required: ["threadId", "futureRequired"],
      properties: { threadId: {}, futureProperty: {} },
    }));
    const additive = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.equal(additive.status, 0, additive.stderr);

    // MCP form mode: renaming the mode discriminator hides the whole variant, which is exactly how a
    // compatible-looking upgrade would silently stop structured MCP forms from being normalized.
    const elicitationPath = join(dir, "McpServerElicitationRequestParams.json");
    const elicitation = JSON.parse(readFileSync(elicitationPath, "utf8"));
    const formVariant = elicitation.oneOf.find(
      (variant: { properties?: { mode?: { enum?: string[] } } }) => variant.properties?.mode?.enum?.includes("form"),
    );
    formVariant.properties.mode.enum = ["formV2"];
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const formModeDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(formModeDrift.status, 0);
    assert.match(formModeDrift.stderr, /McpServerElicitationRequestParams.*variant removed: mode=form/);
    formVariant.properties.mode.enum = ["form"];

    // MCP url mode: the driver keys the parked request on elicitationId, so losing it must fail the check.
    const urlVariant = elicitation.oneOf.find(
      (variant: { properties?: { mode?: { enum?: string[] } } }) => variant.properties?.mode?.enum?.includes("url"),
    );
    urlVariant.required = urlVariant.required.filter((name: string) => name !== "elicitationId");
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const urlModeDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(urlModeDrift.status, 0);
    assert.match(urlModeDrift.stderr, /mode=url: required field removed: elicitationId/);
    urlVariant.required = ["elicitationId", "message", "mode", "url"];

    // A consumed property of a nested form control: maxLength drives the free-text bound.
    delete elicitation.definitions.McpElicitationStringSchema.properties.maxLength;
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const stringSchemaDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(stringSchemaDrift.status, 0);
    assert.match(stringSchemaDrift.stderr, /McpElicitationStringSchema.*property removed: maxLength/);
    elicitation.definitions.McpElicitationStringSchema.properties.maxLength = {};

    // A consumed string format the driver maps onto its own input formats.
    elicitation.definitions.McpElicitationStringFormat.enum =
      elicitation.definitions.McpElicitationStringFormat.enum.filter((value: string) => value !== "uri");
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const formatDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(formatDrift.status, 0);
    assert.match(formatDrift.stderr, /McpElicitationStringFormat.*enum value removed: uri/);
    elicitation.definitions.McpElicitationStringFormat.enum = ["email", "uri", "date", "date-time"];
    writeFileSync(elicitationPath, JSON.stringify(elicitation));

    // Native decision values Wollipog returns: dropping one would make an authorized choice unsendable.
    const decisionPath = join(dir, "CommandExecutionRequestApprovalResponse.json");
    const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
    decision.definitions.CommandExecutionApprovalDecision.oneOf =
      decision.definitions.CommandExecutionApprovalDecision.oneOf.filter(
        (variant: { enum?: string[] }) => !variant.enum?.includes("acceptForSession"),
      );
    writeFileSync(decisionPath, JSON.stringify(decision));
    const decisionDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(decisionDrift.status, 0);
    assert.match(decisionDrift.stderr, /CommandExecutionApprovalDecision.*enum variant removed: acceptForSession/);
    decision.definitions.CommandExecutionApprovalDecision.oneOf.push({ enum: ["acceptForSession"] });
    writeFileSync(decisionPath, JSON.stringify(decision));

    // The grant scope Wollipog sends back when allowing or rejecting a permissions request.
    const scopePath = join(dir, "PermissionsRequestApprovalResponse.json");
    const scope = JSON.parse(readFileSync(scopePath, "utf8"));
    scope.definitions.PermissionGrantScope.enum = scope.definitions.PermissionGrantScope.enum.filter(
      (value: string) => value !== "session",
    );
    writeFileSync(scopePath, JSON.stringify(scope));
    const scopeDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(scopeDrift.status, 0);
    assert.match(scopeDrift.stderr, /PermissionGrantScope.*enum value removed: session/);
    scope.definitions.PermissionGrantScope.enum = ["turn", "session"];
    writeFileSync(scopePath, JSON.stringify(scope));

    const usagePath = join(dir, "v2", "ThreadTokenUsageUpdatedNotification.json");
    const usage = JSON.parse(readFileSync(usagePath, "utf8"));
    usage.definitions.ThreadTokenUsage.required = ["total"];
    delete usage.definitions.ThreadTokenUsage.properties.last;
    writeFileSync(usagePath, JSON.stringify(usage));
    const nestedDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(nestedDrift.status, 0);
    assert.match(nestedDrift.stderr, /ThreadTokenUsage.*required field removed: last/);
    assert.match(nestedDrift.stderr, /ThreadTokenUsage.*property removed: last/);

    // Restore the exact fixture subset before testing a missing top-level schema.
    usage.definitions.ThreadTokenUsage.required = ["last", "total"];
    usage.definitions.ThreadTokenUsage.properties.last = {};
    writeFileSync(usagePath, JSON.stringify(usage));

    const readResponsePath = join(dir, "v2", "ThreadReadResponse.json");
    const readResponse = JSON.parse(readFileSync(readResponsePath, "utf8"));
    readResponse.definitions.ThreadStatus.oneOf.at(-1).properties.type.enum = ["futureActive"];
    writeFileSync(readResponsePath, JSON.stringify(readResponse));
    const enumDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(enumDrift.status, 0);
    assert.match(enumDrift.stderr, /ThreadStatus.*enum value removed from type: active/);

    const turnStartPath = join(dir, "v2", "TurnStartParams.json");
    const turnStart = JSON.parse(readFileSync(turnStartPath, "utf8"));
    turnStart.definitions.UserInput.oneOf = turnStart.definitions.UserInput.oneOf.filter(
      (variant: { title?: string }) => variant.title !== "LocalImageUserInput",
    );
    writeFileSync(turnStartPath, JSON.stringify(turnStart));
    const imageDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(imageDrift.status, 0);
    assert.match(imageDrift.stderr, /UserInput.*variant removed: LocalImageUserInput/);

    const steerPath = join(dir, "v2", "TurnSteerParams.json");
    const steer = JSON.parse(readFileSync(steerPath, "utf8"));
    steer.required = steer.required.filter((name: string) => name !== "expectedTurnId");
    delete steer.properties.clientUserMessageId;
    steer.definitions.UserInput.oneOf = steer.definitions.UserInput.oneOf.filter(
      (variant: { title?: string }) => variant.title !== "LocalImageUserInput",
    );
    writeFileSync(steerPath, JSON.stringify(steer));
    const steerDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(steerDrift.status, 0);
    assert.match(steerDrift.stderr, /TurnSteerParams.*required field removed: expectedTurnId/);
    assert.match(steerDrift.stderr, /TurnSteerParams.*property removed: clientUserMessageId/);
    assert.match(steerDrift.stderr, /TurnSteerParams.*variant removed: LocalImageUserInput/);
    writeFileSync(steerPath, JSON.stringify({
      ...steer,
      required: ["threadId", "input", "expectedTurnId"],
      properties: { threadId: {}, input: {}, expectedTurnId: {}, clientUserMessageId: {} },
      definitions: {
        UserInput: {
          ...steer.definitions.UserInput,
          oneOf: [
            ...(steer.definitions.UserInput.oneOf ?? []),
            { title: "LocalImageUserInput", required: ["type", "path"], properties: { type: {}, path: {} } },
          ],
        },
      },
    }));

    const steerResponsePath = join(dir, "v2", "TurnSteerResponse.json");
    writeFileSync(steerResponsePath, JSON.stringify({ required: [], properties: {} }));
    const steerResponseDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(steerResponseDrift.status, 0);
    assert.match(steerResponseDrift.stderr, /TurnSteerResponse.*required field removed: turnId/);
    assert.match(steerResponseDrift.stderr, /TurnSteerResponse.*property removed: turnId/);
    writeFileSync(steerResponsePath, JSON.stringify({ required: ["turnId"], properties: { turnId: {} } }));

    const modelListPath = join(dir, "v2", "ModelListResponse.json");
    const modelList = JSON.parse(readFileSync(modelListPath, "utf8"));
    modelList.definitions.InputModality.oneOf = modelList.definitions.InputModality.oneOf.filter(
      (variant: { enum?: string[] }) => !variant.enum?.includes("image"),
    );
    writeFileSync(modelListPath, JSON.stringify(modelList));
    const modalityDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(modalityDrift.status, 0);
    assert.match(modalityDrift.stderr, /InputModality.*enum variant removed: image/);
    modelList.definitions.InputModality.oneOf.push({ enum: ["image"] });
    writeFileSync(modelListPath, JSON.stringify(modelList));

    const completedPath = join(dir, "v2", "TurnCompletedNotification.json");
    const completed = JSON.parse(readFileSync(completedPath, "utf8"));
    completed.definitions.TurnStatus.enum = completed.definitions.TurnStatus.enum.filter(
      (value: string) => value !== "failed",
    );
    writeFileSync(completedPath, JSON.stringify(completed));
    const statusDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(statusDrift.status, 0);
    assert.match(statusDrift.stderr, /TurnStatus.*enum value removed: failed/);

    unlinkSync(resumePath);
    const drift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /schema drifted/i);
    assert.match(drift.stderr, /missing or unreadable schema: v2\/ThreadResumeParams\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
