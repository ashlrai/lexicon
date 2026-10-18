# Local HTTP API

`lexicon serve` runs a small HTTP server on `http://127.0.0.1:41733` so tools
that cannot run a Claude Code hook or an MCP server can still correct dictated
text: the browser extension, Claude Desktop, the Codex app, macOS Shortcuts,
Raycast, Alfred, the [macOS menu bar app](MACOS-APP.md), the [Windows tray app](WINDOWS-APP.md), or a `curl` in a script. It is loopback
only, protected by a bearer token, and applies the same merged lexicon and
trust gate as every other surface.

```bash
lexicon serve                 # foreground, logs one line per request to stderr (an aborted one too)
lexicon serve --show          # print the URL and token (manual fallback for the extension options page)
lexicon serve --status        # is it up? (read-only: never creates serve.json)
lexicon serve --pair          # open http://127.0.0.1:41733/pair in the browser; the extension pairs itself
lexicon serve --install       # start at login: launchd (macOS), systemd --user (Linux), Scheduled Task (Windows)
lexicon serve --uninstall
```

`--install` writes `~/Library/LaunchAgents/ai.ashlr.lexicon.serve.plist` on
macOS, `~/.config/systemd/user/lexicon-serve.service` on Linux, or a logon-
triggered Scheduled Task on Windows, whose program is the built CLI,
resolved by `resolveCliEntry()`: `$LEXICON_CLI` if set, else the package's
`dist/cli/index.js` (found by walking up to the `@ashlr/lexicon` package.json,
so it is the same file whether the installer runs from `dist/` or from the
`plugin/` bundle behind `setup_lexicon`), else a `lexicon` binary on PATH. It
refuses to write, and never boots out an existing service, when that file
does not exist. `LEXICON_SERVE_LABEL` renames the launchd label (tests and
scratch installs on a machine where the real label is in use). When
`LEXICON_PATH` or `XDG_CONFIG_HOME` is set at install time, its absolute path
goes into the service (launchd `EnvironmentVariables`, systemd `Environment=`,
or a `serve.env` next to `serve.json` that the Scheduled Task loads with
`node --env-file`, which needs Node 20.6 or later), so the service serves the
same lexicon, `serve.json` and token that `lexicon serve --show` prints in that
shell. When neither is set the service file is unchanged. `lexicon
doctor` reports whether the service is loaded and whether its program path
still exists; `lexicon serve --uninstall && lexicon serve --install` repairs a
stale one.

The first run creates `~/.config/lexicon/serve.json` (mode 0600, next to your
global lexicon; follows `LEXICON_PATH` and `XDG_CONFIG_HOME`). An existing one
that other users can read (restored from a backup, synced, copied) is put back
to 0600 when `lexicon serve`, `--show` or `--install` reuses it:

```json
{
  "port": 41733,
  "token": "4087c60a7e636f357b6cca9bb2f22f48",
  "createdAt": "2026-09-19T21:17:29.963Z"
}
```

