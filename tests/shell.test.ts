import { describe, expect, it } from 'vitest';
import { commandLine, posixShellWord, powerShellWord, shellWord } from '../src/core/index.js';

// The quoting of every command lexicon prints for a person to copy: POSIX on
// macOS and Linux, PowerShell on Windows. Each platform branch is tested here
// on any host, since CI on Linux cannot run the Windows one.
describe('shell quoting for printed commands', () => {
  it('leaves a plain word bare and single-quotes the rest for a POSIX shell', () => {
    expect(posixShellWord('/tmp/lexicon-x/index.yaml')).toBe('/tmp/lexicon-x/index.yaml');
    expect(posixShellWord('claude,cursor')).toBe('claude,cursor');
    expect(posixShellWord("Ashlr's AI")).toBe(`'Ashlr'\\''s AI'`);
    expect(posixShellWord('')).toBe(`''`);
  });

  // Catches: Windows got POSIX quoting, which single-quoted every backslash
  // path and wrote a quote as '\'' (PowerShell reads that as two strings and a
  // stray backslash), while the voice rerun used PowerShell's own rules.
  it('quotes for PowerShell on Windows: backslash paths bare, a quote doubled', () => {
    expect(powerShellWord('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x')).toBe('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x');
    expect(powerShellWord("Ashlr's AI")).toBe(`'Ashlr''s AI'`);
    expect(powerShellWord('C:\\Program Files\\x')).toBe(`'C:\\Program Files\\x'`);
    expect(powerShellWord('C:\\odd$dir\\x')).toBe(`'C:\\odd$dir\\x'`);
    expect(powerShellWord('it\u2019s')).toBe(`'it\u2019\u2019s'`);
    expect(powerShellWord('')).toBe(`''`);
  });

  // Catches: bare, PowerShell reads `claude,cursor` as an array and passes two
  // arguments, `@x` as splatting and a leading `~` as the home directory.
  it('quotes what PowerShell would read as an operator', () => {
    expect(powerShellWord('claude,cursor')).toBe(`'claude,cursor'`);
    expect(powerShellWord('@ashlr/lexicon@1.2.3')).toBe(`'@ashlr/lexicon@1.2.3'`);
    expect(powerShellWord('example/cardiology@1')).toBe('example/cardiology@1');
    expect(powerShellWord('~\\lexicon')).toBe(`'~\\lexicon'`);
  });

  it('picks the quoting by platform, with the call operator before a quoted command on Windows', () => {
    expect(shellWord("a'b", 'win32')).toBe(`'a''b'`);
    expect(shellWord("a'b", 'darwin')).toBe(`'a'\\''b'`);
    expect(commandLine(['lexicon', '--cwd', 'C:\\a b', 'setup'], 'win32')).toBe(`lexicon --cwd 'C:\\a b' setup`);
    expect(commandLine(['C:\\a b\\whisper-cli.exe', '-f', 'x.wav'], 'win32')).toBe(`& 'C:\\a b\\whisper-cli.exe' -f x.wav`);
    expect(commandLine(['/a b/whisper-cli', '-f', 'x.wav'], 'linux')).toBe(`'/a b/whisper-cli' -f x.wav`);
  });
});
