/**
 * A `lexicon` CLI command as an agent should name it to the user. A user who
 * installed only the Claude Code plugin has no `lexicon` on PATH, so the same
 * command through npx follows it.
 */
export function cliCommand(args: string): string {
  return `\`lexicon ${args}\` (or \`npx @ashlr/lexicon ${args}\`)`;
}
