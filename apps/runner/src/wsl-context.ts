/** WSL distribution names are passed as positional argv values and UNC path components. */
export function validWslDistroName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() &&
    !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(value) && !value.endsWith(".");
}
