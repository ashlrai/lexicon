import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError, type Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';

const contract = readFileSync(fileURLToPath(new URL('../docs/CONTRACT.md', import.meta.url)), 'utf8');
const sink = { stdout: () => undefined, stderr: () => undefined };

function program(): Command {
  const root = buildProgram(sink);
  const configure = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    cmd.commands.forEach(configure);
  };
  configure(root);
  return root;
}

describe('contract dry-run scope flags', () => {
  it.each([
    { command: '`init`', args: ['init'], supported: ['--project'], unsupported: ['--global', '--scope'] },
    { command: '`untrust [path]`', args: ['untrust'], supported: [], unsupported: ['--project', '--global', '--scope'] },
    { command: '`pack add <name...>` (built-in)', args: ['pack', 'add', 'developer'], supported: ['--project'], unsupported: ['--global', '--scope'] },
  ])('$command agrees with help and rejects unsupported flags', async ({ command, args, supported, unsupported }) => {
    const row = contract.split('\n').find((line) => line.startsWith(`  | ${command} |`));
    expect(row).toBeDefined();
    const columns = row!.split('|');
    let cmd = program();
    for (const name of args.filter((arg) => arg !== 'developer')) {
      cmd = cmd.commands.find((child) => child.name() === name)!;
      expect(cmd).toBeDefined();
    }
    const help = cmd.helpInformation();
    expect(help).toContain('--dry-run');
    for (const flag of supported) {
      expect(columns[2]).toContain(`\`${flag}\``);
      expect(help).toContain(flag);
    }
    for (const flag of unsupported) {
      expect(columns[3]).toContain(`\`${flag}\``);
      expect(help).not.toContain(flag);
      await expect(program().parseAsync(['node', 'lexicon', ...args, '--dry-run', flag, ...(flag === '--scope' ? ['global'] : [])]))
        .rejects.toMatchObject({ code: 'commander.unknownOption', exitCode: 1 } satisfies Partial<CommanderError>);
    }
  });
});
