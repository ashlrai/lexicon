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
  addTerms,
  demonstrate,
  exportLexiconWithNotes,
  harvestRepo,
  installPack,
  installedPacks,
  listPacks,
  loadLexicon,
  loadPack,
  projectWriteTrusted,
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
import { writeFileAtomic } from '../../util/atomic.js';
import { bold, dim, plural, renderTable, safe, safeLines, safeMessage, safePath, shownCommand, tildify } from '../io.js';
import type { IO } from '../io.js';
import { runInstall } from '../cmd-install.js';
import type { InstallOptions } from '../cmd-install.js';
import { runServeInstall, serveInstallBlocker } from '../cmd-serve.js';
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
  setupHintProblem,
  setupNameProblem,
  suggestCompany,
  tryExec,
} from './detect.js';

const APP_LABELS: Record<Exclude<SetupApp, 'none'>, { label: string; where: string }> = {
  wispr: { label: 'Wispr Flow', where: 'Wispr Flow > Dictionary > Import' },
  superwhisper: { label: 'Superwhisper', where: 'Superwhisper > Settings > Replacements > Import' },
  macos: { label: 'macOS Text Replacement', where: 'System Settings > Keyboard > Text Replacements (drag the file in)' },
};

/**
 * The dictation apps offered in step 6, in order. The first one is what
 * pressing Enter picks, so a dry run reads this list too rather than guessing
 * at what the prompt would have done.
 */
function appChoices(): { label: string; value: SetupApp }[] {
  return [
    ...(Object.keys(APP_LABELS) as Exclude<SetupApp, 'none'>[]).map((k) => ({ label: APP_LABELS[k].label, value: k as SetupApp })),
    { label: 'none / something else', value: 'none' as SetupApp },
  ];
}

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

/**
 * The name the user commits under. `--global` first, then the effective value
 * for this directory (repo-local config, the system file, an `includeIf`),
 * then the author/committer variables git itself honours. Only reading
 * `--global` left `setup --yes` seeding nothing for anyone whose name lives in
 * one of the others, which is common on a machine set up per repository.
 */
function gitUserName(ctx: Ctx): string | undefined {
  return (
    tryExec(ctx.exec, 'git', ['config', '--global', 'user.name']) ??
    tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'config', 'user.name']) ??
    (ctx.env.GIT_AUTHOR_NAME?.trim() || ctx.env.GIT_COMMITTER_NAME?.trim() || undefined)
  );
}

/**
 * The git user name to offer as the person term, or undefined. A name the
 * write would refuse (longer than a term may be, or with control characters)
 * is skipped with a note instead of failing setup after the lexicon was
 * created; the note says how to pass the name by hand.
 */
function gitPersonGuess(ctx: Ctx): { name?: string; skipped: boolean } {
  const name = gitUserName(ctx);
  if (name === undefined) return { skipped: false };
  const problem = setupNameProblem(name);
  if (problem === undefined) return { name, skipped: false };
  ctx.say(dim(`   skipped the person term: git user.name ${problem}; pass --person "Your Name", or later: lexicon add "Your Name" --category person`));
  return { skipped: true };
}

/**
 * Asks until the answer is blank (returned as '') or `problem` finds nothing
 * wrong with it, so a name or hint the write would refuse is asked again
 * before anything is written instead of failing setup after the lexicon was
 * created. After a refused answer the default is dropped, so Enter skips.
 */
async function askChecked(
  ctx: Ctx,
  question: string,
  def: string,
  what: string,
  problem: (value: string) => string | undefined,
): Promise<string> {
  const prompter = ctx.prompter!;
  let fallback = def;
  for (;;) {
    const answer = (await prompter.ask(question, { default: fallback })).trim();
    if (answer === '') return '';
    const wrong = problem(answer);
    if (wrong === undefined) return answer;
    ctx.say(`   the ${what} ${wrong}; type it again (Enter to skip)`);
    fallback = '';
  }
}

