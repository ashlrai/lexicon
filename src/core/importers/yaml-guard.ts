import { Lexer } from 'yaml';

/**
 * Bound flow nesting before YAML builds its syntax tree. Dictionary formats
 * need only a handful of levels; excessive nesting can exhaust the parser's
 * stack even when the file is below the import byte limit. The YAML lexer
 * keeps quoted strings, comments and block scalars whole, so their brackets
 * do not count as structure.
 */
export function guardYamlImport(content: string): void {
  let depth = 0;
  let quoted = false;
  for (const token of new Lexer().lex(content)) {
    if (token === '[' || token === '{') {
      if (++depth > 128) throw new Error('YAML import exceeds the maximum flow nesting depth of 128');
    } else if (token === ']' || token === '}') {
      depth = Math.max(0, depth - 1);
    }
    const nextQuoted = token.startsWith('"') || token.startsWith("'");
    // Adjacent quoted scalars have no YAML interpretation. Reject immediately
    // rather than asking the parser to accumulate an error for every pair.
    if (quoted && nextQuoted) throw new Error('YAML import has adjacent quoted scalars without a separator');
    quoted = nextQuoted;
  }
}
