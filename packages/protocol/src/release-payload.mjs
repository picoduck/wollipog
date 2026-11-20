// Shared between the release script (plain Node) and the typed forge executor.
// Sort object keys without changing array order or the approved text.
export function canonicalReleasePayload(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item);
}