/** Step a: the global lexicon and the person/company seed. */
export async function stepLexicon(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 1, 'Global lexicon');
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  ctx.summary.lexiconPath = global;
  if (ctx.plan) ctx.plan.lexiconPath = global;
  const existed = ctx.exists(global);
  if (existed) {
    ctx.say(`   exists: ${safePath(tildify(global, ctx.home))}`);
  } else if (ctx.plan) {
    ctx.say(`   would create ${safePath(tildify(global, ctx.home))}`);
  } else {
    const captured = captureIO();
    await runInit({ cwd: ctx.cwd }, captured);
    ctx.say(`   created ${safePath(tildify(global, ctx.home))}`);
  }
  if (ctx.plan) ctx.plan.lexiconExists = existed;

  const before = existed ? (await readLexiconFile(global, 'global')).lexicon.terms.length : 0;
  // An already seeded lexicon skips the guessed defaults (git user.name, the
  // package scope), but a name passed explicitly (--person, --company, or
  // setup_lexicon's company/person) is always seeded: the user just typed it.
  const gated = before >= SEEDED_TERMS && !ctx.opts.reseed;
  // --phonetic is the company term's hint: with no company term it went nowhere, without a word.
  const phoneticUnused = (): void => {
    if (ctx.opts.phonetic !== undefined) ctx.say(dim('   --phonetic was not used: it is the hint for the company term, and no company term was seeded (pass --company "Your Co" with it)'));
  };
  if (gated && !ctx.opts.person && !ctx.opts.company) {
    ctx.say(dim(`   already has ${before} terms; skipping the seed (use --reseed to add more)`));
    phoneticUnused();
    return;
  }
  if (gated) ctx.say(dim(`   already has ${before} terms; seeding only the names you passed`));
  // A guess the write would refuse (an over-long package scope or remote
  // org) is skipped with a note, as gitPersonGuess does for the person,
  // instead of failing setup after the person term was seeded.
  let companySkipped = false;
  const guessCompany = async (): Promise<string | undefined> => {
    if (gated) return undefined;
    const name = suggestCompany(await readPackageName(ctx.cwd), tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin']));
    if (name === undefined) return undefined;
    const problem = setupNameProblem(name);
    if (problem === undefined) return name;
    // On a terminal the company prompt comes next, so name that, not a flag;
    // skipping it there still gets the "add one later" note.
    const prompted = ctx.prompter !== undefined && !ctx.plan;
    companySkipped = !prompted;
    ctx.say(
      dim(
        prompted
          ? `   not suggesting the guessed company name: it ${problem}; type the name you want at the prompt below (Enter to skip)`
          : `   skipped the company term: the guessed name ${problem}; pass --company "Your Co", or later: lexicon add "Your Co" --category brand`,
      ),
    );
    return undefined;
  };
  if (ctx.plan) {
    // Same defaults as the non-interactive path below, without the writes.
    const person = ctx.opts.person ?? (gated ? undefined : gitPersonGuess(ctx).name);
    const company = ctx.opts.company ?? (await guessCompany());
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
      ctx.plannedSeed.push({ canonical, aliases, category, source: 'user' });
      ctx.say(`   would add ${bold(safe(canonical))} (${category}): ${aliases.length > 0 ? safe(aliases.join(', ')) : dim('(no aliases)')}`);
    }
    if (ctx.plan.wouldSeed.length === 0) {
      ctx.say(dim('   nothing to seed (no git user.name, no company guess); pass --person "Your Name" and --company "Your Co"'));
    }
    return;
  }

  // Person: the git user, confirmed on a terminal.
  const guess = ctx.opts.person !== undefined || gated ? { skipped: false } : gitPersonGuess(ctx);
  const gitName = ctx.opts.person ?? guess.name;
  let person = gitName;
  if (ctx.prompter && gitName && !ctx.opts.person) {
    person = (await ctx.prompter.confirm(`   add "${safe(gitName)}" as a person term (how you want your name spelled)?`, true))
      ? gitName
      : undefined;
  }
  if (person) {
    await seedTerm(ctx, { canonical: person, aliases: suggestAliases(person), category: 'person', source: 'user' });
  } else if (!gated && !guess.skipped) {
    ctx.say(dim('   no person term (git user.name is unset; pass --person "Your Name", or later: lexicon add "Your Name" --category person)'));
  }

  // Company: suggested from the package scope or the git remote.
  const suggestion = ctx.opts.company ?? (await guessCompany());
  let company: string | undefined = ctx.opts.company ?? (ctx.prompter ? undefined : suggestion);
  let phonetic: string | undefined = ctx.opts.phonetic;
  if (ctx.prompter && !ctx.opts.company && !gated) {
    company = await askChecked(
      ctx,
      '   Your company or product name (as you want it spelled; Enter to skip)',
      suggestion ?? '',
      'name',
      setupNameProblem,
    );
  }
  if (!company) {
    if (!gated && !companySkipped) ctx.say(dim('   no company term (add one later: lexicon add "Your Co" --category brand)'));
    phoneticUnused();
    return;
  }
  const aliases = suggestAliases(company);
  if (ctx.prompter) {
    if (aliases.length > 0) ctx.say(dim(`   STT will likely write: ${safe(aliases.join(', '))}`));
    if (!phonetic) {
      phonetic = (await askChecked(ctx, '   phonetic hint (e.g. ASH-ler, Enter for none)', '', 'hint', setupHintProblem)) || undefined;
    }
  }
  const term: Term = { canonical: company, aliases, category: 'brand', source: 'user' };
  if (phonetic) term.phonetic = phonetic;
  await seedTerm(ctx, term);
  ctx.company = company;

  // More terms, one at a time, on a terminal only.
  while (ctx.prompter && !gated && (await ctx.prompter.confirm('   add another term?', false))) {
    const name = await askChecked(ctx, '   name (as you want it spelled; Enter to stop)', '', 'name', setupNameProblem);
    if (!name) break;
    const hint = await askChecked(ctx, '   phonetic hint (Enter for none)', '', 'hint', setupHintProblem);
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
    return p ? `${name} ${dim(`(${plural(p.terms, 'term')})`)}` : name;
  };
  const explicit = typeof ctx.opts.packs === 'string' ? parsePackList(ctx.opts.packs, available.map((p) => p.name)) : undefined;
  // A rerun (or setup_lexicon after `pack add`) must not offer what is already
  // there: the agent relays the plan, and "install developer?" for a pack the
  // user has is noise at best and a confusing second install at worst.
  let installed: string[] = [];
  try {
    // installedPacks reads the global file and a trusted project file only,
    // so an untrusted one need not be parsed.
    installed = installedPacks(await loadLexicon({ cwd: ctx.cwd, parseSkipped: false }));
  } catch {
    // an unreadable lexicon is reported by the steps that write it
  }
  const defaults = DEFAULT_PACKS.filter((name) => byName.has(name) && !installed.includes(name));
  const offered = (names: readonly string[]): string[] => names.filter((name) => !installed.includes(name));
  if (installed.length > 0) ctx.say(dim(`   already installed: ${installed.join(', ')}`));

  if (ctx.plan) {
    const chosen = explicit !== undefined ? offered(explicit) : [...defaults];
    ctx.plan.wouldInstallPacks = chosen;
    ctx.plan.packsOnOffer = [...chosen];
    if (installed.length > 0) ctx.plan.alreadyInstalledPacks = [...installed];
    const asks = explicit === undefined && ctx.plan.interactive;
    // What the same call installs: an explicit list, or the checklist's
    // defaults when Enter is pressed; with neither (--yes, no terminal, MCP
    // without packs) nothing, which is what the text below says.
    ctx.plan.packsToInstall = explicit !== undefined || asks ? [...chosen] : [];
    if (asks) ctx.plan.wouldAsk.push('packs');
    if (chosen.length === 0) {
      ctx.say(dim('   would install: none'));
      return;
    }
    if (asks) {
      ctx.say(`   would ask, with these checked: ${chosen.map(describe).join(', ')}`);
    } else if (explicit === undefined) {
      ctx.say(dim(`   would install: none (pass --packs ${chosen.join(',')} to install the defaults)`));
    } else {
      ctx.say(`   would install: ${chosen.map(describe).join(', ')}`);
    }
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
    chosen = defaults.length === 0 ? [] : await ctx.prompter.choose(
      '   add starter packs to the global lexicon (Enter keeps the checked ones):',
      defaults.map((name) => ({ label: `${name}  ${dim(safe(`${byName.get(name)?.title ?? ''}, ${plural(byName.get(name)?.terms ?? 0, 'term')}`))}`, value: name })),
      { multi: true },
    );
    for (const p of available) {
      if (defaults.includes(p.name) || installed.includes(p.name)) continue;
      if (await ctx.prompter.confirm(`   also add ${safe(p.name)} (${safe(p.title)}, ${plural(p.terms, 'term')})?`, false)) chosen.push(p.name);
    }
    if (chosen.length === 0) {
      ctx.say(dim('   skipped; later: lexicon pack add developer'));
      return;
    }
  } else {
    ctx.say(dim(`   skipped (not requested); add --packs ${defaults.join(',')} to install the defaults, or later: lexicon pack add <name>`));
    return;
  }

  const install = ctx.deps.installPack ?? installPack;
  for (const name of chosen) {
    // Named in the "already installed" line above.
    if (installed.includes(name)) continue;
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
    ctx.say(dim(`   nothing worth adding in ${safePath(tildify(root, ctx.home))}`));
    return;
  }
  if (ctx.plan) {
    ctx.plan.wouldHarvest = candidates.map((c) => c.canonical);
    const file = safePath(path.join(tildify(root, ctx.home), '.lexicon.yaml'));
    const found = `${candidates.length} name${candidates.length === 1 ? '' : 's'} in ${safePath(tildify(root, ctx.home))}: ${safe(ctx.plan.wouldHarvest.join(', '))}`;
    if (ctx.opts.harvest === true) {
      ctx.say(`   would add to ${file}: ${found}`);
    } else if (ctx.plan.interactive) {
      ctx.plan.wouldAsk.push('harvest');
      ctx.say(`   would ask (default no) whether to add ${found}`);
    } else {
      ctx.say(`   would not add anything; --harvest would add ${found}`);
    }
    return;
  }
  if (ctx.prompter) {
    ctx.say(`   found ${plural(candidates.length, 'name')} in ${safePath(tildify(root, ctx.home))}:`);
    const rows = candidates.map((c) => [c.canonical, c.category, String(c.count), c.suggestedAliases.slice(0, 3).join(', ')]);
    ctx.say(renderTable(rows, ['canonical', 'category', 'count', 'suggested aliases']).replace(/\n$/, ''));
    // Default no. This is a write inside the user's repository plus a trust
    // decision, proposed to someone ninety seconds into their first run who
    // cannot yet judge the list. Saying no costs one command later; saying yes
    // by reflex puts terms they have not read in front of everything they
    // dictate in this repo.
    if (!(await ctx.prompter.confirm(`   add them to the project lexicon (${safePath(path.join(tildify(root, ctx.home), '.lexicon.yaml'))})?`, false))) {
      ctx.say(dim('   skipped; add them later with: lexicon harvest --add, or one by one with: lexicon harvest --interactive'));
      return;
    }
  }
  let created = 0;
  let merged = 0;
  let file: string | undefined;
  // A harvestUntrusted run (MCP) follows the rule every MCP write does: a file
  // the user already trusted takes the names and keeps its pin refreshed; a
  // new, untrusted or changed one is written unpinned.
  const leaveUntrusted = ctx.opts.harvestUntrusted === true && !(await projectWriteTrusted({ cwd: root }));
  try {
    // One read and one write for the list, as `lexicon harvest --add` does:
    // one addTerm per name re-parsed the growing file on every write.
    const terms: Term[] = candidates.map((c) => ({ canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source }));
    const batch = await addTerms(terms, { scope: 'project', cwd: root, ...(leaveUntrusted ? { leaveUntrusted: true } : {}) });
    file = batch.file.path;
    for (const result of batch.results) {
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
  if (leaveUntrusted && file !== undefined) {
    ctx.summary.untrustedProject = file;
    ctx.say(`   added ${created} new term${created === 1 ? '' : 's'}, merged ${merged} in ${safePath(tildify(file, ctx.home))} (not trusted: review it and run lexicon trust)`);
    return;
  }
  ctx.say(`   added ${created} new term${created === 1 ? '' : 's'}, merged ${merged} in ${safePath(tildify(file ?? root, ctx.home))} (trusted)`);
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
        ? `   detected: ${detected.map((c) => `${c.name} ${dim(safePath(tildify(c.evidence ?? '', ctx.home)))}`).join(', ')}`
        : dim('   none detected'),
    );
    const chosen = ctx.opts.clients !== undefined ? parseClientList(ctx.opts.clients) : detected.map((c) => c.name);
    ctx.plan.wouldInstallClients = chosen;
    const asks = ctx.opts.clients === undefined && ctx.plan.interactive && detected.length > 0;
    if (asks) ctx.plan.wouldAsk.push('clients');
    if (chosen.length === 0) ctx.say(dim('   would install into: none'));
    else ctx.say(`   would ${asks ? 'ask, with these checked' : 'install into'}: ${chosen.join(', ')}`);
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
        detected.map((c) => ({ label: `${c.name}  ${dim(safePath(tildify(c.evidence ?? '', ctx.home)))}`, value: c.name })),
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
      ctx.say(`   ${client}: installed ${dim(safeMessage(detail))}`);
    } else {
      const failure = lastLine(captured.err) || detail || `exit ${code}`;
      ctx.summary.clients.push({ name: client, status: 'failed', detail: failure });
      ctx.warn(`   ${client}: failed ${safeMessage(failure)}`);
      ctx.warn(ctx.opts.forAgent ? `   (retry with: install_client with client: "${client}" and apply: true)` : `   (retry with: lexicon install ${client} --apply)`);
    }
  }
}