Add an optional `"allowedOrigins": ["https://app.example"]` array to let a
specific web origin call the API from a browser. Browser-extension origins
(`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) are
always allowed; `*` is never honoured.

## Endpoints

Eleven routes, twelve rows below: `/packs/:name` takes both a POST and a DELETE.
Every request must carry a `Host` header of `127.0.0.1:<port>`,
`localhost:<port>` or `[::1]:<port>` (with a non-loopback `--host`, the bound
IP address as well); anything else is 403 on every route, which is what stops
a DNS rebinding page. Every request except `GET /health` (without `?cwd=`)
and `GET /pair` needs `Authorization: Bearer <token>`. Requests and responses are JSON
(`Content-Type: application/json`) unless noted. Every GET route also answers
`HEAD` (`curl -I`) with the status and headers GET would send, `Content-Length`
included, and no body. Errors are
`{ "error": "<message>" }`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | | `{ ok: true, version, terms, projectTrust?, port }` (no auth; `?cwd=` needs the token, 401 without it) |
| GET | `/pair` | | the extension pairing page, `text/html`; carries the token in `<meta name="lexicon-token">` plus `lexicon-port` and `lexicon-version` (no auth; 403 unless the client is loopback, `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>`, and the request is not a cross-origin fetch; never sent with CORS headers) |
| POST | `/normalize` | `{ text, dryRun?, minConfidence?, cwd? }` | `NormalizeResult` (`input`, `output`, `replacements[]`, `changed`) plus `summary`. Matching stops after 1 s, so a huge text gets the corrections from its start, and the response then adds `incomplete` (`{ reasons: ['time'], checkedChars?, totalChars, note }`; the unchecked rest is unchanged). Plus `projectTrust?` and `skippedProject?` (path only) as `/stats` gives them, so an unchanged result in a repo whose `.lexicon.yaml` was skipped says why its names were left alone |
| POST | `/learn` | `{ heard, meant, scope? , cwd? }` | `{ term, created, aliasAdded, path, conflict?, note?, untrustedProject? }` (`conflict`: another term that also holds `heard`, with `note` naming the command that drops the alias from that term's file, `lexicon remove "<canonical>" --alias "<alias>" --global` or `--project`, as `lexicon learn --json` gives it; `untrustedProject`: the untrusted project lexicon also claims it, path only). `heard` or `meant` over 60 characters is a 400 that says to send only the misspelled name as `heard`, not the sentence around it |
| POST | `/add` | `{ canonical, aliases?, phonetic?, category?, notes?, never?, scope?, cwd? }` | `{ term, path, created, conflicts? }` (`conflicts`: `{ canonical, scope, as, spelling }` for each alias another term also holds, so it may still be corrected to that term, as MCP `add_term` reports it) |
| GET | `/lexicon` | | `{ lexicon, paths: { global, project? }, projectTrust?, skippedProject? }` |
| GET | `/stats` | | `LexiconStats`, plus `projectTrust?` and `skippedProject?` (path only) as `/lexicon` gives them: the counts leave a skipped project file out |
| GET | `/packs` | | `{ packs: [PackInfo & { installed }], installed: string[] }`; `installed` includes community refs (`author/name`) the lexicon files record. Plus `registryMismatch { fileOnly, recordOnly }` when those files and the registry records disagree, and `projectTrust` and `skippedProject` (path only) when a project file was not loaded, as MCP `list_packs` reports them. A registry index is never read: list its community packs with `lexicon pack list --registry <index>` or MCP `list_packs` |
| POST | `/packs/:name` | `{ scope?, cwd? }` (an empty body is fine) | `{ pack, added, merged, path, scope }`; an unknown pack is 404 |
| DELETE | `/packs/:name` | | `{ pack, removed, kept, files }`; `?scope=` and `?cwd=`. `kept` names pack terms you have since edited, which are left alone |
| GET | `/aliases` | `?canonical=X` | `{ canonical, aliases }`: the spellings STT is likely to produce for a name, for an onboarding form. `canonical` loses invisible characters and outer spaces first, as a stored canonical does, and is then at most 80 characters (400 otherwise) |
| GET | `/export/:format` | | the export as text; `Content-Type` per format (see below). `?category=` (repeat it or separate with commas) and `?limit=<n>` filter and cap it like `lexicon export --category` and `--limit`; an unknown format is a 404 whose `error` lists the formats |

Status codes: 400 invalid JSON, a bad or unknown field (bodies are strict: a misspelled key such as `dry_run` is refused, not ignored), an unknown or repeated query parameter on any route but `/pair` (query strings are strict the same way: `/lexicon?cdw=` and `/health?cdw=` are refused, with or without the token; only `/export`'s `category` may repeat), an unknown `category` or a `limit` that is not a positive integer on `/export`, a `cwd` that is empty or not an existing directory, or a body on `DELETE /packs/:name`, 401 missing or wrong token,
403 a `Host` that does not name this server (any route), a project-scope
write into an untrusted `.lexicon.yaml`, or `/pair` with a non-loopback client
/ a cross-origin `Origin`, 404 unknown route (the `error` lists every route as
`METHOD /path`) or export format,
405 wrong method (with an `Allow` header naming the route's methods: `GET, HEAD` on a GET route, `POST`, or `POST, DELETE` on `/packs/:name`), 413 body over 1 MB, 500 a problem on the server's side,
503 more than 64 requests in flight.

400 always means the request itself is wrong: fix the input and do not retry
as is. 500 means the request was fine and the server could not serve it: the
lexicon file does not parse (`internal error: Failed to parse lexicon YAML at
<path>: ...`), a lock on it is still held after its timeout, or the file
cannot be read or written. The message names the cause and the file, so fix
that and retry. An unauthenticated `/health` that hits the same problem gets
only `internal error (the lexicon serve log has the detail)`; the detail is
on the server's stderr either way.

`/pair` is for `lexicon serve --pair`: the CLI confirms `/health`, opens the
URL in the default browser, and the extension's content script on that page
reads the token and stores it (see `docs/EXTENSION.md`). The page is plain
HTML with inline CSS, no script and no external request, sent with
`Cache-Control: no-store`, `X-Frame-Options: DENY`, `Content-Security-Policy:
default-src 'none'; style-src 'unsafe-inline'` and `Referrer-Policy:
no-referrer`. Nothing else consumes it.

`cwd` picks which project `.lexicon.yaml` is considered (body field on POST,
`?cwd=` on GET). It defaults to the directory the server was started in. An
untrusted project file is never merged; `/health` (with the token), `/normalize` and `/lexicon` report
`projectTrust: "untrusted"`, and `/normalize`, `/lexicon`, `/stats` and `/packs` name the skipped file by path in
`skippedProject`. `/lexicon` `paths` lists only the files merged into `lexicon` (as MCP
`list_terms` does), so `paths.project` is present only for a trusted project file;
`projectTrust` is set whenever a project file exists, trusted or not.

The server keeps each `cwd`'s loaded lexicon for 2 s, so an edit made outside it shows within two seconds. A write through the API drops that cache at once; a `/normalize` that counts hits drops it only for the `cwd`s whose lexicon holds a term it matched, since nothing else changed.

Export content types: `csv` and `wispr` -> `text/csv`, `json` (also `superwhisper`,
`deepgram`, `assemblyai`, `azure`, `google`) -> `application/json`,
`claude-md` and `markdown` -> `text/markdown`, `text`, `whisper-prompt`,
`openai` -> `text/plain`, `macos` -> `application/xml`, `espanso` ->
`application/yaml`.

## curl

```bash
TOKEN=$(lexicon serve --show --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
API=http://127.0.0.1:41733

curl -s $API/health

curl -s -X POST $API/normalize \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"ping ashler about the ashlar demo"}'
# {"input":"ping ashler about the ashlar demo","output":"ping Ashlr.AI about the Ashlr.AI demo",
#  "replacements":[...],"changed":true,"summary":"\"ashler\" -> \"Ashlr.AI\" (alias, 1.00)\n..."}

curl -s -X POST $API/normalize -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"ping ashler","dryRun":true}'            # candidates only, no hits recorded

