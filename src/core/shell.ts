/**
 * Quoting for the commands lexicon prints for a person to copy into a
 * terminal (`to apply, run: ...`, `then run: ...`). On POSIX that is a POSIX
 * shell; on Windows it is PowerShell, the default in Windows Terminal. One
 * source, so every printed command on a platform is quoted the same way.
 */

/** `s` as one POSIX shell word: bare when it is plainly safe, else single-quoted. */
export function posixShellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `s` as one PowerShell word: bare when it is plainly safe (backslashes and a
 * `~` inside the word, as in `C:\Users\RUNNER~1`, included), else
 * single-quoted with every quote doubled. A comma is quoted (bare, PowerShell
 * reads `a,b` as an array and passes two arguments), and so is a leading `@`
 * (splatting) or `~` (the home directory). PowerShell also closes a
 * single-quoted string on U+2018 to U+201B, so those are doubled too.
 */
export function powerShellWord(s: string): string {
  return /^[\w+=:./\\-][\w@+=:./\\~-]*$/.test(s) ? s : `'${s.replace(/['\u2018-\u201B]/g, (c) => c + c)}'`;
}

/** `s` as one word for the shell a printed command is pasted into on `platform`. */
export function shellWord(s: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? powerShellWord(s) : posixShellWord(s);
}

/**
 * The command line `words` as the user's shell reads it on `platform`. On
 * Windows a quoted first word needs PowerShell's call operator `& ` in front:
 * PowerShell reads `'C:\Program Files\x.exe'` alone as a string, not a command.
 */
export function commandLine(words: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const quoted = words.map((w) => shellWord(w, platform));
  return `${platform === 'win32' && words.length > 0 && quoted[0] !== words[0] ? '& ' : ''}${quoted.join(' ')}`;
}
