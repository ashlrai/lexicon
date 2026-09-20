import {
  DEMO,
  DESCRIPTION,
  FAQ,
  MCP_TOOLS,
  NPM,
  REPO,
  SITE_URL,
  TAGLINE,
  VERSION,
} from '@/lib/site';

/*
 * JSON-LD, which is the part an answer engine actually reads.
 *
 * Three things are deliberately absent:
 *
 *   aggregateRating / review  -- there are no reviews. Inventing a 4.8 from 312
 *                                ratings is the single fastest way to have the
 *                                whole block ignored, and it would be a lie.
 *   downloadCount / awards    -- same reason.
 *   a fabricated datePublished for each FAQ answer.
 *
 * Everything below is checkable against the repository.
 */

/** Answers carry backticks for code spans; JSON-LD wants prose. */
const plain = (s: string) => s.replace(/`/g, '');

const ORG_ID = `${SITE_URL}/#org`;
const APP_ID = `${SITE_URL}/#software`;
const SITE_ID = `${SITE_URL}/#website`;

const graph = [
  {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'Ashlr.AI',
    url: 'https://ashlr.ai',
    sameAs: ['https://github.com/ashlrai'],
  },
  {
    '@type': 'WebSite',
    '@id': SITE_ID,
    url: SITE_URL,
    name: 'Lexicon',
    description: DESCRIPTION,
    publisher: { '@id': ORG_ID },
    inLanguage: 'en-US',
  },
  {
    '@type': 'SoftwareApplication',
    '@id': APP_ID,
    name: 'Lexicon',
    alternateName: '@ashlr/lexicon',
    description: DESCRIPTION,
    disambiguatingDescription: `Lexicon is ${TAGLINE}: a local, open-source tool that rewrites proper nouns a speech recognizer got wrong, before an AI agent reads the transcript.`,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'Speech-to-text post-processing',
    operatingSystem: 'macOS, Linux, Windows',
    softwareVersion: VERSION,
    url: SITE_URL,
    downloadUrl: `${REPO}/releases/latest`,
    installUrl: `${SITE_URL}#install`,
    softwareHelp: `${REPO}/blob/main/docs/QUICKSTART.md`,
    releaseNotes: `${REPO}/blob/main/CHANGELOG.md`,
    softwareRequirements: 'Node.js 20 or newer',
    license: `${REPO}/blob/main/LICENSE`,
    isAccessibleForFree: true,
    author: { '@id': ORG_ID },
    publisher: { '@id': ORG_ID },
    maintainer: { '@id': ORG_ID },
    image: `${SITE_URL}/opengraph-image`,
    sameAs: [REPO, NPM, DEMO],
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: `${SITE_URL}#install`,
    },
    featureList: [
      'Corrects mis-transcribed proper nouns in dictated text',
      'MCP server with nineteen tools, two resources and two prompts',
      'Claude Code plugin with SessionStart and UserPromptSubmit hooks',
      'Browser extension for ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot and Poe',
      'macOS menu bar app that rewrites any focused text field',
      'Fifteen export formats and seven dictionary importers',
      'Runs entirely locally: no account, no telemetry, no network calls beyond loopback',
    ],
    keywords:
      'dictation, speech to text, transcription, MCP server, Model Context Protocol, custom dictionary, proper nouns, Claude Code, Cursor, Codex',
    potentialAction: {
      '@type': 'ViewAction',
      name: 'Try the matcher in your browser',
      target: DEMO,
    },
  },
  {
    '@type': 'BreadcrumbList',
    '@id': `${SITE_URL}/#breadcrumbs`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Lexicon', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Install', item: `${SITE_URL}#install` },
      { '@type': 'ListItem', position: 3, name: 'Frequently asked questions', item: `${SITE_URL}#faq` },
    ],
  },
  {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/#faq`,
    isPartOf: { '@id': SITE_ID },
    about: { '@id': APP_ID },
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: plain(f.a) },
    })),
  },
  {
    // The tool list as an ItemList, so an agent reading the markup rather than
    // /mcp.json still learns what the server can do.
    '@type': 'ItemList',
    '@id': `${SITE_URL}/#mcp-tools`,
    name: 'Lexicon MCP tools',
    description: 'The tools the Lexicon MCP server exposes over stdio.',
    numberOfItems: MCP_TOOLS.length,
    itemListElement: MCP_TOOLS.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      description: t.summary,
    })),
  },
];

const JSON_LD = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      // The payload is built from module constants in this repository, never
      // from user input, so there is nothing here to escape beyond `</script`.
      dangerouslySetInnerHTML={{ __html: JSON_LD.replace(/</g, '\\u003c') }}
    />
  );
}
