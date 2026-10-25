/**
 * `lexicon doctor --fix [--apply] [--json]`: repairs for the breakages the
 * doctor already names, with the semantics of `locus doctor --fix` (see
 * docs/doctor-fix.md): a preview by default that writes nothing, `--apply`
 * to make the changes with a backup of every file first, `--json` for one
 * `{ mode, plan, outcome }` object, exit 1 only when an applied fix was
 * skipped. `ashlr-stack`'s `stack doctor --fix` runs it for every companion
 * whose handshake lists the `doctor-fix` capability.
 *
 * Repairs are local, deterministic and reversible, and only for files whose
 * contents lexicon can rebuild or does without:
 *   - a missing global lexicon is created empty (what `lexicon init` writes);
 *   - an unusable trust registry, hit counts file, pending corrections queue
 *     or index cache is moved aside: copied to `<file>.bak-<UTC stamp>` (new
 *     file, mode 0600), then removed, which is what the doctor's own message
 *     tells the user to do. lexicon already reads each of them as empty
 *     while it is broken, so behavior is what it was, minus the warning.
 * Everything else stays a manual item in the plan: a global or project
 * lexicon that does not parse (the user's terms), `serve.json` (it holds the
 * local API's pairing token, and secrets are never touched), a state path
 * that is a directory or a symlink, and the Claude hook and MCP registration
 * (`lexicon install claude --apply` edits settings it previews itself).
 */
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import {
	getHitsPath,
	getTrustPath,
	hitsRegistryProblem,
	INDEX_CACHE_FILE_NAME,
	indexCacheProblem,
	pendingPathFor,
	readLexiconFile,
	readPending,
	resolvePaths,
	trustRegistryProblem,
} from "../core/index.js";
import { readServeConfigResult } from "../serve/config.js";
import { errorMessage } from "../util/errors.js";
import { homeDir } from "../util/xdg.js";
import { createLexiconFile } from "./commands.js";
import type { CommonOptions, IO } from "./io.js";
import { dim, line, refuse, resolveCwd, safeMessage } from "./io.js";

/** A state file beside the global lexicon that `--apply` may move aside. */
export type StateFile = "trust" | "hits" | "pending" | "index_cache";

export type PlannedFix =
	| { kind: "create_global_lexicon"; file: string; reason: string }
	| { kind: "move_aside"; target: StateFile; file: string; reason: string };

export interface ReportOnly {
	code: string;
	file?: string;
	message: string;
}

export interface FixPlan {
	fixes: PlannedFix[];
	report_only: ReportOnly[];
}

export interface AppliedFix {
	fix: PlannedFix;
	applied: boolean;
	backup?: string;
	message?: string;
}

export interface FixOutcome {
	results: AppliedFix[];
}

export interface FixEnv {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home: string;
	/** Clock for backup names (tests). */
	now?: () => Date;
}

const STATE_LABEL: Record<StateFile, string> = {
	trust: "trust registry (trust.json)",
	hits: "hit counts (hits.json)",
	pending: "pending corrections queue",
	index_cache: "index cache",
};

const STATE_EFFECT: Record<StateFile, string> = {
	trust:
		"every project lexicon reads as untrusted until you run lexicon trust in it again",
	hits: "hit counts start over",
	pending: "queued corrections are kept only in the backup",
	index_cache: "lexicon writes a new one on the next match",
};

export function describeFix(f: PlannedFix): string {
	if (f.kind === "create_global_lexicon")
		return `create the missing global lexicon (empty, as lexicon init does): ${f.file}`;
	return `move aside the ${STATE_LABEL[f.target]}, which ${f.reason} (${STATE_EFFECT[f.target]}): ${f.file}`;
}

/** Why `file` cannot be moved aside safely, or undefined when it is a regular file. */
async function notARegularFile(file: string): Promise<string | undefined> {
	try {
		const st = await fs.lstat(file);
		if (st.isSymbolicLink()) return "is a symlink";
		if (!st.isFile()) return "is not a file";
		return undefined;
	} catch (e) {
		return `cannot be read (${(e as NodeJS.ErrnoException).code ?? errorMessage(e)})`;
	}
}

