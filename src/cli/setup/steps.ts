/**
 * The seven steps of `lexicon setup`, in the order the wizard runs them. Each
 * takes the shared `Ctx`, prints its own one-line result through `ctx.say`,
 * and records what it did in `ctx.summary` -- or, under `--dry-run`, what it
 * would have done in `ctx.plan`, writing nothing. Every step is idempotent.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PACKS,
  EXPORT_FORMAT_INFO,
  ProjectTrustError,
  addTerm,
  demonstrate,
  exportLexicon,
  harvestRepo,
  installPack,
  installedPacks,
  listPacks,
  loadLexicon,
  loadPack,
  readLexiconFile,
  resolvePaths,
  suggestAliases,
} from '../../core/index.js';
import type {
  ExportFormat,
  HarvestCandidate,
  PackInfo,
  Term,
  TermCategory,
} from '../../core/index.js';
import { errorMessage } from '../../util/errors.js';
import { bold, dim, renderTable, safe, safeLines, tildify } from '../io.js';
import type { IO } from '../io.js';
import { runInstall } from '../cmd-install.js';
import type { InstallOptions } from '../cmd-install.js';
import { runServeInstall } from '../cmd-serve.js';
import type { ServeDeps } from '../cmd-serve.js';
import { runInit } from '../commands.js';
import type { InstallOutcome } from '../commands.js';
import { HARVEST_LIMIT, HARVEST_MIN_COUNT, SEEDED_TERMS, SETUP_APPS, SETUP_CLIENTS } from './types.js';
import type { Ctx, SetupApp, SetupClient } from './types.js';
import {
  captureIO,
  detectClients,
  findGitRoot,
  isSetupApp,
  lastLine,
  parseClientList,
  parsePackList,
  readPackageName,
  suggestCompany,
  tryExec,
} from './detect.js';

const APP_LABELS: Record<Exclude<SetupApp, 'none'>, { label: string; where: string }> = {
  wispr: { label: 'Wispr Flow', where: 'Wispr Flow > Dictionary > Import' },
  superwhisper: { label: 'Superwhisper', where: 'Superwhisper > Settings > Replacements > Import' },
  macos: { label: 'macOS Text Replacement', where: 'System Settings > Keyboard > Text Replacements (drag the file in)' },
};

export function stepHeading(ctx: Ctx, n: number, title: string): void {
  ctx.say(bold(`${n}. ${title}`));
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Canonicals already in the global lexicon (case-insensitive), so a seed never duplicates one. */
async function globalCanonicals(ctx: Ctx): Promise<string[]> {
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  if (!ctx.exists(global)) return [];
  try {
    return (await readLexiconFile(global, 'global')).lexicon.terms.map((t) => t.canonical);
  } catch {
    return [];
  }
}

/**
 * Adds one term to the global lexicon unless a term with that canonical is
 * already there (case-insensitive): then nothing is written and the existing
 * spelling is reported, so `--person` equal to `git config user.name`, or a
 * company the user already added, never shows up twice.
 */
async function seedTerm(ctx: Ctx, term: Term): Promise<void> {
  const existing = (await globalCanonicals(ctx)).find((c) => sameName(c, term.canonical));
  if (existing !== undefined) {
    ctx.say(dim(`   already present: ${safe(existing)} (${term.category ?? 'other'})`));
    ctx.seeded.push(existing);
    return;
  }
  const result = await addTerm(term, { scope: 'global', cwd: ctx.cwd });
  const aliases = result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(no aliases)');
  ctx.say(`   ${result.created ? 'added' : 'merged'} ${bold(safe(result.term.canonical))} (${term.category ?? 'other'}): ${aliases}`);
  ctx.seeded.push(result.term.canonical);
  if (result.created) ctx.summary.termsAdded.push(result.term.canonical);
}

