import {
  CLIENTS,
  DEMO,
  DESCRIPTION,
  DOC,
  INSTALL_COMMANDS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_CONFIG,
  MCP_TOOLS,
  NPM,
  PRIMARY_COMMAND,
  REPO,
  SITE_URL,
  VERSION,
} from '@/lib/site';

export const dynamic = 'force-static';

/*
 * A stable, machine-readable install manifest at https://lexicon.ashlr.ai/mcp.json
 *
 * The shape is deliberate. `mcpServers` is at the top level and contains
 * nothing but the block a client's config file wants, so an agent can fetch this
 * document, take `.mcpServers`, and merge it into ~/.cursor/mcp.json (or
 * wherever) without editing a thing. Everything else -- how to get the binary on
 * PATH first, what the tools are, how to check it worked -- sits in sibling keys
 * where it cannot contaminate that merge.
 */
const MANIFEST = {
  $comment:
    'Install manifest for the Lexicon MCP server. Merge the `mcpServers` key into your ' +
    'MCP client config verbatim. Install the CLI first (see `install`) so `lexicon-mcp` ' +
    'is on PATH. Docs: ' +
    SITE_URL +
    '/llms-full.txt',

  name: 'lexicon',
  displayName: 'Lexicon',
  version: VERSION,
  description: DESCRIPTION,
  license: 'MIT',
  homepage: SITE_URL,
  repository: REPO,
  packageName: '@ashlr/lexicon',
  packageRegistry: NPM,
  demo: DEMO,
  author: { name: 'Ashlr.AI', url: 'https://ashlr.ai' },

  // The whole point of the document.
  mcpServers: MCP_SERVER_CONFIG.mcpServers,

  transport: 'stdio',
  runtime: { node: '>=20' },
  requiresApiKey: false,
  requiresAccount: false,
  network: 'none beyond 127.0.0.1; the only outbound request in the codebase is `lexicon voice` fetching a whisper.cpp model on first use',

  install: {
    recommended: PRIMARY_COMMAND,
    noGlobalInstall: INSTALL_COMMANDS.npx,
    homebrew: INSTALL_COMMANDS.brew,
    npm: INSTALL_COMMANDS.npm,
    claudeCodePlugin: [INSTALL_COMMANDS.claudePlugin, INSTALL_COMMANDS.claudePluginInstall],
    afterInstall: 'lexicon setup',
    nonInteractive: 'lexicon setup --yes --packs developer,ai',
  },

  // One command per client; each writes that client's own config file.
  clients: Object.fromEntries(
    CLIENTS.map((c) => [c, `lexicon install ${c} --apply`]),
  ),
  anyOtherClient: 'lexicon install generic',

  verify: {
    cli: 'lexicon normalize "tell Ashler to ship it"',
    expect: 'tell Ashlr.AI to ship it',
    doctor: 'lexicon doctor',
    overMcp: 'call lexicon_doctor and read `ok`; call normalize_transcript on a sentence containing a known alias and read `changed`',
  },

  tools: MCP_TOOLS,
  resources: MCP_RESOURCES,
  prompts: MCP_PROMPTS,

  docs: {
    forAgents: DOC('docs/AGENTS.md'),
    agentNative: DOC('docs/AGENT-NATIVE.md'),
    mcpReference: DOC('docs/MCP.md'),
    clients: DOC('docs/CLIENTS.md'),
    quickstart: DOC('docs/QUICKSTART.md'),
    faq: DOC('docs/FAQ.md'),
    security: DOC('SECURITY.md'),
    llmsTxt: `${SITE_URL}/llms.txt`,
    llmsFullTxt: `${SITE_URL}/llms-full.txt`,
  },
};

export function GET() {
  return new Response(JSON.stringify(MANIFEST, null, 2) + '\n', {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
