/**
 * Cross-tool hints for `lexicon doctor`: asks locus and ashlr-md
 * (`mdopener-mcp`) for `--ashlr-handshake --json` (docs/ashlr-handshake.md)
 * and reports version and health. Same rules as `stack doctor --ecosystem`
 * (ashlr-stack #95) and the `ashlr doctor` companions section
 * (ashlr-plugin #218), so the doctors agree:
 * - the environment is PATH, HOME, USER, locale and TMPDIR only (no secret
 *   in this process reaches another tool), with a 2 s timeout per probe and
 *   every probe in parallel;
 * - a missing tool is an info line, never a warning or failure;
 * - a timeout, or JSON that is not a v1 handshake, reads as `unknown`;
 *   plain text (an older build that rejects the flag) reads as `outdated`;
 * - a next step is suggested only when the tool itself advertises the
 *   capability it needs (`locus doctor --fix` and `mdopener-mcp doctor --fix`
 *   need `doctor-fix`), never
 *   from a version number.
 * Only `--ashlr-handshake --json` is ever run; nothing reads a secret.
 */
import { spawn } from "node:child_process";

export interface Companion {
	name: string;
	command: string;
	repo: string;
}

export const DOCTOR_COMPANIONS: readonly Companion[] = [
	{ name: "locus", command: "locus", repo: "ashlrai/locus" },
	{ name: "ashlr-md", command: "mdopener-mcp", repo: "ashlrai/ashlr-md" },
];

export const COMPANION_TIMEOUT_MS = 2000;

export type CompanionRun =
	| { kind: "ran"; code: number | null; stdout: string }
	| { kind: "missing" }
	| { kind: "timeout" };

export type CompanionRunner = (
	command: string,
	timeoutMs: number,
) => Promise<CompanionRun>;

export interface CompanionResult {
	name: string;
	command: string;
	/** ready: v1, health ok; degraded: v1, health not ok; outdated: no JSON; unknown: timeout or not a v1 handshake; missing: not installed. */
	state: "ready" | "degraded" | "outdated" | "unknown" | "missing";
	version: string | null;
	capabilities: string[];
	/** The handshake's `health.status`, or null without a v1 answer. */
	health: string | null;
	fix: string | null;
	/** Capability-gated commands to run next; empty when there are none. */
	next_steps: string[];
}

/** Handshake capability a tool advertises when `<command> doctor --fix` exists. */
export const DOCTOR_FIX_CAPABILITY = "doctor-fix";

/** Companions with a dry-run-by-default `doctor --fix`, by name, valued by the command to run. */
export const DOCTOR_FIX_COMMANDS: ReadonlyMap<string, string> = new Map([
	["locus", "locus"],
	["ashlr-md", "mdopener-mcp"],
]);

export const doctorFixStep = (command: string): string =>
	`${command} doctor --fix   # preview safe repairs (writes nothing); add --apply to make them`;

export const LOCUS_DOCTOR_FIX_STEP = doctorFixStep("locus");
export const MDOPENER_DOCTOR_FIX_STEP = doctorFixStep("mdopener-mcp");

/** PATH, HOME, USER, locale and TMPDIR only. */
export function companionEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const k of [
		"PATH",
		"HOME",
		"USER",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"SYSTEMROOT",
		"PATHEXT",
	]) {
		const v = env[k];
		if (v !== undefined) out[k] = v;
	}
	out["NO_COLOR"] = "1";
	return out;
}

/** A runner that probes with `companionEnv(env)`: doctor passes its own env, so PATH is the one it reports on. */
export const makeCompanionRunner =
	(env: NodeJS.ProcessEnv = process.env): CompanionRunner =>
	(command, timeoutMs) =>
		spawnHandshake(command, timeoutMs, companionEnv(env));

export const defaultCompanionRunner: CompanionRunner = (command, timeoutMs) =>
	spawnHandshake(command, timeoutMs, companionEnv());

function spawnHandshake(
	command: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<CompanionRun> {
	return new Promise((resolve) => {
		let stdout = "";
		let done = false;
		const finish = (r: CompanionRun): void => {
			if (!done) {
				done = true;
				resolve(r);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, ["--ashlr-handshake", "--json"], {
				env,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish({ kind: "missing" });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ kind: "timeout" });
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			if (stdout.length < 64_000) stdout += String(d);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			finish(
				err.code === "ENOENT"
					? { kind: "missing" }
					: { kind: "ran", code: 1, stdout: "" },
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ kind: "ran", code, stdout });
		});
	});
}

