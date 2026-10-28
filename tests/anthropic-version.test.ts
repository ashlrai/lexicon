import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_API_VERSION } from "../src/util/anthropic.js";

const sourceRoot = new URL("../src/", import.meta.url);
const constantFile = "util/anthropic.ts";

// Check header writes in objects, computed properties, tuples, and set/append
// calls. Ignore standalone comments so examples do not masquerade as requests.
function violations(source: string, filename: string): number[] {
	const lines = new Set<number>();
	const code = source.replace(/^\s*\/\/[^\n]*/gm, (comment) =>
		comment.replace(/[^\n]/g, " "),
	);
	const headerValue =
		/(['"`])anthropic-version\1\s*\]?\s*[:,]\s*([^,;\n}\])]+)/gi;
	const versionLiteral = /(['"`])2023-06-01\1/g;
	const reject = (offset: number): void => {
		lines.add(code.slice(0, offset).split("\n").length);
	};
	if (filename !== constantFile) {
		for (const match of code.matchAll(versionLiteral)) reject(match.index);
	}
	for (const match of code.matchAll(headerValue)) {
		if (match[2].trim() !== "ANTHROPIC_API_VERSION") reject(match.index);
	}
	return [...lines];
}

describe("Anthropic API version policy", () => {
	it("pins the supported API version", () => {
		expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
	});

	it.each([
		`const headers = { 'anthropic-version': '2024-01-01' };`,
		'const headers = { "Anthropic-Version": "2024-01-01" };',
		'const headers = { ["anthropic-version"]: `2024-01-01` };',
		`new Headers([['anthropic-version', '2024-01-01']]);`,
		`headers.set('anthropic-version', '2024-01-01');`,
		`headers.append('anthropic-version', '2024-01-01');`,
		`const duplicate = '2023-06-01';`,
		`const headers = { 'anthropic-version':\n '2024-01-01' };`,
	])("rejects a hardcoded version: %s", (source) => {
		expect(violations(source, "client.ts")).toEqual([1]);
	});

	it.each([
		`const headers = { 'anthropic-version': ANTHROPIC_API_VERSION };`,
		`new Headers([['anthropic-version', ANTHROPIC_API_VERSION]]);`,
		`headers.set('anthropic-version', ANTHROPIC_API_VERSION);`,
		`headers.append('anthropic-version', ANTHROPIC_API_VERSION);`,
		`headers.get('anthropic-version');`,
		`// 'anthropic-version': '2024-01-01'`,
	])("accepts shared versions and non-writes: %s", (source) => {
		expect(violations(source, "client.ts")).toEqual([]);
	});

	it("guards every source file, including nested directories", () => {
		const failures: string[] = [];
		const files = readdirSync(sourceRoot, {
			recursive: true,
			withFileTypes: true,
		}).filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name));
		expect(files.length).toBeGreaterThan(0);
		for (const entry of files) {
			const path = join(entry.parentPath, entry.name);
			const filename = relative(fileURLToPath(sourceRoot), path).replaceAll(
				"\\",
				"/",
			);
			for (const line of violations(readFileSync(path, "utf8"), filename)) {
				failures.push(
					`${filename}:${line}: use ANTHROPIC_API_VERSION from src/util/anthropic.ts`,
				);
			}
		}
		expect(failures).toEqual([]);
	});
});
