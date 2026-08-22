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
  discriminatedVariants?: Record<string, Record<string, string[] | ExpectedShape>>;
  variantRefs?: string[];
  propertyRefs?: Record<string, string>;
  enumValues?: string[];
  enumValuesInVariants?: string[];
}

/** Build the minimal schema node the fixture claims to require. The checker treats the fixture as a
 * required subset, so a node synthesized this way must pass unmodified — every drift assertion below
 * then isolates exactly one removal. */
function synthesizeShape(expected: ExpectedShape): Record<string, unknown> {
  return {
    required: expected.required ?? [],
    properties: {
      ...Object.fromEntries((expected.properties ?? []).map((name) => [name, {}])),
      ...Object.fromEntries(
        Object.entries(expected.propertyRefs ?? {}).map(([property, name]) => [property, { $ref: `#/definitions/${name}` }]),
      ),
    },
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
        Object.entries(byValue).map(([value, variant]) => {
          const shape = synthesizeShape(Array.isArray(variant) ? { required: variant, properties: variant } : variant);
          return {
            ...shape,
            properties: { ...(shape.properties as Record<string, unknown>), [discriminator]: { enum: [value] } },
          };
        })),
    ],
    anyOf: (expected.variantRefs ?? []).map((name) => ({ $ref: `#/definitions/${name}` })),
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

    // MCP url mode: the driver cancels unless message, serverName, and url are all present.
    const urlVariant = elicitation.oneOf.find(
      (variant: { properties?: { mode?: { enum?: string[] } } }) => variant.properties?.mode?.enum?.includes("url"),
    );
    urlVariant.required = urlVariant.required.filter((name: string) => name !== "url");
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const urlModeDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(urlModeDrift.status, 0);
    assert.match(urlModeDrift.stderr, /mode=url: required field removed: url/);
    urlVariant.required = ["message", "mode", "url"];

    // elicitationId is only an id fallback for a malformed envelope id, so it is pinned as a
    // property and not as a required field: Codex making it optional is not drift, renaming is.
    urlVariant.properties.mcpElicitationId = urlVariant.properties.elicitationId;
    delete urlVariant.properties.elicitationId;
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const elicitationIdDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(elicitationIdDrift.status, 0);
    assert.match(elicitationIdDrift.stderr, /mode=url: property removed: elicitationId/);
    urlVariant.properties.elicitationId = {};
    delete urlVariant.properties.mcpElicitationId;

    // A consumed property of a nested form control: maxLength drives the free-text bound.
    delete elicitation.definitions.McpElicitationStringSchema.properties.maxLength;
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const stringSchemaDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(stringSchemaDrift.status, 0);
    assert.match(stringSchemaDrift.stderr, /McpElicitationStringSchema.*property removed: maxLength/);
    elicitation.definitions.McpElicitationStringSchema.properties.maxLength = {};

    // Union membership: a control dropped from the union that makes it valid stops being reachable
    // even though its own definition survives, so the driver's boolean branch would go dead.
    elicitation.definitions.McpElicitationPrimitiveSchema.anyOf =
      elicitation.definitions.McpElicitationPrimitiveSchema.anyOf.filter(
        (variant: { $ref?: string }) => variant.$ref !== "#/definitions/McpElicitationBooleanSchema",
      );
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const unionDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(unionDrift.status, 0);
    assert.match(unionDrift.stderr, /McpElicitationPrimitiveSchema.*variant reference removed: McpElicitationBooleanSchema/);
    elicitation.definitions.McpElicitationPrimitiveSchema.anyOf.push({ $ref: "#/definitions/McpElicitationBooleanSchema" });

    // Property reachability: repointing the form-control map leaves every definition intact but
    // silently changes which controls a provider may send.
    elicitation.definitions.McpElicitationSchema.properties.properties.$ref = "#/definitions/McpElicitationStringSchema";
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const propertyRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(propertyRefDrift.status, 0);
    assert.match(
      propertyRefDrift.stderr,
      /McpElicitationSchema: property reference removed: properties -> McpElicitationPrimitiveSchema/,
    );
    elicitation.definitions.McpElicitationSchema.properties.properties.$ref = "#/definitions/McpElicitationPrimitiveSchema";

    // The form variant's requestedSchema is the root of the whole consumed form tree: repointing it
    // leaves every definition intact while making object forms inadmissible.
    formVariant.properties.requestedSchema = { $ref: "#/definitions/McpElicitationStringSchema" };
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const variantRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(variantRefDrift.status, 0);
    assert.match(
      variantRefDrift.stderr,
      /mode=form: property reference removed: requestedSchema -> McpElicitationSchema/,
    );
    formVariant.properties.requestedSchema = { $ref: "#/definitions/McpElicitationSchema" };

    // A consumed string format the driver maps onto its own input formats.
    elicitation.definitions.McpElicitationStringFormat.enum =
      elicitation.definitions.McpElicitationStringFormat.enum.filter((value: string) => value !== "uri");
    writeFileSync(elicitationPath, JSON.stringify(elicitation));
    const formatDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(formatDrift.status, 0);
    assert.match(formatDrift.stderr, /McpElicitationStringFormat.*enum value removed: uri/);
    elicitation.definitions.McpElicitationStringFormat.enum = ["email", "uri", "date", "date-time"];
    writeFileSync(elicitationPath, JSON.stringify(elicitation));

    // The requestUserInput chain normalizeCodexUserInput walks: params -> question -> option, and
    // the answer map it replies with. Repointing any of these keeps every definition intact.
    const userInputPath = join(dir, "ToolRequestUserInputParams.json");
    const userInput = JSON.parse(readFileSync(userInputPath, "utf8"));
    userInput.properties.questions = { items: { $ref: "#/definitions/ToolRequestUserInputOption" }, type: "array" };
    writeFileSync(userInputPath, JSON.stringify(userInput));
    const questionsRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(questionsRefDrift.status, 0);
    assert.match(questionsRefDrift.stderr, /ToolRequestUserInputParams.*property reference removed: questions -> ToolRequestUserInputQuestion/);
    userInput.properties.questions = { items: { $ref: "#/definitions/ToolRequestUserInputQuestion" }, type: "array" };
    userInput.definitions.ToolRequestUserInputQuestion.properties.options = { items: { type: "string" }, type: "array" };
    writeFileSync(userInputPath, JSON.stringify(userInput));
    const optionsRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(optionsRefDrift.status, 0);
    assert.match(optionsRefDrift.stderr, /ToolRequestUserInputQuestion: property reference removed: options -> ToolRequestUserInputOption/);
    userInput.definitions.ToolRequestUserInputQuestion.properties.options = { items: { $ref: "#/definitions/ToolRequestUserInputOption" }, type: "array" };
    writeFileSync(userInputPath, JSON.stringify(userInput));

    const answersPath = join(dir, "ToolRequestUserInputResponse.json");
    const answers = JSON.parse(readFileSync(answersPath, "utf8"));
    answers.properties.answers = { additionalProperties: { type: "string" }, type: "object" };
    writeFileSync(answersPath, JSON.stringify(answers));
    const answersRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(answersRefDrift.status, 0);
    assert.match(answersRefDrift.stderr, /ToolRequestUserInputResponse.*property reference removed: answers -> ToolRequestUserInputAnswer/);
    answers.properties.answers = { additionalProperties: { $ref: "#/definitions/ToolRequestUserInputAnswer" }, type: "object" };
    writeFileSync(answersPath, JSON.stringify(answers));

    // approvalResponse copies params.permissions verbatim into the grant, and the approval card
    // reads its network field, so both the reference and the consumed field are pinned.
    const permissionsPath = join(dir, "PermissionsRequestApprovalParams.json");
    const permissions = JSON.parse(readFileSync(permissionsPath, "utf8"));
    delete permissions.definitions.RequestPermissionProfile.properties.network;
    writeFileSync(permissionsPath, JSON.stringify(permissions));
    const profileDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(profileDrift.status, 0);
    assert.match(profileDrift.stderr, /RequestPermissionProfile: property removed: network/);
    // Retaining the field but repointing it is the same defect one level down: approvalResponse
    // copies the requested profile verbatim into the granted slot, so a repoint yields an
    // incompatible grant while every definition survives.
    permissions.definitions.RequestPermissionProfile.properties.network = {
      anyOf: [{ $ref: "#/definitions/FileSystemAccessMode" }, { type: "null" }],
    };
    writeFileSync(permissionsPath, JSON.stringify(permissions));
    const profileRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(profileRefDrift.status, 0);
    assert.match(profileRefDrift.stderr, /RequestPermissionProfile: property reference removed: network -> AdditionalNetworkPermissions/);
    permissions.definitions.RequestPermissionProfile.properties.network = {
      anyOf: [{ $ref: "#/definitions/AdditionalNetworkPermissions" }, { type: "null" }],
    };
    writeFileSync(permissionsPath, JSON.stringify(permissions));

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
    decision.properties.decision = { type: "string" };
    writeFileSync(decisionPath, JSON.stringify(decision));
    const decisionRefDrift = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_SCHEMA_DIR: dir } });
    assert.notEqual(decisionRefDrift.status, 0);
    assert.match(
      decisionRefDrift.stderr,
      /CommandExecutionRequestApprovalResponse.*property reference removed: decision -> CommandExecutionApprovalDecision/,
    );
    decision.properties.decision = { $ref: "#/definitions/CommandExecutionApprovalDecision" };
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
