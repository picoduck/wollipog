import { DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH, type AgentQuestion } from "@wollipog/protocol";

type FormContent = Record<string, string | string[] | number | boolean>;
type FormAcceptance = { action: "accept"; content: FormContent };

export interface NormalizedQuestionRequest {
  questions: AgentQuestion[];
  response: (answers: Record<string, string | string[]>, action?: "submit" | "dismiss") => unknown;
}

type McpElicitationAction = "accept" | "decline" | "cancel";
const MAX_STRUCTURED_QUESTIONS = 20;
const MAX_QUESTION_OPTIONS = 20;
const MAX_QUESTION_ID = 256;
const MAX_QUESTION_HEADER = 80;
const MAX_QUESTION_TEXT = 2000;
const MAX_FREE_TEXT = DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH;

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

interface NativeChoice {
  label: string;
  value: string;
}

function enumChoices(schema: unknown): NativeChoice[] | null {
  if (!isRecord(schema)) return null;
  let choices: Array<{ label: string | null; value: unknown }>;
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (titled) {
    choices = titled.map((entry: unknown) => ({
      label: isRecord(entry) ? boundedString(entry.title, MAX_QUESTION_ID) : null,
      value: isRecord(entry) ? entry.const : undefined,
    }));
  } else if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) && schema.enumNames.length === schema.enum.length
      ? schema.enumNames
      : schema.enum;
    choices = schema.enum.map((value: unknown, index: number) => ({
      label: boundedString(names[index], MAX_QUESTION_ID),
      value,
    }));
  } else {
    return null;
  }
  if (
    choices.length === 0 || choices.length > MAX_QUESTION_OPTIONS ||
    !choices.every((choice): choice is NativeChoice => !!choice.label && typeof choice.value === "string") ||
    new Set(choices.map((choice) => choice.label)).size !== choices.length
  ) return null;
  return choices;
}

function inputFormat(value: unknown): AgentQuestion["inputFormat"] | null {
  if (value == null) return "text";
  return value === "email" || value === "uri" || value === "date" || value === "date-time"
    ? value === "uri" ? "url" : value
    : null;
}

function normalizeForm(schema: unknown, context: string): {
  questions: AgentQuestion[];
  content: (answers: Record<string, string | string[]>) => FormContent;
} | null {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
  const entries = Object.entries(schema.properties);
  if (entries.length === 0 || entries.length > MAX_STRUCTURED_QUESTIONS) return null;
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string"))) {
    return null;
  }
  const requiredKeys = (schema.required ?? []) as string[];
  const propertyKeys = new Set(entries.map(([key]) => key));
  if (new Set(requiredKeys).size !== requiredKeys.length || requiredKeys.some((key) => !propertyKeys.has(key))) return null;
  const required = new Set(requiredKeys);
  const questions: AgentQuestion[] = [];
  const nativeValues = new Map<string, Map<string, string | boolean>>();

  for (const [id, property] of entries) {
    if (!boundedString(id, MAX_QUESTION_ID) || !isRecord(property)) return null;
    const title = property.title == null ? undefined : boundedString(property.title, MAX_QUESTION_HEADER);
    const description = property.description == null ? undefined : boundedString(property.description, MAX_QUESTION_TEXT);
    if ((property.title != null && !title) || (property.description != null && !description)) return null;
    const base = {
      id,
      ...(title ? { header: title } : {}),
      question: description ?? title ?? id,
      options: [] as AgentQuestion["options"],
      required: required.has(id),
      ...(questions.length === 0 ? { context } : {}),
    };

    if (property.type === "boolean") {
      const choices = [{ label: "True", value: true }, { label: "False", value: false }];
      nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
      questions.push({ ...base, customAnswerError: "cannot be delivered because the provider requires one of its typed choices", options: choices.map(({ label }) => ({ label })) });
      continue;
    }

    if (property.type === "array") {
      const choices = enumChoices(property.items);
      if (!choices) return null;
      const minSelections = nonnegativeInteger(property.minItems) ?? 0;
      const maxSelections = nonnegativeInteger(property.maxItems);
      if (
        (property.minItems != null && nonnegativeInteger(property.minItems) == null) ||
        (property.maxItems != null && maxSelections == null) ||
        (maxSelections != null && maxSelections < minSelections)
      ) return null;
      nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
      questions.push({
        ...base,
        multiSelect: true,
        customAnswerError: "cannot be delivered because the provider requires an array of its typed choices",
        options: choices.map(({ label }) => ({ label })),
        minSelections,
        ...(maxSelections != null ? { maxSelections } : {}),
      });
      continue;
    }

    if (property.type === "string") {
      const choices = enumChoices(property);
      if (choices) {
        nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
        questions.push({ ...base, customAnswerError: "cannot be delivered because the provider requires one of its typed choices", options: choices.map(({ label }) => ({ label })) });
        continue;
      }
      if (property.enum !== undefined || property.oneOf !== undefined || property.anyOf !== undefined) return null;
      const minLength = nonnegativeInteger(property.minLength);
      const providerMaxLength = nonnegativeInteger(property.maxLength);
      if (
        (property.minLength != null && minLength == null) ||
        (property.maxLength != null && providerMaxLength == null)
      ) return null;
      const maxLength = Math.min(providerMaxLength ?? MAX_FREE_TEXT, MAX_FREE_TEXT);
      if (minLength != null && minLength > maxLength) return null;
      const format = inputFormat(property.format);
      if (!format) return null;
      questions.push({
        ...base,
        allowOther: true,
        inputFormat: format,
        ...(minLength != null ? { minLength } : {}),
        maxLength,
      });
      continue;
    }

    if (property.type === "number" || property.type === "integer") {
      const minimum = finiteNumber(property.minimum);
      const maximum = finiteNumber(property.maximum);
      if (
        (property.minimum != null && minimum == null) ||
        (property.maximum != null && maximum == null) ||
        (minimum != null && maximum != null && minimum > maximum)
      ) return null;
      questions.push({
        ...base,
        allowOther: true,
        inputFormat: property.type,
        ...(minimum != null ? { minimum } : {}),
        ...(maximum != null ? { maximum } : {}),
      });
      continue;
    }
    return null;
  }

  return {
    questions,
    content: (answers) => Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
      const values = nativeValues.get(id);
      if (Array.isArray(answer)) {
        return [id, answer.map((label) => {
          const value = values?.get(label);
          return typeof value === "string" ? value : label;
        })];
      }
      if (values) return [id, values.get(answer) ?? answer];
      const question = questions.find((candidate) => candidate.id === id);
      return [id, question?.inputFormat === "number" || question?.inputFormat === "integer" ? Number(answer) : answer];
    })),
  };
}