export function companionNextSteps(
	r: Pick<CompanionResult, "name" | "state" | "health" | "capabilities">,
): string[] {
	const command = DOCTOR_FIX_COMMANDS.get(r.name);
	if (
		command !== undefined &&
		r.state === "degraded" &&
		r.health !== null &&
		r.health !== "ok" &&
		r.capabilities.includes(DOCTOR_FIX_CAPABILITY)
	) {
		return [doctorFixStep(command)];
	}
	return [];
}

export function parseCompanion(
	c: Companion,
	run: CompanionRun,
): CompanionResult {
	const base = {
		name: c.name,
		command: c.command,
		version: null,
		capabilities: [] as string[],
		health: null,
		next_steps: [] as string[],
	};
	const docs = `https://github.com/${c.repo}#readme`;
	const unreadable = `\`${c.command} --ashlr-handshake --json\` printed output doctor cannot read`;
	if (run.kind === "missing")
		return {
			...base,
			state: "missing",
			fix: `optional: install ${c.name} (\`${c.command}\`), see ${docs}`,
		};
	if (run.kind === "timeout")
		return {
			...base,
			state: "unknown",
			fix: `\`${c.command} --ashlr-handshake --json\` did not answer in time`,
		};
	const text = run.stdout.trim();
	let v: unknown;
	let parsed = true;
	try {
		v = JSON.parse(text);
	} catch {
		parsed = false;
	}
	if (!parsed && !text.startsWith("{")) {
		return {
			...base,
			state: "outdated",
			fix: `upgrade ${c.name}: \`${c.command}\` does not answer --ashlr-handshake (see ${docs})`,
		};
	}
	if (!parsed || v === null || typeof v !== "object" || Array.isArray(v))
		return { ...base, state: "unknown", fix: unreadable };
	const h = v as {
		kind?: unknown;
		schema_version?: unknown;
		version?: unknown;
		capabilities?: unknown;
		health?: { status?: unknown };
	};
	if (h.kind !== "ashlr.handshake" || h.schema_version !== 1)
		return { ...base, state: "unknown", fix: unreadable };
	const health =
		typeof h.health?.status === "string" ? h.health.status : "unknown";
	const result: CompanionResult = {
		...base,
		state: health === "ok" ? "ready" : "degraded",
		version: typeof h.version === "string" ? h.version : null,
		capabilities: Array.isArray(h.capabilities)
			? h.capabilities.filter((x): x is string => typeof x === "string")
			: [],
		health,
		fix:
			health === "ok"
				? null
				: `run \`${c.command} --ashlr-handshake --json\` to see which check is not ok`,
	};
	result.next_steps = companionNextSteps(result);
	if (result.next_steps.length > 0)
		result.fix = `run \`${DOCTOR_FIX_COMMANDS.get(c.name)} doctor --fix\` to preview safe repairs (writes nothing); add --apply to make them`;
	return result;
}

/** Probes every companion in parallel. Never throws. */
export async function detectCompanions(
	runner: CompanionRunner = defaultCompanionRunner,
	companions: readonly Companion[] = DOCTOR_COMPANIONS,
	timeoutMs = COMPANION_TIMEOUT_MS,
): Promise<CompanionResult[]> {
	return Promise.all(
		companions.map(async (c) =>
			parseCompanion(
				c,
				await runner(c.command, timeoutMs).catch(
					(): CompanionRun => ({ kind: "missing" }),
				),
			),
		),
	);
}

/** One `info` line per companion: never a warning or failure. */
export function companionCheckMessage(r: CompanionResult): string {
	const caps =
		r.capabilities.length > 0 ? ` [${r.capabilities.join(", ")}]` : "";
	const detail =
		r.state === "ready"
			? `${r.version ?? "?"} ready${caps}`
			: r.state === "degraded"
				? `${r.version ?? "?"} health: ${r.health ?? "unknown"}${caps}`
				: r.state === "outdated"
					? "installed, too old for --ashlr-handshake"
					: r.state === "unknown"
						? "installed, handshake unreadable or timed out"
						: "not installed";
	return `companion ${r.name} (optional, report-only): ${detail}${r.fix ? `; ${r.fix}` : ""}`;
}
