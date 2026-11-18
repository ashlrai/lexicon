/**
 * The lexicon CLI's exit codes, so a script or agent branches on the number
 * instead of parsing text. Every command uses this table (under `--json` the
 * same `code` sits in the failure document next to `ok: false`), except
 * `lexicon voice`, which keeps its own documented scheme (1 error, 2
 * ffmpeg/whisper-cli missing, 3 nothing heard) already carried in its `--json`.
 *
 * 1 is also the catch-all: a failure with no more specific code exits 1, as
 * it always did, so only the three new numbers are a behaviour change.
 * No imports: `--help` loads this file.
 */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_NOT_FOUND = 2;
export const EXIT_NOT_ALLOWED = 3;
export const EXIT_UNAVAILABLE = 4;

/** The "Exit codes" help section, plain words, shared by `lexicon --help` and the README. */
export function exitCodesHelpText(): string {
  return [
    'Exit codes:',
    '  0  ok',
    '  1  usage error (unknown command, option or value), or any failure not listed below',
    '  2  not found (no such term, alias or path)',
    '  3  not allowed (the project lexicon is untrusted, so nothing was read or written)',
    '  4  unavailable (the local server is down, unhealthy, or the port is taken)',
    '',
    'Under --json a failure also prints {"ok":false,"code":N,"error":"plain words"} on stdout.',
    'lexicon voice keeps its own codes: 1 error, 2 ffmpeg/whisper-cli missing, 3 nothing heard.',
  ].join('\n');
}
