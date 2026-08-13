import {
  parseSourceLocation,
  type EditorInfo,
  type EditorLocationPrecision,
  type HostAction,
  type RunnerProtocolCapability,
} from "@wollipog/protocol";

export type ParsedSessionHostAction = {
  action: HostAction;
  capability: RunnerProtocolCapability;
};

function recordWithOnly(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => allowed.includes(key)) ? record : null;
}

function editorId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

/** Parse the public REST body strictly. The distinct location kind is deliberate rolling-version
 * protection: a pre-v59 control plane rejects it instead of opening only the session root. */
export function parseSessionHostAction(value: unknown): ParsedSessionHostAction | null {
  const base = recordWithOnly(value, ["kind", "editorId", "location"]);
  if (!base || !Object.hasOwn(base, "kind") || typeof base.kind !== "string") return null;
  if (base.kind === "reveal") {
    return Object.keys(base).length === 1 ? { action: { kind: "reveal" }, capability: "hostActions" } : null;
  }
  const id = editorId(Object.hasOwn(base, "editorId") ? base.editorId : undefined);
  if (!id) return null;
  if (base.kind === "open_editor") {
    if (base.location !== undefined || Object.keys(base).some((key) => !["kind", "editorId"].includes(key))) return null;
    return { action: { kind: "open_editor", editorId: id }, capability: "hostActions" };
  }
  if (base.kind !== "open_editor_location") return null;
  const location = parseSourceLocation(base.location, false);
  if (!location || Object.keys(base).some((key) => !["kind", "editorId", "location"].includes(key))) return null;
  const { path, line, column } = location;
  return {
    action: {
      kind: "open_editor_location",
      editorId: id,
      location: { path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) },
    },
    capability: "editorLocations",
  };
}

const PRECISION_RANK: Record<EditorLocationPrecision, number> = { file: 0, line: 1, column: 2 };

/** The CP does not know the runner-side session context, so it can only prove that at least one
 * advertised context supports the request. The runner repeats the exact native/WSL check. */
export function editorAdvertisesLocation(editor: EditorInfo | undefined, action: HostAction): boolean {
  if (!editor || action.kind !== "open_editor_location") return false;
  const requested: EditorLocationPrecision = action.location.column !== undefined
    ? "column"
    : action.location.line !== undefined ? "line" : "file";
  return [editor.locations?.native, editor.locations?.wsl].some(
    (precision) => precision !== undefined && PRECISION_RANK[precision] >= PRECISION_RANK[requested],
  );
}
