# Affected Vitest tests

Run `node scripts/affected-tests.mjs origin/main` from the repository root after
installing dependencies. The script compares the merge base of the given commit
and HEAD with HEAD (`base...HEAD`). Use a clean checkout of the revision being
tested. Fetch the base and enough history to find the merge base first.

Stdout is either a sorted, deduplicated test file path per line, empty for no
changes or documentation-only changes, or `ALL` to request `npm test`. A caller
must handle these three cases explicitly: invoking Vitest with no targets runs
the full suite. Errors exit nonzero and must not be treated as an empty list.
No workflows are changed by this script.

Selection follows relative imports, re-exports and literal dynamic imports,
including `.js` references to TypeScript sources. Source changes also select
filesystem and subprocess consumers to cover source inspections and entry points
that do not have static import edges. Test-only edits select those tests and their
importers. Lockfiles, manifests, config files, deleted files, fixtures, generated
assets, unreferenced modules and unknown paths conservatively request `ALL`.
Only root Markdown and documentation Markdown/images qualify for omission.
Renames are treated as deletion plus addition; filenames are read from Git with
NUL delimiters. This repository has one Vitest package, so targets are test files;
unknown package or crate paths request the full suite.
