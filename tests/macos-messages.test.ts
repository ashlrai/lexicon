/**
 * LexiconBar (apps/macos) messages: each failure the app shows names a next
 * step, and every `lexicon ...` command its sources name exists with that
 * syntax. No Swift toolchain runs here, so this pins the sources, and checks
 * the commands against the CLI's own `--help`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SOURCES = path.join(process.cwd(), 'apps/macos/LexiconBar/Sources');

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith('.swift') ? [full] : [];
  });
}

const source = (rel: string): string => readFileSync(path.join(SOURCES, 'LexiconBar', rel), 'utf8');

describe('LexiconBar messages name a next step', () => {
  // Catches: a failure line that said what went wrong and stopped there.
  it.each([
    ['ChildProcessSupervisor.swift', 'state = .failed("The lexicon CLI was not found. Set its path in Preferences.")'],
    ['ChildProcessSupervisor.swift', 'restarts. Run `lexicon \\(name)` in Terminal to see the error, then switch it on again from the menu.'],
    ['AppDelegate.swift', 'another app may own it. Pick another shortcut in Preferences > Hotkeys.'],
    ['AppDelegate.swift', 's. Run `lexicon voice --seconds 3 --model \\(self.settings.model)` in Terminal to see where it stops'],
    ['AppDelegate.swift', 'Unexpected voice output, so the lexicon CLI and LexiconBar are likely different releases; update lexicon (npm i -g @ashlr/lexicon) or LexiconBar.'],
    ['AppDelegate.swift', 'printed no global path, so the lexicon CLI and LexiconBar are likely different releases; choose Run doctor from the menu'],
    ['AppDelegate.swift', 'or `lexicon add <canonical> <alias>` (for example `lexicon add \\"Ashlr.AI\\" Ashler`) to create it'],
    ['AppDelegate.swift', 'Turn LexiconBar on in System Settings > General > Login Items instead.'],
    ['App.swift', 'Check it with `lexicon serve --status`; start it with `lexicon serve`, or `lexicon serve --install` to keep it running at login.'],
    ['App.swift', '(token ? "" : ". Run `lexicon serve --show` to create it.")'],
    ['Onboarding/OnboardingViews.swift', 'Button("Try again") { model.loadPacks() }'],
    ['Onboarding/OnboardingViews.swift', 'add packs later with `lexicon pack add <name>`.'],
    ['FixEverywhere/NormalizeClient.swift', '"Local API unreachable; check it with `lexicon serve --status` and start it with `lexicon serve`. Cause: \\(why)"'],
    [
      'FixEverywhere/NormalizeClient.swift',
      '"Local API returned an unexpected body, so `lexicon serve` and LexiconBar are likely different releases; update lexicon (npm i -g @ashlr/lexicon) or LexiconBar, then restart `lexicon serve`."',
    ],
  ])('%s: %s', (file, text) => {
    expect(source(file)).toContain(text);
  });

  it('names the menu items and Preferences sections it sends the user to', () => {
    const delegate = source('AppDelegate.swift');
    expect(delegate).toContain('add("Run doctor", #selector(runDoctor)');
    expect(delegate).toMatch(/ChildProcessSupervisor\(name: "daemon", arguments: \["daemon"/);
    expect(delegate).toMatch(/ChildProcessSupervisor\(name: "serve", arguments: \["serve"\]/);
    const prefs = source('PreferencesWindow.swift');
    expect(prefs).toContain('Section("Hotkeys")');
    expect(prefs).toContain('Picker("Whisper model"');
    expect(source('Settings.swift')).toContain('"base.en"');
  });
});

describe('the lexicon commands LexiconBar names exist', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-macos-msg-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const helpCache = new Map<string, string>();
  const help = (words: string[]): string => {
    const key = words.join(' ');
    const cached = helpCache.get(key);
    if (cached !== undefined) return cached;
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...words, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, LEXICON_PATH: path.join(home, 'lexicon.yaml'), NO_COLOR: '1' },
    });
    const out = run.status === 0 ? run.stdout : '';
    helpCache.set(key, out);
    return out;
  };

  const spans = swiftFiles(SOURCES).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/`lexicon ([^`]*)`/g)].map((m) => ({ file: path.relative(SOURCES, file), text: m[1] })),
  );

  it('finds the commands to check', () => {
    expect(spans.length).toBeGreaterThan(20);
  });

  // Catches: the "No lexicon file yet" alert said `lexicon add <term>`, while
  // the CLI takes `lexicon add <canonical> [aliases...]`.
  it('checks every subcommand, flag and placeholder against --help', { timeout: 120_000 }, () => {
    const problems: string[] = [];
    for (const { file, text } of spans) {
      const tokens = text
        .replace(/\\\([^)]*\)/g, 'VALUE')
        .replace(/\\"/g, '"')
        .replace(/[[\]]/g, '')
        .split(/\s+/)
        .filter((t) => t && t !== '&&');
      // `lexicon <arguments>` and `lexicon \(name)` name no fixed command.
      if (!tokens.length || tokens[0] === 'VALUE' || tokens[0].startsWith('<')) continue;
      const words = [tokens.shift() as string];
      let out = help(words);
      if (!out) {
        problems.push(`${file}: lexicon ${text}: no command "${words[0]}"`);
        continue;
      }
      while (tokens.length && /^[a-z][a-z-]*$/.test(tokens[0]) && new RegExp(`^  ${tokens[0]}[ |]`, 'm').test(out.split('Commands:')[1] ?? '')) {
        words.push(tokens.shift() as string);
        out = help(words);
      }
      const usage = out.split('\n')[0];
      const args = [...usage.matchAll(/[<[]([a-z-]+)(?:\.\.\.)?[>\]]/g)].map((m) => m[1]).filter((a) => a !== 'options' && a !== 'command');
      let previousFlag = false;
      for (const token of tokens) {
        if (token.startsWith('--')) {
          if (!out.includes(token.split('=')[0])) problems.push(`${file}: lexicon ${text}: ${words.join(' ')} has no ${token}`);
          previousFlag = true;
          continue;
        }
        const placeholder = /^<([a-z-]+)>$/.exec(token)?.[1];
        if (placeholder && !previousFlag && !args.some((a) => a.startsWith(placeholder) || placeholder.startsWith(a))) {
          problems.push(`${file}: lexicon ${text}: <${placeholder}> is not an argument of "${usage}"`);
        }
        previousFlag = false;
      }
    }
    expect(problems).toEqual([]);
  });
});
