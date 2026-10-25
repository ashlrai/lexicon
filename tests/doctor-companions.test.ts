/**
 * `lexicon doctor` companions: locus and ashlr-md read through
 * `--ashlr-handshake --json`. Same rules as ashlr-stack #95 and
 * ashlr-plugin #218: info only, capability-gated next steps, no secrets in
 * the probe env, unparseable output reads as unknown.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CompanionRunner,
	LOCUS_DOCTOR_FIX_STEP,
	companionCheckMessage,
	companionEnv,
	defaultCompanionRunner,
	detectCompanions,
} from "../src/cli/companions.js";

const hs = (version: string, caps: string[], health = "ok"): string =>
	JSON.stringify({
		kind: "ashlr.handshake",
		schema_version: 1,
		version,
		capabilities: caps,
		health: { status: health, checks: [] },
	});

const only =
	(stdout: string): CompanionRunner =>
	async (cmd) =>
		cmd === "locus" ? { kind: "ran", code: 0, stdout } : { kind: "missing" };

const locus = async (stdout: string) => {
	const r = (await detectCompanions(only(stdout))).find(
		(c) => c.name === "locus",
	);
	if (!r) throw new Error("no locus");
	return r;
};

describe("detectCompanions", () => {
	it("probes locus and mdopener-mcp in parallel with the 2s timeout", async () => {
		const seen: Array<[string, number]> = [];
		const out = await detectCompanions(async (cmd, t) => {
			seen.push([cmd, t]);
			return { kind: "missing" };
		});
		expect(seen).toEqual([
			["locus", 2000],
			["mdopener-mcp", 2000],
		]);
		expect(out.map((r) => r.state)).toEqual(["missing", "missing"]);
		expect(companionCheckMessage(out[1])).toContain(
			"companion ashlr-md (optional, report-only): not installed; optional: install ashlr-md",
		);
	});

	it("degraded locus that lists doctor-fix gets locus doctor --fix", async () => {
		const r = await locus(hs("0.5.2", ["doctor-fix"], "degraded"));
		expect(r).toMatchObject({
			state: "degraded",
			health: "degraded",
			next_steps: [LOCUS_DOCTOR_FIX_STEP],
		});
		expect(companionCheckMessage(r)).toContain("run `locus doctor --fix`");
	});

	it("healthy locus: nothing extra", async () => {
		const r = await locus(hs("0.5.2", ["doctor-fix"], "ok"));
		expect(r).toMatchObject({ state: "ready", next_steps: [], fix: null });
		expect(companionCheckMessage(r)).toBe(
			"companion locus (optional, report-only): 0.5.2 ready [doctor-fix]",
		);
	});

	it("degraded locus without doctor-fix: no guess from version", async () => {
		for (const v of ["0.5.1", "0.6.0", "9.9.9"]) {
			const r = await locus(hs(v, ["doctor-json"], "degraded"));
			expect(r.next_steps).toEqual([]);
			expect(companionCheckMessage(r)).not.toContain("doctor --fix");
		}
	});

	it("degraded ashlr-md gets the handshake hint, never a locus hint", async () => {
		const out = await detectCompanions(async (cmd) =>
			cmd === "mdopener-mcp"
				? {
						kind: "ran",
						code: 0,
						stdout: hs("0.4.0", ["mcp-server", "doctor-fix"], "degraded"),
					}
				: { kind: "missing" },
		);
		expect(out[1]).toMatchObject({ state: "degraded", next_steps: [] });
		expect(out[1].fix).toBe(
			"run `mdopener-mcp --ashlr-handshake --json` to see which check is not ok",
		);
	});

	it("unparseable or wrong-shape output reads as unknown; plain text as outdated; timeout as unknown", async () => {
		expect((await locus("{not json")).state).toBe("unknown");
		expect((await locus("null")).state).toBe("unknown");
		expect((await locus("[]")).state).toBe("unknown");
		expect((await locus(JSON.stringify({ kind: "other" }))).state).toBe(
			"unknown",
		);
		expect((await locus("usage: locus [OPTIONS]")).state).toBe("outdated");
		const t = await detectCompanions(async () => ({ kind: "timeout" }));
		expect(t[0].state).toBe("unknown");
	});

	it("a throwing runner reads as missing", async () => {
		const out = await detectCompanions(async () => {
			throw new Error("boom");
		});
		expect(out.every((r) => r.state === "missing")).toBe(true);
	});

	it("env passes no secrets", () => {
		expect(
			companionEnv({
				PATH: "/bin",
				HOME: "/h",
				OPENAI_API_KEY: "sk-x",
				GITHUB_TOKEN: "t",
				PHANTOM_PROXY_TOKEN: "p",
			}),
		).toEqual({
			PATH: "/bin",
			HOME: "/h",
			NO_COLOR: "1",
		});
	});
});

describe.skipIf(process.platform === "win32")(
	"stand-in companion binaries on PATH",
	() => {
		it("real spawn: degraded locus stand-in gets the hint; argv is the handshake only; env has no secrets", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lexicon-cmp-bin-"));
			const envOut = path.join(dir, "env.txt");
			const argvOut = path.join(dir, "argv.txt");
			await fs.writeFile(
				path.join(dir, "locus"),
				`#!/bin/sh\nenv > "${envOut}"\necho "$@" > "${argvOut}"\nprintf '%s' '${hs("0.5.2", ["doctor-fix"], "degraded")}'\n`,
				{ mode: 0o755 },
			);
			const prevPath = process.env["PATH"];
			process.env["PATH"] = `${dir}${path.delimiter}${prevPath ?? ""}`;
			process.env["LEXICON_TEST_SECRET_TOKEN"] = "sk-should-not-leak";
			try {
				const [r] = await detectCompanions(undefined, [
					{ name: "locus", command: "locus", repo: "ashlrai/locus" },
				]);
				expect(r).toMatchObject({
					state: "degraded",
					version: "0.5.2",
					next_steps: [LOCUS_DOCTOR_FIX_STEP],
				});
				expect(await fs.readFile(envOut, "utf8")).not.toContain(
					"sk-should-not-leak",
				);
				expect((await fs.readFile(argvOut, "utf8")).trim()).toBe(
					"--ashlr-handshake --json",
				);
			} finally {
				process.env["PATH"] = prevPath;
				delete process.env["LEXICON_TEST_SECRET_TOKEN"];
			}
		});

		it("real spawn: a hanging stand-in is cut off near the timeout", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lexicon-cmp-bin-"));
			await fs.writeFile(
				path.join(dir, "slowtool"),
				"#!/bin/sh\nexec sleep 30\n",
				{ mode: 0o755 },
			);
			const prevPath = process.env["PATH"];
			process.env["PATH"] = `${dir}${path.delimiter}${prevPath ?? ""}`;
			try {
				const t0 = Date.now();
				const [r] = await detectCompanions(
					undefined,
					[{ name: "slow", command: "slowtool", repo: "x/y" }],
					300,
				);
				expect(r.state).toBe("unknown");
				expect(Date.now() - t0).toBeLessThan(5000);
			} finally {
				process.env["PATH"] = prevPath;
			}
		});

		it("default runner: a missing binary is missing", async () => {
			expect(
				await defaultCompanionRunner("lexicon-not-installed-xyz", 500),
			).toEqual({ kind: "missing" });
		});
	},
);