/** The problem of one state file now, or undefined when it is fine (or missing). */
async function stateProblem(
	target: StateFile,
	opts: FixEnv,
	globalPath: string,
): Promise<string | undefined> {
	const store = { cwd: opts.cwd, env: opts.env, home: opts.home };
	switch (target) {
		case "trust":
			return trustRegistryProblem(store);
		case "hits":
			return hitsRegistryProblem(store);
		case "index_cache":
			return indexCacheProblem(globalPath);
		case "pending":
			try {
				await readPending(pendingPathFor(globalPath));
				return undefined;
			} catch (err) {
				const file = pendingPathFor(globalPath);
				return errorMessage(err).replace(`${file} `, "");
			}
	}
}

function statePath(
	target: StateFile,
	opts: FixEnv,
	globalPath: string,
): string {
	const store = { cwd: opts.cwd, env: opts.env, home: opts.home };
	switch (target) {
		case "trust":
			return getTrustPath(store);
		case "hits":
			return getHitsPath(store);
		case "pending":
			return pendingPathFor(globalPath);
		case "index_cache":
			return path.join(path.dirname(globalPath), INDEX_CACHE_FILE_NAME);
	}
}

/** Reads the lexicon files and state beside them; writes nothing. */
export async function planFixes(opts: FixEnv): Promise<FixPlan> {
	const plan: FixPlan = { fixes: [], report_only: [] };
	const paths = resolvePaths({ cwd: opts.cwd, env: opts.env, home: opts.home });

	try {
		const g = await readLexiconFile(paths.global, "global");
		if (!g.exists)
			plan.fixes.push({
				kind: "create_global_lexicon",
				file: paths.global,
				reason: "is missing",
			});
	} catch (err) {
		plan.report_only.push({
			code: "global_lexicon_unreadable",
			file: paths.global,
			message: `the global lexicon does not parse or cannot be read; it holds your terms, so fix it by hand (lexicon edit): ${errorMessage(err)}`,
		});
	}
	if (paths.project) {
		try {
			await readLexiconFile(paths.project, "project");
		} catch (err) {
			plan.report_only.push({
				code: "project_lexicon_unreadable",
				file: paths.project,
				message: `the project lexicon does not parse or cannot be read; fix it by hand (lexicon edit --project): ${errorMessage(err)}`,
			});
		}
	}

	for (const target of ["trust", "hits", "pending", "index_cache"] as const) {
		const problem = await stateProblem(target, opts, paths.global);
		if (problem === undefined) continue;
		const file = statePath(target, opts, paths.global);
		const odd = await notARegularFile(file);
		if (odd !== undefined) {
			plan.report_only.push({
				code: `${target}_not_a_file`,
				file,
				message: `the ${STATE_LABEL[target]} ${odd}, so it is not moved automatically; move it aside by hand`,
			});
			continue;
		}
		plan.fixes.push({ kind: "move_aside", target, file, reason: problem });
	}

	const serve = await readServeConfigResult({
		cwd: opts.cwd,
		env: opts.env,
		home: opts.home,
	});
	if (serve.status === "unusable") {
		plan.report_only.push({
			code: "serve_config_unusable",
			file: serve.path,
			message: `serve.json ${serve.reason}; it holds the local API pairing token, so it is never changed here (run: lexicon serve --uninstall && lexicon serve --install)`,
		});
	}
	return plan;
}

function stamp(d: Date): string {
	return d
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}