/** Step a: the global lexicon and the person/company seed. */
export async function stepLexicon(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 1, 'Global lexicon');
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  ctx.summary.lexiconPath = global;
  if (ctx.plan) ctx.plan.lexiconPath = global;
  const existed = ctx.exists(global);
  if (existed) {
    ctx.say(`   exists: ${safe(tildify(global, ctx.home))}`);
  } else if (ctx.plan) {
    ctx.say(`   would create ${safe(tildify(global, ctx.home))}`);
  } else {
    const captured = captureIO();
    await runInit({ cwd: ctx.cwd }, captured);
    ctx.say(`   created ${safe(tildify(global, ctx.home))}`);
  }
  if (ctx.plan) ctx.plan.lexiconExists = existed;

  const before = existed ? (await readLexiconFile(global, 'global')).lexicon.terms.length : 0;
  if (before >= SEEDED_TERMS && !ctx.opts.reseed) {
    ctx.say(dim(`   already has ${before} terms; skipping the seed (use --reseed to add more)`));
    return;
  }
  if (ctx.plan) {
    // Same defaults as the non-interactive path below, without the writes.
    const person = ctx.opts.person ?? tryExec(ctx.exec, 'git', ['config', '--global', 'user.name']);
    const company =
      ctx.opts.company ??
      suggestCompany(await readPackageName(ctx.cwd), tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin']));
    const present = await globalCanonicals(ctx);
    for (const [canonical, category] of [
      [person, 'person'],
      [company, 'brand'],
    ] as const) {
      if (!canonical) continue;
      const already = present.find((c) => sameName(c, canonical));
      if (already !== undefined || ctx.plan.wouldSeed.some((c) => sameName(c, canonical))) {
        ctx.say(dim(`   already present: ${safe(already ?? canonical)} (${category})`));
        continue;
      }
      ctx.plan.wouldSeed.push(canonical);
      const aliases = suggestAliases(canonical);
      ctx.say(`   would add ${bold(safe(canonical))} (${category}): ${aliases.length > 0 ? safe(aliases.join(', ')) : dim('(no aliases)')}`);
    }
    if (ctx.plan.wouldSeed.length === 0) ctx.say(dim('   nothing to seed (no git user.name, no company guess)'));
    return;
  }

  // Person: the git user, confirmed on a terminal.
  const gitName = ctx.opts.person ?? tryExec(ctx.exec, 'git', ['config', '--global', 'user.name']);
  let person = gitName;
  if (ctx.prompter && gitName && !ctx.opts.person) {
    person = (await ctx.prompter.confirm(`   add "${safe(gitName)}" as a person term (how you want your name spelled)?`, true))
      ? gitName
      : undefined;
  }
  if (person) {
    await seedTerm(ctx, { canonical: person, aliases: suggestAliases(person), category: 'person', source: 'user' });
  } else {
    ctx.say(dim('   no person term (git user.name is unset; add one later: lexicon add "Your Name" --category person)'));
  }

  // Company: suggested from the package scope or the git remote.
  const suggestion =
    ctx.opts.company ??
    suggestCompany(await readPackageName(ctx.cwd), tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin']));
  let company: string | undefined = ctx.opts.company ?? (ctx.prompter ? undefined : suggestion);
  let phonetic: string | undefined = ctx.opts.phonetic;
  if (ctx.prompter && !ctx.opts.company) {
    company = (
      await ctx.prompter.ask('   Your company or product name (as you want it spelled; Enter to skip)', {
        default: suggestion ?? '',
      })
    ).trim();
  }
  if (!company) {
    ctx.say(dim('   no company term (add one later: lexicon add "Your Co" --category brand)'));
    return;
  }
  const aliases = suggestAliases(company);
  if (ctx.prompter) {
    if (aliases.length > 0) ctx.say(dim(`   STT will likely write: ${safe(aliases.join(', '))}`));
    if (!phonetic) {
      phonetic = (await ctx.prompter.ask('   phonetic hint (e.g. ASH-ler, Enter for none)', { default: '' })).trim() || undefined;
    }
  }
  const term: Term = { canonical: company, aliases, category: 'brand', source: 'user' };
  if (phonetic) term.phonetic = phonetic;
  await seedTerm(ctx, term);
  ctx.company = company;

  // More terms, one at a time, on a terminal only.
  while (ctx.prompter && (await ctx.prompter.confirm('   add another term?', false))) {
    const name = (await ctx.prompter.ask('   name (as you want it spelled; Enter to stop)', { default: '' })).trim();
    if (!name) break;
    const hint = (await ctx.prompter.ask('   phonetic hint (Enter for none)', { default: '' })).trim();
    const categoryAnswer = (await ctx.prompter.ask('   category (brand|person|product|acronym|identifier|place|other)', { default: 'brand' }))
      .trim()
      .toLowerCase();
    const category = (['brand', 'person', 'product', 'acronym', 'identifier', 'place', 'other'] as TermCategory[]).find(
      (c) => c === categoryAnswer,
    );
    const extra: Term = { canonical: name, aliases: suggestAliases(name), category: category ?? 'other', source: 'user' };
    if (hint) extra.phonetic = hint;
    await seedTerm(ctx, extra);
  }
}

/**
 * Step b: the starter packs. On a terminal a checklist of the default packs
 * (all checked) followed by one yes/no per remaining pack (default no); with
 * `--packs` exactly that list; otherwise nothing, since a pack is a
 * hundred-odd terms. A pack the file already lists is reported, not re-added.
 */
export async function stepPacks(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 2, 'Starter packs');
  if (ctx.opts.packs === false) {
    ctx.say(dim('   skipped (--no-packs)'));
    return;
  }
  let available: PackInfo[];
  try {
    available = await (ctx.deps.listPacks ?? listPacks)();
  } catch (err) {
    ctx.warn(`   could not read the packs: ${safeLines(errorMessage(err))}`);
    return;
  }
  if (available.length === 0) {
    ctx.say(dim('   no packs shipped with this install'));
    return;
  }
  const byName = new Map(available.map((p) => [p.name, p]));
  const describe = (name: string): string => {
    const p = byName.get(name);
    return p ? `${name} ${dim(`(${p.terms} terms)`)}` : name;
  };
  const explicit = typeof ctx.opts.packs === 'string' ? parsePackList(ctx.opts.packs, available.map((p) => p.name)) : undefined;
  const defaults = DEFAULT_PACKS.filter((name) => byName.has(name));

  if (ctx.plan) {
    const chosen = explicit ?? [...defaults];
    ctx.plan.wouldInstallPacks = chosen;
    if (chosen.length === 0) {
      ctx.say(dim('   would install: none'));
      return;
    }
    ctx.say(`   would install: ${chosen.map(describe).join(', ')}`);
    if (explicit === undefined) ctx.say(dim('   (the defaults; pass --packs <list> to install them without a terminal)'));
    for (const name of chosen) {
      try {
        ctx.packCanonicals.push(...(await loadPack(name)).lexicon.terms.map((t) => t.canonical));
      } catch {
        // the harvest preview just loses the overlap check
      }
    }
    return;
  }

  let chosen: string[];
  if (explicit !== undefined) {
    chosen = explicit;
    if (chosen.length === 0) {
      ctx.say(dim('   skipped (--packs none)'));
      return;
    }
  } else if (ctx.prompter) {
    chosen = await ctx.prompter.choose(
      '   add starter packs to the global lexicon (Enter keeps the checked ones):',
      defaults.map((name) => ({ label: `${name}  ${dim(safe(`${byName.get(name)?.title ?? ''}, ${byName.get(name)?.terms ?? 0} terms`))}`, value: name })),
      { multi: true },
    );
    for (const p of available) {
      if (defaults.includes(p.name)) continue;
      if (await ctx.prompter.confirm(`   also add ${safe(p.name)} (${safe(p.title)}, ${p.terms} terms)?`, false)) chosen.push(p.name);
    }
    if (chosen.length === 0) {
      ctx.say(dim('   skipped; later: lexicon pack add developer'));
      return;
    }
  } else {
    ctx.say(dim(`   skipped (not requested); add --packs ${defaults.join(',')} to install the defaults, or later: lexicon pack add <name>`));
    return;
  }

  const installed = installedPacks(await loadLexicon({ cwd: ctx.cwd }));
  const install = ctx.deps.installPack ?? installPack;
  for (const name of chosen) {
    if (installed.includes(name)) {
      ctx.say(dim(`   already installed: ${name}`));
      continue;
    }
    const result = await install(name, { cwd: ctx.cwd, scope: 'global' });
    ctx.summary.packs.push({ name, added: result.added, merged: result.merged });
    ctx.say(`   installed ${bold(name)}: ${result.added} added, ${result.merged} merged`);
  }
}

/** Step c: harvest the repo into the project lexicon. */
export async function stepHarvest(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 3, 'Repo harvest');
  if (ctx.opts.harvest === false) {
    ctx.say(dim('   skipped (--no-harvest)'));
    return;
  }
  const root = findGitRoot(ctx.cwd, ctx.exists);
  if (!root) {
    ctx.say(dim('   not a git repository; run `lexicon harvest --add` inside one later'));
    return;
  }
  if (!ctx.plan && !ctx.prompter && ctx.opts.harvest !== true) {
    // No terminal to show the candidates on: a project write is only made when asked for explicitly.
    ctx.say(dim('   skipped (not requested); add --harvest to add repo names, or later: lexicon harvest --add'));
    return;
  }
  const harvest = ctx.deps.harvest ?? harvestRepo;
  let candidates: HarvestCandidate[];
  try {
    candidates = await harvest(root, { limit: HARVEST_LIMIT, minCount: HARVEST_MIN_COUNT });
  } catch (err) {
    ctx.warn(`   harvest failed: ${safeLines(errorMessage(err))}`);
    return;
  }
  // A name the global lexicon already covers (the git author seeded as the person term,
  // the company) would only show up as a duplicate in `lexicon doctor`.
  const covered = [...(await globalCanonicals(ctx)), ...ctx.seeded, ...(ctx.plan?.wouldSeed ?? []), ...ctx.packCanonicals];
  const skipped = candidates.filter((c) => covered.some((name) => sameName(name, c.canonical)));
  candidates = candidates.filter((c) => !skipped.includes(c));
  if (skipped.length > 0) ctx.say(dim(`   already in the global lexicon: ${safe(skipped.map((c) => c.canonical).join(', '))}`));
  if (candidates.length === 0) {
    ctx.say(dim(`   nothing worth adding in ${safe(tildify(root, ctx.home))}`));
    return;
  }
  if (ctx.plan) {
    ctx.plan.wouldHarvest = candidates.map((c) => c.canonical);
    ctx.say(
      `   would add ${candidates.length} name${candidates.length === 1 ? '' : 's'} to ${safe(path.join(tildify(root, ctx.home), '.lexicon.yaml'))}: ${safe(ctx.plan.wouldHarvest.join(', '))}`,
    );
    return;
  }
  if (ctx.prompter) {
    ctx.say(`   found ${candidates.length} names in ${safe(tildify(root, ctx.home))}:`);
    const rows = candidates.map((c) => [c.canonical, c.category, String(c.count), c.suggestedAliases.slice(0, 3).join(', ')]);
    ctx.say(renderTable(rows, ['canonical', 'category', 'count', 'suggested aliases']).replace(/\n$/, ''));
    if (!(await ctx.prompter.confirm(`   add them to the project lexicon (${safe(path.join(tildify(root, ctx.home), '.lexicon.yaml'))})?`, true))) {
      ctx.say(dim('   skipped; pick them one by one later with: lexicon harvest --add'));
      return;
    }
  }
  let created = 0;
  let merged = 0;
  let file: string | undefined;
  try {
    for (const c of candidates) {
      const term: Term = { canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source };
      const result = await addTerm(term, { scope: 'project', cwd: root });
      file = result.file.path;
      if (result.created) {
        created += 1;
        ctx.summary.termsAdded.push(result.term.canonical);
      } else merged += 1;
    }
  } catch (err) {
    if (err instanceof ProjectTrustError) {
      ctx.warn(`   skipped: ${safeLines(err.message)}`);
      return;
    }
    throw err;
  }
  ctx.say(`   added ${created} new term${created === 1 ? '' : 's'}, merged ${merged} in ${safe(tildify(file ?? root, ctx.home))} (trusted)`);
}

/** Step d: detect and install the agent clients. */
export async function stepClients(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 4, 'Agent clients');
  if (ctx.plan) {
    // Always detect for the plan (it is what the caller needs to ask the user), even under --clients none.
    const detected = (await detectClients({ ...ctx.deps, home: ctx.home }, ctx.cwd)).filter((c) => c.detected);
    ctx.plan.detectedClients = detected.map((c) => c.name);
    ctx.say(
      detected.length > 0
        ? `   detected: ${detected.map((c) => `${c.name} ${dim(safe(tildify(c.evidence ?? '', ctx.home)))}`).join(', ')}`
        : dim('   none detected'),
    );
    const chosen = ctx.opts.clients !== undefined ? parseClientList(ctx.opts.clients) : detected.map((c) => c.name);
    ctx.plan.wouldInstallClients = chosen;
    ctx.say(chosen.length > 0 ? `   would install into: ${chosen.join(', ')}` : dim('   would install into: none'));
    return;
  }
  let chosen: SetupClient[];
  if (ctx.opts.clients !== undefined) {
    chosen = parseClientList(ctx.opts.clients);
    if (chosen.length === 0) {
      ctx.say(dim('   skipped (--clients none)'));
      return;
    }
  } else {
    const detected = (await detectClients({ ...ctx.deps, home: ctx.home }, ctx.cwd)).filter((c) => c.detected);
    if (detected.length === 0) {
      ctx.say(dim(`   none detected; later: lexicon install <${SETUP_CLIENTS.join('|')}> --apply`));
      return;
    }
    if (ctx.prompter) {
      chosen = await ctx.prompter.choose(
        '   install the lexicon MCP server (and hooks) into:',
        detected.map((c) => ({ label: `${c.name}  ${dim(safe(tildify(c.evidence ?? '', ctx.home)))}`, value: c.name })),
        { multi: true },
      );
      if (chosen.length === 0) {
        ctx.say(dim('   skipped'));
        return;
      }
    } else {
      chosen = detected.map((c) => c.name);
    }
  }

  const install =
    ctx.deps.installClient ??
    ((client: SetupClient, opts: InstallOptions, io: IO, onWritten: (file: string, outcome: InstallOutcome) => void) =>
      runInstall(client, opts, io, {
        platform: ctx.platform,
        env: ctx.env,
        onWritten,
        ...(ctx.deps.cliDir ? { cliDir: ctx.deps.cliDir } : {}),
      }));
  for (const client of chosen) {
    const captured = captureIO();
    const opts: InstallOptions = { apply: true, cwd: ctx.cwd, ...(ctx.homeOverridden ? { home: ctx.home } : {}) };
    const written: string[] = [];
    const onWritten = (file: string, outcome: InstallOutcome): void => {
      written.push(outcome === 'unchanged' ? `${tildify(file, ctx.home)} (unchanged)` : tildify(file, ctx.home));
    };
    let code: number;
    let detail: string;
    try {
      code = await install(client, opts, captured, onWritten);
      detail = written.length > 0 ? written.join(', ') : lastLine(captured.out) || lastLine(captured.err);
    } catch (err) {
      code = 1;
      detail = errorMessage(err);
    }
    if (code === 0) {
      ctx.summary.clients.push({ name: client, status: 'installed', detail });
      ctx.say(`   ${client}: installed ${dim(safe(detail))}`);
    } else {
      const failure = lastLine(captured.err) || detail || `exit ${code}`;
      ctx.summary.clients.push({ name: client, status: 'failed', detail: failure });
      ctx.warn(`   ${client}: failed ${safe(failure)}`);
      ctx.warn(`   (retry with: lexicon install ${client} --apply)`);
    }
  }
}

