/** Structural comparison of RPC records from real Pi and from fake-pi-rpc.mjs. The fixture is the
 * contract the driver tests rely on, so every record kind, field path, JSON type and enum value the
 * fixture emits must also be emitted by real Pi. Extra real-only fields are not drift. */
type Json = Record<string, any>;
export type RecordShapes = Map<string, Map<string, Set<string>>>;

/** Fields whose values, not just types, select driver behavior. */
const ENUM_FIELDS = new Set(["type", "command", "method", "source", "location", "role", "stopReason", "success"]);

export function recordKey(record: Json): string | null {
  if (!record || typeof record !== "object" || typeof record.type !== "string") return null;
  if (record.type === "response") return `response:${record.command}`;
  if (record.type === "message_update") return `event:message_update:${record.assistantMessageEvent?.type}`;
  if (record.type === "extension_ui_request") return `event:extension_ui_request:${record.method}`;
  return `event:${record.type}`;
}

function jsonType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function addShape(value: unknown, path: string, out: Map<string, Set<string>>): void {
  const add = (entry: string) => { const types = out.get(path) ?? new Set<string>(); types.add(entry); out.set(path, types); };
  if (path) add(jsonType(value));
  const leaf = path.split(".").at(-1)!.replace(/\[\]$/, "");
  if (ENUM_FIELDS.has(leaf) && (typeof value === "string" || typeof value === "boolean")) add(`=${JSON.stringify(value)}`);
  if (Array.isArray(value)) for (const item of value) addShape(item, `${path}[]`, out);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) addShape(item, path ? `${path}.${key}` : key, out);
}

export function recordShapes(records: Json[]): RecordShapes {
  const shapes: RecordShapes = new Map();
  for (const record of records) {
    const key = recordKey(record);
    if (!key) continue;
    const { id: _id, ...rest } = record;
    const paths = shapes.get(key) ?? new Map<string, Set<string>>();
    addShape(rest, "", paths);
    shapes.set(key, paths);
  }
  return shapes;
}

/** Differences where the fixture claims something real Pi did not emit. Empty means no drift. */
export function compareShapes(fixture: RecordShapes, real: RecordShapes, ignored: ReadonlySet<string> = new Set()): string[] {
  const differences: string[] = [];
  for (const [key, paths] of fixture) {
    const actual = real.get(key);
    if (!actual) { differences.push(`${key}: emitted by fake-pi-rpc.mjs, never by real Pi`); continue; }
    for (const [path, entries] of paths) {
      if (ignored.has(`${key} ${path}`)) continue;
      const seen = actual.get(path);
      if (!seen) { differences.push(`${key} ${path}: fixture field absent from real Pi`); continue; }
      for (const entry of entries) {
        if (!seen.has(entry)) differences.push(`${key} ${path}: fixture ${entry.startsWith("=") ? "value" : "type"} ${entry} not seen in real Pi (${[...seen].join(", ")})`);
      }
    }
  }
  return differences;
}