/** Copies `file` to a new `<file>.bak-<stamp>` (0600, never over an existing file). */
async function backup(file: string, now: Date): Promise<string> {
	const base = `${file}.bak-${stamp(now)}`;
	for (let n = 0; n < 100; n++) {
		const target = n === 0 ? base : `${base}-${n}`;
		try {
			await fs.copyFile(file, target, fsc.COPYFILE_EXCL);
			await fs.chmod(target, 0o600);
			return target;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
	throw new Error(`no free backup name beside ${file}`);
}

/**
 * Makes each planned fix after checking it still applies to the file as it
 * is now; a file that changed since the plan is skipped, never forced.
 */
export async function applyFixes(
	plan: FixPlan,
	opts: FixEnv,
): Promise<FixOutcome> {
	const now = (opts.now ?? (() => new Date()))();
	const globalPath = resolvePaths({
		cwd: opts.cwd,
		env: opts.env,
		home: opts.home,
	}).global;
	const results: AppliedFix[] = [];
	for (const fix of plan.fixes) {
		try {
			if (fix.kind === "create_global_lexicon") {
				const created = await createLexiconFile(fix.file, "global");
				results.push(
					created
						? { fix, applied: true }
						: { fix, applied: false, message: "skipped: the file exists now" },
				);
				continue;
			}
			if ((await stateProblem(fix.target, opts, globalPath)) === undefined) {
				results.push({
					fix,
					applied: false,
					message: "skipped: the file is fine or gone now",
				});
				continue;
			}
			const odd = await notARegularFile(fix.file);
			if (odd !== undefined) {
				results.push({
					fix,
					applied: false,
					message: `skipped: the file ${odd} now`,
				});
				continue;
			}
			const saved = await backup(fix.file, now);
			// The backup must be byte-identical before the original goes.
			const [a, b] = await Promise.all([
				fs.readFile(fix.file),
				fs.readFile(saved),
			]);
			if (!a.equals(b)) {
				results.push({
					fix,
					applied: false,
					backup: saved,
					message: "skipped: the file changed while it was backed up",
				});
				continue;
			}
			await fs.unlink(fix.file);
			results.push({ fix, applied: true, backup: saved });
		} catch (err) {
			results.push({
				fix,
				applied: false,
				message: `skipped: ${errorMessage(err)}`,
			});
		}
	}
	return { results };
}

export interface DoctorFixOptions extends CommonOptions {
	json?: boolean;
	fix?: boolean;
	apply?: boolean;
}

/** The `--apply` refusal: it only means something with `--fix`. */
export const APPLY_WITHOUT_FIX =
	"--apply needs --fix (lexicon doctor --fix previews, lexicon doctor --fix --apply repairs)";

export async function runDoctorFix(
	opts: DoctorFixOptions,
	io: IO,
	deps: { env?: NodeJS.ProcessEnv; home?: string; now?: () => Date } = {},
): Promise<number> {
	const apply = opts.apply === true;
	const fixEnv: FixEnv = {
		cwd: resolveCwd(opts),
		env: deps.env ?? process.env,
		home: deps.home ?? homeDir(),
		...(deps.now ? { now: deps.now } : {}),
	};
	const plan = await planFixes(fixEnv);
	const outcome =
		apply && plan.fixes.length > 0 ? await applyFixes(plan, fixEnv) : null;
	const failed = outcome !== null && outcome.results.some((r) => !r.applied);
	if (opts.json) {
		line(
			io,
			JSON.stringify(
				{ mode: apply ? "apply" : "dry_run", plan, outcome },
				null,
				2,
			),
		);
		return failed ? 1 : 0;
	}
	if (plan.fixes.length === 0) {
		line(io, "doctor --fix: nothing to repair");
	} else if (outcome) {
		line(io, "doctor --fix --apply:");
		for (const r of outcome.results) {
			line(
				io,
				`  ${r.applied ? "fixed  " : "skipped"} ${safeMessage(describeFix(r.fix))}`,
			);
			if (r.backup) line(io, `          backup: ${safeMessage(r.backup)}`);
			if (r.message) line(io, `          ${safeMessage(r.message)}`);
		}
	} else {
		line(io, "doctor --fix (dry run, nothing written):");
		for (const f of plan.fixes)
			line(io, `  would fix  ${safeMessage(describeFix(f))}`);
		line(
			io,
			dim(
				"Run `lexicon doctor --fix --apply` to make these changes (each file is backed up first).",
			),
		);
	}
	for (const r of plan.report_only)
		line(io, `  manual     ${safeMessage(r.message)}`);
	return failed ? 1 : 0;
}

export function refuseApplyWithoutFix(
	io: IO,
	json: boolean | undefined,
): number {
	return refuse(
		io,
		json,
		APPLY_WITHOUT_FIX,
		"run: lexicon doctor --fix --apply",
	);
}
