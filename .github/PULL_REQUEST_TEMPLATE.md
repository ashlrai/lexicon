## What

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The transcript / correction that motivated this, if applicable. -->

## Checklist

<!-- The required check is CI Gate (typecheck, build, crypto policy, redaction tests, diff secret scans). The full suite runs daily on main, not on this PR, so run it locally. See CONTRIBUTING.md "Contribute with an agent". -->

- [ ] `npm run typecheck`, `npm run build`, `npm run check:crypto`, `npx vitest run tests/upstream-redaction.test.ts` and `npm test` pass locally
- [ ] Tests added or updated (`tests/*.test.ts`, or the colocated `src/**/*.test.ts` file if the module has one)
- [ ] `npm run build:bundle` run and `plugin/` committed if `src/core`, `src/mcp`, `src/hooks`, `src/cli` or a dependency changed
- [ ] `npm run docs:cli` run if a command or flag changed; `npm run check:facts` if a tool, command, format or pack was added
- [ ] `npm run check:links` run if a doc moved; `npm run fresh:check` if a version or release fact moved
- [ ] `docs/CONTRACT.md` updated if a public signature changed
- [ ] `CHANGELOG.md` has a bullet under `Unreleased`
- [ ] README tables updated if a tool, command, format or client was added
- [ ] Relative imports end in `.js`; no `any` in exported signatures
- [ ] No tokens or secrets in the diff, not even fake ones shaped like real ones

## Agent used (optional)

<!-- Helps us learn which coding tools contribute. Leave blank for a fully human PR.
     Examples: Codex, Claude Code, Cursor, GitHub Copilot, Gemini CLI, Grok, Devin, Aider, Windsurf, local model (name it). -->

Agent used:
