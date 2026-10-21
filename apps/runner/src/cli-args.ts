export class CliError extends Error {
  /** Extra machine-readable fields merged into the JSON error object. */
  constructor(message: string, readonly exitCode: 1 | 2 = 1, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * `--name value` or `--name=value`. An option that is present but followed by another option
 * (`--runner --yes`, `--output --json`) or by nothing has an omitted value: that is a usage error,
 * never "absent", so an optional option can never silently fall back to its default. Only the `=`
 * form can supply a value that starts with `--`.
 */
export function option(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`${name} requires a value`, 2);
      return value;
    }
    if (args[i]?.startsWith(`${name}=`)) {
      const value = args[i]!.slice(name.length + 1);
      // `--output="$OUT"` with OUT unset must not silently become "no --output".
      if (value === "") throw new CliError(`${name} requires a value`, 2);
      return value;
    }
  }
  return undefined;
}

export function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