/** Step e: the local API as a login service. */
export async function stepServe(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 5, 'Local API (lexicon serve)');
  if (ctx.opts.serve === false) {
    ctx.say(dim('   skipped (--no-serve)'));
    return;
  }
  const supported = ctx.platform === 'darwin' || ctx.platform === 'linux';
  if (!supported) {
    ctx.say(dim(`   not automated on ${ctx.platform}; see: lexicon serve --install`));
    return;
  }
  if (ctx.prompter && ctx.opts.serve !== true) {
    const ok = await ctx.prompter.confirm(
      '   install the local API (browser extension, Claude Desktop, menu bar app) as a login service?',
      true,
    );
    if (!ok) {
      ctx.say(dim('   skipped; later: lexicon serve --install'));
      return;
    }
  } else if (ctx.opts.serve !== true) {
    // No terminal to ask on: a login service is only created when asked for explicitly.
    ctx.say(dim('   skipped (not requested); add --serve to install it, or later: lexicon serve --install'));
    return;
  }
  if (ctx.plan) {
    ctx.plan.wouldInstallServe = true;
    ctx.say('   would install the login service (lexicon serve --install)');
    return;
  }
  const install = ctx.deps.installServe ?? runServeInstall;
  const serveDeps: ServeDeps = { platform: ctx.platform, env: ctx.env };
  if (ctx.homeOverridden) serveDeps.home = ctx.home;
  // The MCP server passes the package's dist/cli (the bundle runs from plugin/, where
  // "next to this module" would be plugin/index.js); runServeInstall resolves the path
  // otherwise and refuses one that does not exist, so a broken plist is never written.
  if (ctx.deps.cliDir) serveDeps.cliPath = path.join(ctx.deps.cliDir, 'index.js');
  const captured = captureIO();
  let code: number;
  try {
    code = await install({ cwd: ctx.cwd }, captured, serveDeps);
  } catch (err) {
    code = 1;
    captured.err += `${errorMessage(err)}\n`;
  }
  if (code === 0) {
    ctx.summary.serve = 'installed';
    ctx.say(`   installed ${dim(safe(lastLine(captured.out)))}`);
  } else {
    ctx.summary.serve = 'failed';
    ctx.warn(`   failed ${safe(lastLine(captured.err) || lastLine(captured.out))}`);
    ctx.warn('   (retry with: lexicon serve --install)');
  }
}

