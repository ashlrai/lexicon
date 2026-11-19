/**
 * The lexicon CLI's exit codes, one table for every command so a script or
 * agent branches on the number instead of parsing text. Two numbers exist:
 * 0 success, 1 failure. The names say why a command failed (usage, not found,
 * or a runtime failure such as an untrusted project lexicon); they all exit 1
 * so existing scripts keep working, and the `--json` failure document keeps its
 * `{ ok: false, error, nextStep }` shape. The reason is in `error`.
 * `lexicon voice` keeps its own documented scheme (src/voice/voice.ts).
 * No imports: `--help` loads this file.
 */
export const EXIT_OK = 0;
/** Unknown command, option or value. */
export const EXIT_USAGE = 1;
/** No such term, alias, pack or path. */
export const EXIT_NOT_FOUND = 1;
/** Anything else that went wrong: an untrusted project lexicon, an unreadable file, a down server. */
export const EXIT_FAILURE = 1;

/** The "Exit codes" help section, plain words, shared by `lexicon --help` and the README. */
export function exitCodesHelpText(): string {
  return [
    'Exit codes:',
    '0  ok',
    '1  failed (usage error, not found, or a runtime failure); stderr and the --json error say which',
    '',
    'Under --json a failure prints {"ok":false,"error":"plain words","nextStep":"what to do"} on stdout.',
    'lexicon voice keeps its own codes: 1 error, 2 ffmpeg/whisper-cli missing, 3 nothing heard.',
  ].join('\n');
}
