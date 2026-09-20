/**
 * Generates docs/CLI.md from the real `--help` output of every `lexicon`
 * command, so the reference can never drift from the code.
 *
 *   npm run docs:cli
 *
 * Runs the CLI from source (`node --import tsx src/cli/index.ts`), so no build
 * is needed. Commands are discovered from the top-level help, which means new
 * commands registered anywhere (index.ts or a cmd-*.ts module) are picked up.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const OUT = path.join(REPO_ROOT, 'docs', 'CLI.md');

/** Fixed width so the output is identical on every terminal and in CI. */
const COLUMNS = '100';

function help(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args, '--help'], {
    cwd: REPO_ROOT,
    env: { ...process.env, COLUMNS, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    // commander writes CRLF on Windows. This output is embedded verbatim
    // inside the fenced blocks of docs/CLI.md, which CI then asserts with
    // `git diff --exit-code`, so an un-normalized \r is committed content
    // rather than something git's clean filter hides: the generated file
    // would differ byte-for-byte depending on which OS generated it.
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

interface CommandEntry {
  /** Primary name, e.g. `remove` (aliases like `rm` are kept in `signature`). */
  name: string;
  /** The usage column from the top-level help, e.g. `remove|rm [options] <canonical>`. */
  signature: string;
  description: string;
}

/**
 * Parses commander's `Commands:` block. Each entry is
 * `  <signature padded>  <description>`; a continuation line is indented deeper.
 */
function parseCommands(topHelp: string): CommandEntry[] {
  const lines = topHelp.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'Commands:');
  if (start === -1) throw new Error('could not find the Commands: section in `lexicon --help`');
  const entries: CommandEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const m = /^ {2}(\S[^\n]*?) {2,}(\S.*)$/.exec(line);
    if (!m) {
      // Continuation of the previous description.
      if (entries.length > 0 && /^\s{4,}/.test(line)) entries[entries.length - 1].description += ` ${line.trim()}`;
      continue;
    }
    const signature = m[1].trim();
    const name = signature.split(/[\s|]/)[0];
    if (name === 'help') continue;
    entries.push({ name, signature, description: m[2].trim() });
  }
  return entries;
}

function fence(text: string): string {
  return `\`\`\`text\n${text}\n\`\`\``;
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  const top = help([]);
  const commands = parseCommands(top);

  const out: string[] = [];
  out.push('# CLI reference');
  out.push('');
  out.push(
    'Every command and flag, for when you know what you want to do and need the exact spelling. ' +
      'If you are still deciding, [QUICKSTART.md](QUICKSTART.md) and the task pages in ' +
      '[the docs index](README.md) are better starting points.',
  );
  out.push('');
  out.push(
    `Generated from \`lexicon --help\` (v${pkg.version}) by \`npm run docs:cli\`. Do not edit by hand; ` +
      'change the command definitions in `src/cli/` and re-run the generator.',
  );
  out.push('');
  out.push('Global option: `--cwd <dir>` sets the directory used to find the project `.lexicon.yaml`.');
  out.push('');
  out.push('## Commands');
  out.push('');
  out.push('| Command | Does |');
  out.push('|---|---|');
  for (const c of commands) {
    out.push(`| [\`lexicon ${c.signature.replace(/\|/g, '\\|')}\`](#lexicon-${anchor(c.name)}) | ${c.description} |`);
  }
  out.push('');
  out.push('## `lexicon`');
  out.push('');
  out.push(fence(top));
  for (const c of commands) {
    out.push('');
    out.push(`## \`lexicon ${c.name}\``);
    out.push('');
    out.push(fence(help([c.name])));
  }
  out.push('');
  // Points onward, never back at QUICKSTART.md, which is where most readers of
  // this page came from. No em-dashes: CONTRIBUTING.md bans them in docs, and
  // this file is a doc even though a script writes it.
  out.push('## See also');
  out.push('');
  out.push('- [MCP.md](MCP.md) has the same capabilities as tools your agent can call.');
  out.push('- [GROWING.md](GROWING.md) covers the commands that fill the lexicon for you.');
  out.push('- [LEXICON-FILE.md](LEXICON-FILE.md) is the file these commands read and write.');
  out.push('');
  out.push('Back to [the docs index](README.md).');
  out.push('');

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, out.join('\n'), 'utf8');
  console.log(`wrote ${path.relative(REPO_ROOT, OUT)} (${commands.length} commands)`);
}

await main();
