/**
 * `lexicon doctor --fix [--apply] [--json]`: preview writes nothing, apply
 * repairs with a byte-identical backup, a second run has nothing to fix, and
 * the refusals. Real files in temp directories only.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFixes, planFixes, runDoctorFix } from "../src/cli/doctor-fix.js";
import { buildHandshake } from "../src/cli/handshake.js";
import type { IO } from "../src/cli/io.js";

let tmp: string;
let globalPath: string;
let env: NodeJS.ProcessEnv;

function io(): IO & { out: string; err: string } {
	const o = {
		out: "",
		err: "",
		stdout(s: string) {
			o.out += s;
		},
		stderr(s: string) {
			o.err += s;
		},
	};
	return o;
}

async function snapshot(dir: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const name of (await fs.readdir(dir)).sort()) {
		const p = path.join(dir, name);
		const st = await fs.lstat(p);
		out[name] = st.isFile()
			? await fs.readFile(p, "utf8")
			: `<${st.isDirectory() ? "dir" : "other"}>`;
	}
	return out;
}

const VALID =
	"version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n";

beforeEach(async () => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "lexicon-doctor-fix-"));
	globalPath = path.join(tmp, "cfg", "lexicon.yaml");
	await fs.mkdir(path.dirname(globalPath), { recursive: true });
	env = {
		...process.env,
		HOME: tmp,
		LEXICON_PATH: globalPath,
		XDG_CONFIG_HOME: path.join(tmp, "xdg"),
	};
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const fixEnv = () => ({
	cwd: tmp,
	env,
	home: tmp,
	now: () => new Date("2026-10-25T18:00:00Z"),
});

describe("lexicon doctor --fix", () => {
	it("previews a missing global lexicon and writes nothing", async () => {
		const before = await snapshot(path.dirname(globalPath));
		const o = io();
		const code = await runDoctorFix({ fix: true, json: true, cwd: tmp }, o, {
			env,
			home: tmp,
		});
		expect(code).toBe(0);
		const v = JSON.parse(o.out);
		expect(v.mode).toBe("dry_run");
		expect(v.outcome).toBeNull();
		expect(v.plan.fixes).toEqual([
			{ kind: "create_global_lexicon", file: globalPath, reason: "is missing" },
		]);
		expect(await snapshot(path.dirname(globalPath))).toEqual(before);
	});

	it("moves broken state files aside with identical backups, then has nothing to fix", async () => {
		await fs.writeFile(globalPath, VALID);
		const dir = path.dirname(globalPath);
		const broken = {
			"trust.json": "{ not json",
			"hits.json": "[1, 2",
			"index-cache.json": "garbage, not a cache",
		};
		for (const [name, text] of Object.entries(broken))
			await fs.writeFile(path.join(dir, name), text);
		const before = await snapshot(dir);

		// Preview: plans all three, writes nothing.
		const preview = io();
		expect(
			await runDoctorFix({ fix: true, cwd: tmp }, preview, { env, home: tmp }),
		).toBe(0);
		expect(preview.out).toContain("would fix");
		expect(await snapshot(dir)).toEqual(before);

		const o = io();
		const code = await runDoctorFix(
			{ fix: true, apply: true, json: true, cwd: tmp },
			o,
			{ env, home: tmp, now: fixEnv().now },
		);
		expect(code).toBe(0);
		const v = JSON.parse(o.out);
		expect(v.mode).toBe("apply");
		const results = v.outcome.results as Array<{
			fix: { file: string; target: string };
			applied: boolean;
			backup: string;
		}>;
		expect(results.map((r) => r.fix.target).sort()).toEqual([
			"hits",
			"index_cache",
			"trust",
		]);
		for (const r of results) {
			expect(r.applied).toBe(true);
			const name = path.basename(r.fix.file);
			expect(await fs.readFile(r.backup, "utf8")).toBe(
				broken[name as keyof typeof broken],
			);
			expect(r.backup).toBe(`${r.fix.file}.bak-20261025T180000Z`);
			if (process.platform !== "win32")
				expect((await fs.stat(r.backup)).mode & 0o777).toBe(0o600);
			await expect(fs.stat(r.fix.file)).rejects.toThrow();
		}
		// The lexicon itself is untouched.
		expect(await fs.readFile(globalPath, "utf8")).toBe(VALID);

		const again = io();
		expect(
			await runDoctorFix({ fix: true, apply: true, cwd: tmp }, again, {
				env,
				home: tmp,
			}),
		).toBe(0);
		expect(again.out).toContain("nothing to repair");
	});

	it("creates a missing global lexicon on apply", async () => {
		const o = io();
		expect(
			await runDoctorFix({ fix: true, apply: true, json: true, cwd: tmp }, o, {
				env,
				home: tmp,
			}),
		).toBe(0);
		expect(JSON.parse(o.out).outcome.results[0].applied).toBe(true);
		expect((await planFixes(fixEnv())).fixes).toEqual([]);
	});

	it("leaves an unparseable lexicon and serve.json as manual items", async () => {
		await fs.writeFile(globalPath, "terms: [: oops");
		const before = await snapshot(path.dirname(globalPath));
		const plan = await planFixes(fixEnv());
		expect(plan.fixes).toEqual([]);
		expect(plan.report_only.map((r) => r.code)).toContain(
			"global_lexicon_unreadable",
		);
		const o = io();
		expect(
			await runDoctorFix({ fix: true, apply: true, cwd: tmp }, o, {
				env,
				home: tmp,
			}),
		).toBe(0);
		expect(o.out).toContain("manual");
		expect(await snapshot(path.dirname(globalPath))).toEqual(before);
	});

	it("does not move a state path that is a directory", async () => {
		await fs.writeFile(globalPath, VALID);
		await fs.mkdir(path.join(path.dirname(globalPath), "index-cache.json"));
		const plan = await planFixes(fixEnv());
		expect(plan.fixes).toEqual([]);
		expect(plan.report_only.map((r) => r.code)).toContain(
			"index_cache_not_a_file",
		);
	});

	it("skips a fix whose file was repaired between plan and apply", async () => {
		await fs.writeFile(globalPath, VALID);
		const trust = path.join(path.dirname(globalPath), "trust.json");
		await fs.writeFile(trust, "{ not json");
		const plan = await planFixes(fixEnv());
		expect(plan.fixes).toHaveLength(1);
		// Fixed by hand (moved away) between the preview and the apply.
		await fs.rm(trust);
		const out = await applyFixes(plan, fixEnv());
		expect(out.results[0].applied).toBe(false);
		expect(out.results[0].message).toContain("skipped");
		expect(
			(await fs.readdir(path.dirname(trust))).some((n) => n.includes(".bak-")),
		).toBe(false);
	});

	it("refuses --apply without --fix (CLI), and the handshake flag exists", () => {
		const cli = (args: string[]) =>
			spawnSync(
				process.execPath,
				["--import", "tsx", path.join("src", "cli", "index.ts"), ...args],
				{
					encoding: "utf8",
					env: { ...env },
				},
			);
		const r = cli(["doctor", "--apply", "--json"]);
		expect(r.status).toBe(1);
		expect(JSON.parse(r.stdout).error).toContain("--apply needs --fix");
		// Nothing was created by the refusal.
		expect(cli(["doctor", "--fix", "--json"]).status).toBe(0);

		expect(buildHandshake("1", { globalLexicon: true }).capabilities).toContain(
			"doctor-fix",
		);
		const help = cli(["doctor", "--help"]).stdout;
		expect(help).toContain("--fix");
		expect(help).toContain("--apply");
	});
});