curl -s -X POST $API/learn -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"heard":"Ashlur","meant":"Ashlr.AI"}'

curl -s -X POST $API/add -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"canonical":"Entire.io","aliases":["entire io"],"category":"product"}'

curl -s $API/lexicon -H "Authorization: Bearer $TOKEN"
curl -s $API/export/csv -H "Authorization: Bearer $TOKEN"
curl -s $API/stats -H "Authorization: Bearer $TOKEN"
```

Only the JSON body is read; the text is returned exactly as normalize
produced it, so pipe `output` straight into whatever consumes it.

## macOS Shortcuts recipe

A "Fix dictation" shortcut that corrects whatever is on the clipboard (or the
selected text when run as a Quick Action) and puts the result back:

1. **Receive** `Text` input from `Quick Actions` (or start with **Get
   Clipboard**) and **Set Variable** `raw` to it.
2. **Get Contents of URL**: `http://127.0.0.1:41733/normalize`, Method
   `POST`. Headers: `Authorization` = `Bearer <token from lexicon serve --show>`,
   `Content-Type` = `application/json`. Request Body: `JSON`, add one field
   `text` of type Text whose value is the `raw` variable. Shortcuts escapes
   quotes and newlines for you, so never build the JSON by string
   concatenation.
3. **Get Dictionary Value** `output` from `Contents of URL`.
4. **Set Clipboard** to `Dictionary Value`. For a Quick Action, also **Stop
   and Output** the same value so the selection is replaced.

Assign a keyboard shortcut in Shortcuts > (i) > Add Keyboard Shortcut and run
`lexicon serve --install` once so the server is always up.

## Correcting the clipboard on a hotkey

If all you want is "dictate, press a key, paste the corrected text", you do not
need this API: `lexicon daemon --once --paste` does it with no token and no
server. The Raycast, Alfred, AutoHotkey and GNOME recipes are in
[DAEMON.md](DAEMON.md). Reach for the API instead when you need the structured
`replacements` list, or when whatever runs the hotkey is already making HTTP
calls.

## Embedding

The server is a plain `node:http` server behind one function:

```ts
import { createServer } from './dist/serve/index.js'; // defined in src/serve/server.ts; not a package subpath export yet

const api = createServer({ port: 0, quiet: true });
const { url, token } = await api.start();
// ... fetch(`${url}/normalize`, { headers: { Authorization: `Bearer ${token}` }, ... })
await api.stop();
```

`start()` creates or reuses `serve.json`, records the live port in it, and
throws a readable error when the port is taken. No signal handlers are
installed; the CLI adds SIGINT/SIGTERM handling around it.

## Security notes

Loopback only, bearer token stored 0600, CORS restricted to browser
extensions (never `*`), no TLS because nothing leaves the machine, 1 MB body
cap, 64 concurrent requests. Anyone who can read `serve.json` is already the
same user and could edit the lexicon file directly; the API grants nothing
beyond that. `/pair` hands the same token to a loopback browser tab whose
`Host` names this server, which is the same boundary. See `SECURITY.md`.

## See also

- [DAEMON.md](DAEMON.md) is the no-server way to correct the clipboard on a hotkey.
- [LIBRARY.md](LIBRARY.md) skips HTTP entirely and calls `normalize()` in process.
- [MATCHING.md](MATCHING.md) explains what `POST /normalize` does to a sentence.

Back to [the docs index](README.md).