/** What the login service installer is called with. */
function serveDepsFor(ctx: Ctx): ServeDeps {
  const serveDeps: ServeDeps = { platform: ctx.platform, env: ctx.env };
  if (ctx.homeOverridden) serveDeps.home = ctx.home;
  // The MCP server passes the package's dist/cli (the bundle runs from plugin/, where
  // "next to this module" would be plugin/index.js); runServeInstall resolves the path
  // otherwise and refuses one that does not exist, so a broken plist is never written.
  if (ctx.deps.cliDir) serveDeps.cliPath = path.join(ctx.deps.cliDir, 'index.js');
  return serveDeps;
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
  if (ctx.plan) {
    // A real run would refuse a service pointing into an npx or plugin cache
    // (or at a missing file): say so, with the fix, instead of "would install".
    if (ctx.opts.serve === true || ctx.plan.interactive) {
      const blocked = await (ctx.deps.serveBlocker ?? serveInstallBlocker)(serveDepsFor(ctx));
      if (blocked) {
        ctx.plan.serveBlocked = blocked;
        ctx.say(`   would not install the login service: ${safeMessage(blocked)}`);
        return;
      }
    }
    // A real run asks on a terminal (default yes) and skips it otherwise, so
    // the plan must not report "skipped" to someone who would be asked.
    if (ctx.opts.serve === true) {
      ctx.plan.wouldInstallServe = true;
      ctx.say('   would install the login service (lexicon serve --install)');
    } else if (ctx.plan.interactive) {
      ctx.plan.wouldAsk.push('serve');
      ctx.plan.wouldInstallServe = true;
      ctx.say('   would ask (default yes) to install the local API as a login service');
    } else {
      ctx.say(dim('   would skip (not requested); --serve installs it'));
    }
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
  const install = ctx.deps.installServe ?? runServeInstall;
  const serveDeps = serveDepsFor(ctx);
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
    ctx.say(`   installed ${dim(safeMessage(lastLine(captured.out)))}`);
  } else {
    ctx.summary.serve = 'failed';
    ctx.warn(`   failed ${safeMessage(lastLine(captured.err) || lastLine(captured.out))}`);
    ctx.warn(ctx.opts.forAgent ? '   (retry with: setup_lexicon with apply: true and serve: true)' : '   (retry with: lexicon serve --install)');
  }
}

