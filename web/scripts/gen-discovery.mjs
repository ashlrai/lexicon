#!/usr/bin/env node
/**
 * Writes `web/lib/generated/discovery.json`: the repository facts the site's
 * machine-readable endpoints are built from.
 *
 * Why a build step rather than `fs` reads in a route handler:
 *
 *   `vercel --cwd web` uploads `web/` alone; `../README.md`, `../docs` and
 *   `../server.json` do not exist in that build. A route that reads them would
 *   serve a 500 in production while working locally, which is the worst kind of
 *   drift. A generated JSON module is imported, so it is bundled, so what the
 *   build saw is what the endpoint serves.
 *
 *   docsIndex  <- every docs/*.md file: its first `# ` heading as the title,
 *                 its first prose paragraph as the blurb, and its `## ` section
 *                 headings. This is what makes /llms.txt and /llms-full.txt
 *                 "generated from the docs headings": renaming a doc's H1 here
 *                 changes what the endpoints say, automatically.
 *   readme     <- the README's `## ` section headings, with the GitHub anchor
 *                 each one produces, so llms-full.txt can map the repo README.
 *   serverJson <- the repository's MCP registry manifest, verbatim, re-served
 *                 at /server.json and /.well-known/mcp/server.json.
 *   agentsMd   <- docs/AGENTS.md, the install-and-verify doc written for agents,
 *                 re-served at /AGENTS.md.
 *
 * Like the sibling scripts this one falls back to the previously generated
 * file when the repository sources are absent (a Vercel upload), and refuses
 * to run when neither exists rather than emitting a hollow index.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const outdir = resolve(web, 'lib/generated');
const outfile = resolve(outdir, 'discovery.json');

const readmePath = resolve(repo, 'README.md');
const docsDir = resolve(repo, 'docs');
const serverJsonPath = resolve(repo, 'server.json');
const agentsMdPath = resolve(docsDir, 'AGENTS.md');

const sourcesPresent =
  existsSync(readmePath) && existsSync(docsDir) && existsSync(serverJsonPath);

if (!sourcesPresent) {
  if (existsSync(outfile)) {
    process.stdout.write(
      'lib/generated: repository sources absent, keeping the prebuilt discovery.json\n',
    );
    process.exit(0);
  }
  process.stderr.write(
    'Neither ../README.md + ../docs + ../server.json nor a prebuilt lib/generated/discovery.json ' +
      'is present. Run this script from inside the Lexicon repository before building the site.\n',
  );
  process.exit(1);
}

/** The first `# ` heading, else the file name. */
function titleOf(markdown, fallback) {
  const m = /(^|\n)#\s+(.+)/.exec(markdown);
  return m ? m[2].trim() : fallback;
}

/**
 * The first paragraph of prose: the first run of lines that is not a heading,
 * markup, badge, table, list or code fence. That is where these docs put their
 * summary, so it is the honest blurb for a link index.
 */
function blurbOf(markdown) {
  const lines = markdown.split(/\r?\n/);
  const para = [];
  let inFence = false;
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const isProse =
      t !== '' &&
      !t.startsWith('#') &&
      !t.startsWith('<') &&
      !t.startsWith('|') &&
      !t.startsWith('!') &&
      !t.startsWith('-') &&
      !t.startsWith('*') &&
      !t.startsWith('>') &&
      !/^\[!\[/.test(t) &&
      !/^\[\S.*\]\(\S+\)$/.test(t);
    if (isProse) {
      para.push(t);
      started = true;
    } else if (started) {
      break;
    }
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s\S*$/, '')}...` : text;
}

/** `## ` and `### ` headings, in order, minus markdown noise. */
function sectionsOf(markdown) {
  const out = [];
  for (const m of markdown.matchAll(/(^|\n)(##|###)\s+(.+)/g)) {
    const text = m[3].replace(/\s*#+$/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

/** The anchor GitHub gives a heading: lowercase, punctuation out, spaces to dashes. */
function anchorOf(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const docs = readdirSync(docsDir)
  .filter((f) => f.endsWith('.md'))
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  .map((file) => {
    const text = readFileSync(resolve(docsDir, file), 'utf8');
    return {
      file: `docs/${file}`,
      title: titleOf(text, file),
      blurb: blurbOf(text),
      sections: sectionsOf(text),
    };
  });

const readme = readFileSync(readmePath, 'utf8');
const readmeSections = [];
for (const m of readme.matchAll(/(^|\n)##\s+(.+)/g)) {
  const heading = m[2].replace(/\s*#+$/, '').trim();
  if (heading) readmeSections.push({ heading, anchor: anchorOf(heading) });
}

const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));
const agentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : null;

const discovery = {
  generatedBy: 'web/scripts/gen-discovery.mjs; do not edit by hand',
  docs,
  readme: { file: 'README.md', title: titleOf(readme, 'Lexicon'), sections: readmeSections },
  serverJson,
  agentsMd,
};

mkdirSync(outdir, { recursive: true });
writeFileSync(outfile, JSON.stringify(discovery, null, 2) + '\n');
process.stdout.write(
  `lib/generated/discovery.json   ${docs.length} docs, ` +
    `${readmeSections.length} README sections, server.json v${serverJson.version ?? '?'}${agentsMd ? ', AGENTS.md' : ''}\n`,
);
