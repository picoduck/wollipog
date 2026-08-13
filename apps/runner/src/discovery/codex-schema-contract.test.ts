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

test("pinned schema fixture matches discovery metadata and reports a useful drift diff", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    contractFingerprint: string;
    minimumVerifiedVersion: string;
    files: Record<string, {
      required?: string[];
      properties?: string[];
      definitions?: Record<string, {
        required?: string[];
        properties?: string[];
        requiredInEveryVariant?: string[];
        propertyEnumValues?: Record<string, string[]>;
        variantRequiredProperties?: Record<string, string[]>;
        enumValues?: string[];
        enumValuesInVariants?: string[];
      }>;
    }>;
  };
  assert.equal(fixture.contractFingerprint, CODEX_APP_SERVER_CONTRACT_FINGERPRINT);
  assert.equal(fixture.minimumVerifiedVersion, MIN_VERIFIED_CODEX_APP_SERVER_VERSION);

  const dir = mkdtempSync(join(tmpdir(), "wollipog-codex-contract-test-"));
  try {
    for (const [relative, expected] of Object.entries(fixture.files)) {
      const path = join(dir, ...relative.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        required: expected.required ?? [],
        properties: Object.fromEntries((expected.properties ?? []).map((p) => [p, {}])),
        definitions: Object.fromEntries(Object.entries(expected.definitions ?? {}).map(([name, definition]) => [name, {
          required: definition.required ?? [],
          properties: Object.fromEntries((definition.properties ?? []).map((p) => [p, {}])),
          oneOf: [
            ...(definition.enumValuesInVariants ?? []).map((value) => ({ enum: [value] })),
            ...Object.entries(definition.propertyEnumValues ?? {}).flatMap(([property, values]) => values.map((value) => ({
              required: definition.requiredInEveryVariant ?? [],
              properties: { [property]: { enum: [value] } },
            }))),
            ...Object.entries(definition.variantRequiredProperties ?? {}).map(([title, names]) => ({
              title,
              required: names,
              properties: Object.fromEntries(names.map((name) => [name, {}])),
            })),
          ],
          enum: definition.enumValues,
        }])),
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