/** Step f: export for the dictation app. */
export async function stepExport(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 6, 'Dictation app');
  let app: SetupApp | undefined;
  if (ctx.opts.app !== undefined) {
    const value = ctx.opts.app.trim().toLowerCase();
    if (!isSetupApp(value)) throw new Error(`unknown app "${ctx.opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
    app = value;
  } else if (ctx.prompter) {
    const choices = [
      ...(Object.keys(APP_LABELS) as Exclude<SetupApp, 'none'>[]).map((k) => ({ label: APP_LABELS[k].label, value: k as SetupApp })),
      { label: 'none / something else', value: 'none' as SetupApp },
    ];
    [app] = await ctx.prompter.choose('   which dictation app do you use?', choices);
  } else {
    app = 'none';
  }
  if (!app || app === 'none') {
    ctx.say(dim('   skipped; later: lexicon export wispr|superwhisper|macos --out <file>'));
    return;
  }
  const format: ExportFormat = app;
  const desktop = path.join(ctx.home, 'Desktop');
  const dir = ctx.opts.exportDir ?? (ctx.exists(desktop) ? desktop : path.dirname(ctx.summary.lexiconPath));
  const file = path.join(dir, `lexicon-${format}.${EXPORT_FORMAT_INFO[format].ext}`);
  if (ctx.plan) {
    ctx.plan.wouldExport.push({ format, path: file });
    ctx.say(`   would write ${safe(tildify(file, ctx.home))} for ${APP_LABELS[app].label}`);
    return;
  }
  const loaded = await loadLexicon({ cwd: ctx.cwd });
  const text = exportLexicon(loaded.merged, format);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  ctx.summary.exports.push({ format, path: file });
  ctx.say(`   wrote ${safe(tildify(file, ctx.home))} (${loaded.merged.terms.length} terms)`);
  ctx.say(`   import it in ${APP_LABELS[app].where}`);
}

/**
 * Step g: prove it works, right now, on this machine.
 *
 * Every step before this one reports a file it wrote, which is not the same
 * thing as the product working. This one takes the terms the wizard just
 * seeded, writes the sentence speech-to-text would have produced for them,
 * runs the real normalizer over it and prints the before and the after. It is
 * the only step whose output a stranger can evaluate without trusting us.
 *
 * It never ends in "no changes": when the user's own lexicon cannot
 * demonstrate anything yet -- `--yes` seeds at most a person and a company,
 * and a company with no recorded mishearings cannot fire -- `demonstrate()`
 * falls back to the built-in example terms, and the step says so.
 */
export async function stepDemo(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 7, 'Does it work?');
  let merged;
  try {
    merged = (await loadLexicon({ cwd: ctx.cwd })).merged;
  } catch {
    merged = { version: 1 as const, terms: [] };
  }
  // The person and company from step 1 first: a stranger should see their own
  // name corrected, not a term that arrived with a starter pack.
  const demo = demonstrate(merged, ctx.seeded);
  const summary = demo.result.replacements
    .map((r) => `"${safe(r.original)}" -> "${safe(r.replacement)}"`)
    .join(', ');
  ctx.say(`   you dictate:  ${safe(demo.heard)}`);
  ctx.say(`   ${bold('your agent sees')}: ${bold(safe(demo.corrected))}`);
  if (summary) ctx.say(dim(`   fixed: ${summary}`));
  if (demo.usedExample) {
    ctx.say(dim('   (that used the built-in example terms: your lexicon has no misspellings recorded yet)'));
    ctx.say(dim('   add one now: lexicon add "Your Co" --suggest'));
  }
  const record = { heard: demo.heard, corrected: demo.corrected, terms: demo.terms, usedExample: demo.usedExample };
  if (ctx.plan) ctx.plan.demo = record;
  else ctx.summary.demo = record;
}

/** Step h (dry run): the plan card. */
