/** Every product claim travels with the repository evidence that supports it. */
export type Source = { path: string; label: string };
export type Claim = {
  text: string;
  code?: string;
  sources: readonly [Source, ...Source[]];
};
export type UseCaseSection = { id: string; title: string; blocks: readonly Claim[] };
export type UseCase = {
  slug: string;
  title: string;
  description: string;
  intro: Claim;
  sections: readonly UseCaseSection[];
  docs: readonly Source[];
};

const file = { path: 'docs/LEXICON-FILE.md', label: 'Lexicon file reference' };
const matching = { path: 'docs/MATCHING.md', label: 'Matching rules and limits' };
const cli = { path: 'src/cli/program.ts', label: 'CLI command definitions' };
const clients = { path: 'docs/CLIENTS.md', label: 'Agent installation guide' };
const trust = { path: 'docs/TRUST.md', label: 'Project trust guide' };
const exports = { path: 'docs/EXPORTS.md', label: 'Import and export reference' };

export function useCasePath(slug: string): string {
  return `/use-cases/${slug}`;
}

export const useCases: readonly UseCase[] = [
  {
    slug: 'proper-name-dictation',
    title: 'Fix names in dictated text',
    description: 'Build a personal vocabulary for company names, people and products. Preview corrections, tune exceptions and check the result before using it.',
    intro: {
      text: 'When a transcript says "Ashler" but you mean "Ashlr.AI", Lexicon can map the observed spelling to your chosen name. You keep the canonical spelling and its aliases in a YAML file, then apply that vocabulary to text with the CLI, an agent integration or the browser extension.',
      sources: [file, clients],
    },
    sections: [
      {
        id: 'capture',
        title: 'Start with a name you actually correct',
        blocks: [
          {
            text: 'After installing the CLI, initialize your personal lexicon and add a correct spelling with the variants you have seen in transcripts. These commands create the global file if it is missing, then add or merge the term. Use your own name and observed aliases in place of this example.',
            code: 'lexicon init\nlexicon add "Ashlr.AI" Ashler Ashlar --category brand',
            sources: [cli, file],
          },
          {
            text: 'Use aliases deliberately. An explicit alias can override the common-word stoplist, so a broad alias can change ordinary prose too. A term does not need every plausible misspelling: phonetic and fuzzy matching are available, but they are guesses rather than a guarantee that a name will be recognized.',
            sources: [matching],
          },
        ],
      },
      {
        id: 'preview',
        title: 'Preview a correction before applying it',
        blocks: [
          {
            text: 'The first command reports proposed replacements while leaving the output text unchanged. The second prints the corrected text and a replacement summary. The summary goes to stderr, so stdout remains usable in a text pipeline.',
            code: 'lexicon normalize --dry-run "ask Ashler about the launch"\nlexicon normalize --diff "ask Ashler about the launch"',
            sources: [matching, cli],
          },
        ],
      },
      {
        id: 'exceptions',
        title: 'Keep ordinary words and code intact',
        blocks: [
          {
            text: 'A per-term never list prevents unwanted rewrites to that term. Here, "sass" is an alias for "SaaS", while "sauce" is an exception. For a word that no term should replace, use settings.protectedWords in the YAML file.',
            code: 'lexicon add SaaS sass --category acronym --never sauce',
            sources: [file, cli],
          },
          {
            text: 'With the default skipCode setting, the matcher leaves code spans, fenced blocks, URLs, email addresses and paths alone. For a run that should use only exact matches, disable the phonetic and fuzzy passes. Review real sentences as well as the name in isolation.',
            code: 'lexicon normalize --no-phonetic --no-fuzzy --diff "ask Ashlar about the launch"',
            sources: [matching, file],
          },
        ],
      },
      {
        id: 'use',
        title: 'Choose where to apply your vocabulary',
        blocks: [
          {
            text: 'Correcting text in the terminal does not install an integration in another app. Claude Code can receive correction context through hooks; other MCP clients can call Lexicon tools. The browser extension can correct supported chat composers before sending. Follow the installation guide for the surface you use, then test a sentence there.',
            sources: [clients, { path: 'docs/EXTENSION.md', label: 'Browser extension guide' }],
          },
        ],
      },
    ],
    docs: [file, matching, clients],
  },
  {
    slug: 'voice-coding',
    title: 'Use project vocabulary with coding agents',
    description: 'Set up vocabulary for dictated coding prompts, connect an agent and share reviewed project names with your team.',
    intro: {
      text: 'Lexicon combines a personal vocabulary with an optional project .lexicon.yaml. Coding agents can access that vocabulary through MCP, and Claude Code can also receive it through hooks. A shared project file stays excluded until each user reviews and trusts it.',
      sources: [file, clients, trust],
    },
    sections: [
      {
        id: 'connect',
        title: 'Connect the agent you use',
        blocks: [
          {
            text: 'After installing Lexicon, preview the configuration for your client, then apply it if the proposed changes are right. For example, these commands preview and write the Codex MCP configuration. Restart Codex after applying it so the session reads the new configuration. The agent installation guide covers the other supported clients and their reload steps.',
            code: 'lexicon install codex\nlexicon install codex --apply',
            sources: [clients, cli],
          },
          {
            text: 'The integration depends on the client. Claude Code hooks add correction context; they do not rewrite the original user prompt. An MCP registration makes tools such as normalize_transcript available, but registration alone does not guarantee that an agent calls them. Ask the agent to read lexicon://me before interpreting dictated text and verify a correction in a new session.',
            sources: [clients, { path: 'docs/MCP.md', label: 'MCP tools and resources' }],
          },
        ],
      },
      {
        id: 'project',
        title: 'Add the names your repository uses',
        blocks: [
          {
            text: 'From the repository, create a project lexicon and add names you say aloud. This example adds Kubernetes and an observed alias. The CLI writes .lexicon.yaml at the git root and trusts a newly created project file. If an existing file is untrusted or has changed, review it with lexicon trust before attempting an edit.',
            code: 'lexicon init --project\nlexicon add Kubernetes "cuban eats" --category product --project',
            sources: [file, trust, cli],
          },
          {
            text: 'You can inspect repository-derived candidates before adding any of them. Harvest proposes names from sources such as manifests and READMEs. Names found only in source code are excluded by default. The command below lists candidates without adding them. Select vocabulary you dictate instead of treating every identifier as a useful spoken alias.',
            code: 'lexicon harvest',
            sources: [{ path: 'docs/GROWING.md', label: 'Growing your vocabulary' }, cli],
          },
        ],
      },
      {
        id: 'share',
        title: 'Review a shared vocabulary with your team',
        blocks: [
          {
            text: 'Commit the reviewed .lexicon.yaml with your project to share it. Each teammate runs lexicon trust in a terminal to preview the terms and approve the file. Trust is pinned to its contents: a later change causes it to be skipped until reviewed again. When a trusted project and the personal file define the same name, project values take precedence and their aliases are combined.',
            code: 'lexicon trust\nlexicon trust --list',
            sources: [trust, file],
          },
        ],
      },
      {
        id: 'verify',
        title: 'Verify the project and the agent separately',
        blocks: [
          {
            text: 'Run a correction from the project directory and inspect which files Lexicon uses. The diff checks the vocabulary and matcher; it does not prove that your client loaded its MCP server. Use the client reload instructions, then ask that agent to normalize the same sentence and inspect the returned replacements.',
            code: 'lexicon path\nlexicon normalize --diff "review the cuban eats rollout"\nlexicon doctor',
            sources: [clients, file, matching, cli],
          },
          {
            text: 'If a project term is missing, check trust first. Untrusted files are skipped with a warning, and their contents are kept out of hook and resource context. The matcher also skips code and paths by default, so a name inside a code block is a different test from the same name in prose.',
            sources: [trust, matching],
          },
        ],
      },
    ],
    docs: [clients, trust, { path: 'docs/MCP.md', label: 'MCP reference' }],
  },
  {
    slug: 'dictionary-import-export',
    title: 'Bring your dictionary into a portable vocabulary',
    description: 'Preview a dictionary import, preserve useful aliases and export the vocabulary you need for another workflow.',
    intro: {
      text: 'Lexicon imports dictionary files into its YAML vocabulary and exports that vocabulary in other formats. It can merge aliases into existing names, so you can start with a dictionary you already maintain. Import and export are explicit operations, rather than a background synchronization service.',
      sources: [exports, cli],
    },
    sections: [
      {
        id: 'prepare',
        title: 'Start with a small, readable dictionary',
        blocks: [
          {
            text: 'For a hand-maintained list, save the following example as names.txt. The text importer accepts a canonical spelling followed by comma-separated aliases. It also accepts a canonical spelling on its own. This is useful when you know the desired name but have not observed a mishearing yet.',
            code: 'Ashlr.AI: Ashler, Ashlar\nKubernetes: cuban eats',
            sources: [exports],
          },
          {
            text: 'For an existing file, select the matching importer rather than changing the extension. Lexicon includes parsers for Wispr CSV, Superwhisper replacement JSON, macOS Text Replacement plist, espanso YAML, markdown, text, CSV and lexicon JSON or YAML. The import reference defines the accepted shapes; the file format, not the originating app name alone, determines compatibility.',
            sources: [exports, { path: 'src/core/importers/index.ts', label: 'Importer registry and detection' }],
          },
        ],
      },
      {
        id: 'preview',
        title: 'Preview, then merge the terms',
        blocks: [
          {
            text: 'After installing the CLI, run a dry run against names.txt and inspect the proposed terms. Remove --dry-run to write them. Imports merge by canonical spelling without case sensitivity and deduplicate aliases. The CLI reports new, merged and skipped terms, with reasons for skipped input.',
            code: 'lexicon import names.txt --format text --dry-run\nlexicon import names.txt --format text',
            sources: [exports, cli],
          },
          {
            text: 'Imports target your personal file unless you select --project. A project import uses the same trust rules as other CLI writes: an existing untrusted or changed project file must be reviewed first. Keep personal names in the global file and use the project file for vocabulary you intend to share.',
            sources: [exports, file, trust],
          },
        ],
      },
      {
        id: 'export',
        title: 'Choose the output for the next workflow',
        blocks: [
          {
            text: 'JSON is the backup format for lexicon fields. CSV emits alias rows, and claude-md emits a voice-lexicon table you can review for an agent rules file. The commands below write named files; --out replaces an existing destination. Run lexicon export without a format to list the available targets.',
            code: 'lexicon export json --out vocabulary.json\nlexicon export csv --out vocabulary.csv\nlexicon export claude-md --out vocabulary.md',
            sources: [exports, cli],
          },
          {
            text: 'Choose a format with its limits in mind. Alias-row exports cannot represent a term that has no alias, and JSON leaves out merged-view scope and hit counts. Some targets also omit entries that exceed their limits or collide with other entries. Read stderr or the dropped field from --json before treating an export as complete.',
            sources: [exports],
          },
        ],
      },
      {
        id: 'check',
        title: 'Check a real sentence after the transfer',
        blocks: [
          {
            text: 'Verify an imported alias with normalize --diff. This checks the local Lexicon vocabulary. Exporting a file does not install it in another tool: follow that destination’s import instructions and test there too. If you later change the Lexicon file, export again to produce an updated copy.',
            code: 'lexicon normalize --diff "ask Ashler about the cuban eats rollout"',
            sources: [exports, matching],
          },
        ],
      },
    ],
    docs: [exports, file, { path: 'docs/LIBRARY.md', label: 'Library and transcription pipelines' }],
  },
];
