/*
 * Typed access to lib/generated/discovery.json, which
 * scripts/gen-discovery.mjs derives from ../README.md, ../docs and
 * ../server.json at every build. The file is gitignored, so the site cannot
 * drift from the repository it describes: rename a doc's H1 or add a section
 * and the next build changes what /llms.txt, /llms-full.txt, /server.json,
 * /.well-known/mcp/server.json and /AGENTS.md say, with nothing to edit here.
 */
import raw from './generated/discovery.json';

export type DocIndexEntry = {
  /** Repository-relative path, e.g. `docs/QUICKSTART.md`. */
  file: string;
  /** The doc's first `# ` heading. */
  title: string;
  /** The doc's first prose paragraph, trimmed to a sentence or two. */
  blurb: string;
  /** Its `## ` and `### ` headings, in order. */
  sections: string[];
};

export type Discovery = {
  generatedBy: string;
  docs: DocIndexEntry[];
  readme: { file: string; title: string; sections: { heading: string; anchor: string }[] };
  /** The repository's MCP registry manifest, verbatim. */
  serverJson: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: { url?: string; source?: string };
    packages?: unknown[];
    remotes?: unknown[];
    [key: string]: unknown;
  };
  /** docs/AGENTS.md, whole. */
  agentsMd: string | null;
};

export const DISCOVERY = raw as Discovery;

/** The doc-index entry for a repository path, or undefined when it is not a doc. */
export function docEntry(file: string): DocIndexEntry | undefined {
  return DISCOVERY.docs.find((d) => d.file === file);
}