/** Normalize the stable MCP form elicitation schema into Wollipog's structured question surface. */
export function normalizeMcpFormElicitation(params: unknown): NormalizedQuestionRequest | null {
  if (!isRecord(params) || params.mode !== "form") return null;
  const message = boundedString(params.message, MAX_QUESTION_TEXT);
  const serverName = boundedString(params.serverName, MAX_QUESTION_HEADER);
  if (!message || !serverName) return null;
  const form = normalizeForm(params.requestedSchema, `${serverName}: ${message}`);
  if (!form) return null;
  return {
    questions: form.questions,
    response: (answers, action) => action === "dismiss" || (action == null && Object.keys(answers).length === 0)
      ? mcpElicitationResponse("cancel")
      : mcpElicitationResponse("accept", form.content(answers)),
  };
}

const ANNOTATIONS = ["title", "description", "_meta"];

function hasOnlySchemaKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).every((key) => keys.includes(key) || ANNOTATIONS.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedChoices(schema: Record<string, unknown>, titledKey: "oneOf" | "anyOf"): NativeChoice[] | null {
  const choices = enumChoices(schema);
  if (!choices || new Set(choices.map(({ value }) => value)).size !== choices.length) return null;
  if (!Object.hasOwn(schema, titledKey)) return choices;
  const titled = schema[titledKey];
  return !Object.hasOwn(schema, "enum") && Array.isArray(titled) &&
    titled.every((choice) => hasOnlySchemaKeys(choice, ["const"])) ? choices : null;
}

/** ACP forms can carry arbitrary schema keywords. Accept only constraints this surface enforces.
 * In particular, never evaluate a provider-supplied pattern or resolve schema references. */
function supportedAcpProperty(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const common = ["type", "default"];
  switch (raw.type) {
    case "string":
      if ("enum" in raw || "oneOf" in raw) {
        return hasOnlySchemaKeys(raw, [...common, "enum", "oneOf"]) && supportedChoices(raw, "oneOf") !== null;
      }
      // The current text validator measures UTF-16 code units. Its upper bound is safe even
      // when the provider counts code points, but a lower bound would not be equivalent.
      return hasOnlySchemaKeys(raw, [...common, "maxLength"]) && raw.maxLength !== 0;
    case "array": {
      if (!hasOnlySchemaKeys(raw, [...common, "items", "minItems", "maxItems", "uniqueItems"])) return false;
      const items = raw.items;
      if (!hasOnlySchemaKeys(items, ["type", "enum", "anyOf"]) ||
          (items.type !== undefined && items.type !== "string")) return false;
      const choices = supportedChoices(items, "anyOf");
      return choices !== null && (nonnegativeInteger(raw.minItems) ?? 0) <= choices.length &&
        (raw.uniqueItems === undefined || typeof raw.uniqueItems === "boolean") && raw.maxItems !== 0;
    }
    case "boolean":
      return hasOnlySchemaKeys(raw, common);
    case "integer":
      if (Math.ceil(finiteNumber(raw.minimum) ?? -Infinity) > Math.floor(finiteNumber(raw.maximum) ?? Infinity)) return false;
      return hasOnlySchemaKeys(raw, [...common, "minimum", "maximum"]);
    case "number":
      return hasOnlySchemaKeys(raw, [...common, "minimum", "maximum"]);
    default:
      return false;
  }
}

export function normalizeAcpFormElicitation(params: Record<string, unknown>): {
  questions: AgentQuestion[];
  accept: (answers: Record<string, string | string[]>) => FormAcceptance;
} | null {
  const schema = params.requestedSchema;
  const message = boundedString(params.message, MAX_QUESTION_TEXT);
  if (params.mode !== "form" || !message || !hasOnlySchemaKeys(schema, ["type", "properties", "required", "additionalProperties"]) ||
      (schema.type !== undefined && schema.type !== "object") || !isRecord(schema.properties) ||
      (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")) return null;
  const form = normalizeForm({ ...schema, type: "object" }, `Google Antigravity: ${message}`);
  if (!form || !Object.values(schema.properties).every(supportedAcpProperty)) return null;
  return { questions: form.questions, accept: (answers) => ({ action: "accept", content: form.content(answers) }) };
}

export function mcpElicitationResponse(action: McpElicitationAction, content: FormContent | null = null) {
  return { action, content: action === "accept" ? content : null, _meta: null };
}
