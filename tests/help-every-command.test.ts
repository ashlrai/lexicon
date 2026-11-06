/**
 * Every lexicon <command> must produce non-empty --help text. This test builds
 * the Commander program, walks every registered command (including nested
 * subcommands like pack add), calls .helpInformation() on each, and fails when
 * the trimmed output is blank. Zero source files changed — only a test is added.
 */
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';

describe('all commands have non-empty help text', () => {
  it('every top-level command produces --help output', () => {
    const program = buildProgram(makeIO());
    for (const cmd of program.commands ?? []) {
      const help = cmd.helpInformation().trim();
      expect(help, `${cmd.name()} --help was empty`).not.toBe('');
      expect(help).toMatch(/usage/i);
    }
  });

  it('every subcommand produces --help output', () => {
    const program = buildProgram(makeIO());
    for (const cmd of program.commands ?? []) {
      for (const sub of cmd.commands ?? []) {
        const subName = sub.name();
        const help = sub.helpInformation().trim();
        expect(help, `${cmd.name()} ${subName} --help was empty`).not.toBe('');
        expect(help).toMatch(/usage/i);
      }
    }
  });

  it('every command has a non-empty description', () => {
    const program = buildProgram(makeIO());
    for (const cmd of program.commands ?? []) {
      const desc = cmd.description()?.trim();
      expect(desc, `${cmd.name()} description was empty`).not.toBe('');
    }
    for (const cmd of program.commands ?? []) {
      for (const sub of cmd.commands ?? []) {
        const subName = sub.name();
        const desc = sub.description()?.trim();
        expect(desc, `${cmd.name()} ${subName} description was empty`).not.toBe('');
      }
    }
  });
});