/** The file's text, or undefined when there is none to read. */
async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The first `lexicon-<format>-<n>.<ext>` (n from 2) that does not exist or
 * already holds `text`, so a rerun with the same terms reuses its file rather
 * than adding another; undefined past 99 of them.
 */
async function freeExportPath(dir: string, format: string, ext: string, text: string | undefined): Promise<string | undefined> {
  for (let n = 2; n < 100; n += 1) {
    const candidate = path.join(dir, `lexicon-${format}-${n}.${ext}`);
    const current = await readIfThere(candidate);
    if (current === undefined || (text !== undefined && current === text)) return candidate;
  }
  return undefined;
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
    [app] = await ctx.prompter.choose('   which dictation app do you use?', appChoices());
  } else if (ctx.plan?.interactive) {
    // A real run on this terminal would ask; pressing Enter takes the first
    // choice and writes that file, which is the thing a dry run must disclose.
    ctx.plan.wouldAsk.push('export');
    [app] = appChoices().map((c) => c.value);
  } else {
    app = 'none';
  }
  if (!app || app === 'none') {
    ctx.say(
      ctx.plan
        ? dim('   would skip; --app wispr|superwhisper|macos writes an export')
        : dim('   skipped; later: lexicon export wispr|superwhisper|macos --out <file>'),
    );
    return;
  }
  const format: ExportFormat = app;
  const desktop = path.join(ctx.home, 'Desktop');
  const dir = ctx.opts.exportDir ?? (ctx.exists(desktop) ? desktop : path.dirname(ctx.summary.lexiconPath));
  const ext = EXPORT_FORMAT_INFO[format].ext;
  const file = path.join(dir, `lexicon-${format}.${ext}`);
  const existing = await readIfThere(file);
  if (ctx.plan) {
    // A rerun keeps a file that differs from the export (see below); the plan
    // cannot compare it with an export of terms it has not written yet.
    const alt = existing !== undefined ? await freeExportPath(dir, format, ext, undefined) : undefined;
    ctx.plan.wouldExport.push({ format, path: alt ?? file });
    const shown = safePath(tildify(file, ctx.home));
    const keep =
      alt === undefined
        ? ''
        : ctx.plan.interactive
          ? `; ${shown} exists, so it would ask before replacing it (default no: writes ${safePath(tildify(alt, ctx.home))})`
          : `; ${shown} exists, so it would be kept and ${safePath(tildify(alt, ctx.home))} written, unless it holds this same export`;
    ctx.say(
      ctx.plan.wouldAsk.includes('export')
        ? `   would ask which app; ${APP_LABELS[app].label} (the default) writes ${shown}${keep}`
        : `   would write ${shown} for ${APP_LABELS[app].label}${keep}`,
    );
    return;
  }
  // The export is of the merged terms only: an untrusted project file is never parsed.
  const loaded = await loadLexicon({ cwd: ctx.cwd, parseSkipped: false });
  const exported = exportLexiconWithNotes(loaded.merged, format);
  // A rerun wrote over the file without asking, so edits made to it (a row
  // fixed by hand before importing) were lost. A file that differs from this
  // export is replaced only on a yes at the terminal; otherwise it is kept and
  // the export goes to the next free `lexicon-<app>-<n>.<ext>`.
  let target = file;
  if (existing !== undefined && existing !== exported.text) {
    const shown = safePath(tildify(file, ctx.home));
    const replace = ctx.prompter ? await ctx.prompter.confirm(`   ${shown} exists and differs from this export (edited by hand?); replace it?`, false) : false;
    if (!replace) {
      ctx.say(`   kept ${shown} as it was: it differs from this export${ctx.prompter ? '' : ' (no terminal to ask on)'}`);
      const free = await freeExportPath(dir, format, ext, exported.text);
      if (free === undefined) {
        ctx.say(dim(`   nothing written: lexicon-${format}-2 to -99 are taken; later: lexicon export ${format} --out <file>`));
        return;
      }
      target = free;
    }
  }
  // A temp file and a rename (writeFileAtomic makes the directory too), as `lexicon export --out` writes.
  await writeFileAtomic(target, exported.text);
  ctx.summary.exports.push({ format, path: target });
  // Every app format writes one row per alias, so the rows are what the app imports.
  const count = exported.rows !== undefined ? plural(exported.rows, 'row') : plural(loaded.merged.terms.length, 'term');
  ctx.say(`   wrote ${safePath(tildify(target, ctx.home))} (${count})`);
  // What the format left out (a pair a spreadsheet would run as a formula, a
  // shared shortcut) was dropped without a word, as `lexicon export` says it.
  for (const note of exported.notes) ctx.warn(`   ${safeLines(note)}`);
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
    merged = (await loadLexicon({ cwd: ctx.cwd, parseSkipped: false })).merged;
  } catch {
    merged = { version: 1 as const, terms: [] };
  }
  // A dry run wrote nothing in step 1, so add what it would have seeded: the
  // plan must show the correction the real run shows ("Ashler" -> the company
  // it seeds), not the built-in example with a different spelling.
  if (ctx.plan && ctx.plannedSeed.length > 0) {
    merged = { ...merged, terms: [...ctx.plannedSeed, ...merged.terms] };
  }
  // The person and company from step 1 first: a stranger should see their own
  // name corrected, not a term that arrived with a starter pack.
  const demo = demonstrate(merged, ctx.plan ? ctx.plan.wouldSeed : ctx.seeded);
  const summary = demo.result.replacements
    .map((r) => `"${safe(r.original)}" -> "${safe(r.replacement)}"`)
    .join(', ');
  ctx.say(`   you dictate:  ${safe(demo.heard)}`);
  ctx.say(`   ${bold('your agent sees')}: ${bold(safe(demo.corrected))}`);
  if (summary) ctx.say(dim(`   fixed: ${summary}`));
  if (demo.usedExample) {
    ctx.say(dim('   (that used the built-in example terms: your lexicon has no misspellings recorded yet)'));
    // A name this run seeds has no misspelling yet (that is why the example
    // stood in), so name it rather than a "Your Co" placeholder.
    const own = (ctx.plan ? ctx.plan.wouldSeed : ctx.seeded)[0];
    ctx.say(
      dim(
        own === undefined
          ? '   add one now: lexicon add "Your Co" --suggest'
          : `   add one now, what speech-to-text writes for it: ${shownCommand(['lexicon', 'add', own, '<misspelling>'])}`,
      ),
    );
  }
  const record = { heard: demo.heard, corrected: demo.corrected, terms: demo.terms, usedExample: demo.usedExample };
  if (ctx.plan) ctx.plan.demo = record;
  else ctx.summary.demo = record;
}

/** Step h (dry run): the plan card. */
