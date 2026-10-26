import {
  CLIENTS,
  DEMO,
  DESCRIPTION,
  DOC,
  DOWNLOADS,
  INSTALL_COMMANDS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_TOOLS,
  NPM,
  PRIMARY_COMMAND,
  REPO,
  SITE_URL,
  VERSION,
} from '@/lib/site';

export const dynamic = 'force-static';

/*
 * https://lexicon.ashlr.ai/capabilities.json
 *
 * The "can it and how" document. /mcp.json answers "what config do I merge";
 * this answers the wider question an agent asks first: what does this thing do,
 * what does it cost, what does it touch, and what proves it worked. Every field
 * is assembled from the same lib/site.ts constants the page renders, so the
 * endpoint cannot quietly disagree with the site.
 */
const CAPABILITIES = {
  $comment:
    'Capabilities and install manifest for Lexicon. For the MCP client config ' +
    'block itself, fetch ' +
    SITE_URL +
    '/mcp.json and merge `.mcpServers` verbatim.',

  name: 'lexicon',
  displayName: 'Lexicon',
  version: VERSION,
  description: DESCRIPTION,
  license: 'MIT',
  licenseUrl: `${REPO}/blob/main/LICENSE`,
  homepage: SITE_URL,
  repository: REPO,
  packageName: '@ashlr/lexicon',
  packageRegistry: NPM,
  demo: DEMO,
  author: { name: 'Ashlr.AI', url: 'https://ashlr.ai' },

  pricing: { model: 'free', price: 0, currency: 'USD', note: 'MIT-licensed, no paid tier, no account' },
  privacy: {
    telemetry: false,
    account: false,
    network: 'loopback only, except `lexicon voice` fetching a whisper.cpp model on first use',
  },

  capabilities: [
    'Corrects mis-transcribed proper nouns in dictated text before an agent reads it',
    `MCP server over stdio with ${MCP_TOOLS.length} tools, ${MCP_RESOURCES.length} resources and ${MCP_PROMPTS.length} prompts`,
    'Claude Code plugin with SessionStart and UserPromptSubmit hooks',
    'Browser extension for ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot and Poe',
    'macOS menu bar app that rewrites any focused text field',
    'Loopback HTTP API on 127.0.0.1:41733',
    'Imports and exports the dictionaries of Wispr Flow, Superwhisper, macOS, espanso and the speech vendors',
  ],

  surfaces: [
    { name: 'mcp-server', where: 'before an agent reads a prompt', how: 'stdio MCP server plus Claude Code hooks' },
    { name: 'browser-extension', where: 'before send in a web chat', how: 'Manifest V3 extension, release zip' },
    { name: 'macos-menubar', where: 'any focused macOS text field', how: 'Accessibility API rewrite in place' },
    { name: 'local-api', where: 'your own scripts', how: 'HTTP on 127.0.0.1:41733' },
    { name: 'cli', where: 'a terminal', how: 'lexicon normalize and friends' },
  ],

  install: {
    recommended: PRIMARY_COMMAND,
    noGlobalInstall: INSTALL_COMMANDS.npx,
    homebrew: INSTALL_COMMANDS.brew,
    npm: INSTALL_COMMANDS.npm,
    claudeCodePlugin: [INSTALL_COMMANDS.claudePlugin, INSTALL_COMMANDS.claudePluginInstall],
    afterInstall: 'lexicon setup',
    nonInteractive: 'lexicon setup --yes --packs developer,ai',
    page: `${SITE_URL}/install`,
  },

  // One command per client; each writes that client's own config file.
  clients: Object.fromEntries(CLIENTS.map((c) => [c, `lexicon install ${c} --apply`])),
  anyOtherClient: 'lexicon install generic',

  commands: {
    normalize: 'lexicon normalize "<text>"',
    addTerm: 'lexicon add "<canonical>"',
    learn: 'lexicon learn "<heard>" "<meant>"',
    doctor: 'lexicon doctor',
    stats: 'lexicon stats',
    export: 'lexicon export <format>',
    serve: 'lexicon serve',
  },

  tools: MCP_TOOLS,
  resources: MCP_RESOURCES,
  prompts: MCP_PROMPTS,

  verify: {
    cli: 'lexicon normalize "tell Ashler to ship it"',
    expect: 'tell Ashlr.AI to ship it',
    doctor: 'lexicon doctor',
  },

  downloads: DOWNLOADS,

  endpoints: {
    llmsTxt: `${SITE_URL}/llms.txt`,
    llmsFullTxt: `${SITE_URL}/llms-full.txt`,
    mcpJson: `${SITE_URL}/mcp.json`,
    serverJson: `${SITE_URL}/server.json`,
    wellKnownServerJson: `${SITE_URL}/.well-known/mcp/server.json`,
    agentsMd: `${SITE_URL}/AGENTS.md`,
    install: `${SITE_URL}/install`,
    sitemap: `${SITE_URL}/sitemap.xml`,
  },

  docs: {
    forAgents: DOC('docs/AGENTS.md'),
    mcpReference: DOC('docs/MCP.md'),
    clients: DOC('docs/CLIENTS.md'),
    quickstart: DOC('docs/QUICKSTART.md'),
    security: DOC('SECURITY.md'),
  },
};

export function GET() {
  return new Response(JSON.stringify(CAPABILITIES, null, 2) + '\n', {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
