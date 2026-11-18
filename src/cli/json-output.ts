/** Stable CLI transport around the existing command-specific JSON payloads. */
import type { IO } from './args.js';

export interface CliJsonV1<T = unknown> {
  schemaVersion: 1;
  ok: boolean;
  data: T;
}

export function jsonV1<T>(data: T): CliJsonV1<T> {
  const failed = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
  return { schemaVersion: 1, ok: !(Array.isArray(data) ? data.some(failed) : failed(data)), data };
}

/** Only flags before `--` count; text passed to normalize stays literal. */
export function jsonInvocation(args: readonly string[]): { args: string[]; version?: string } {
  let version: string | undefined;
  let literal = false;
  const normalized = args.map((arg) => {
    if (arg === '--') literal = true;
    if (!literal && arg.startsWith('--json=')) {
      if (version === undefined || version === 'v1') version = arg.slice('--json='.length);
      return '--json';
    }
    return arg;
  });
  return { args: normalized, version };
}

/** Handlers write a complete JSON document per stdout call, including errors. */
export function versionedIO(io: IO): IO {
  return {
    stdout: (text) => io.stdout(`${JSON.stringify(jsonV1(JSON.parse(text)), null, 2)}\n`),
    stderr: (text) => io.stderr(text),
  };
}
