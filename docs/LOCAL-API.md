# Local HTTP API

`lexicon serve` runs a small HTTP server on `http://127.0.0.1:41733` so tools
that cannot run a Claude Code hook or an MCP server can still correct dictated
text: the browser extension, Claude Desktop, the Codex app, macOS Shortcuts,
Raycast, Alfred, the menu bar app, or a `curl` in a script. It is loopback
only, protected by a bearer token, and applies the same merged lexicon and
trust gate as every other surface.

```bash
lexicon serve                 # foreground, logs one line per request to stderr
lexicon serve --show          # print the URL and token (paste into the extension options page)
lexicon serve --status        # is it up?
lexicon serve --install       # start at login: launchd (macOS) or systemd --user (Linux)
lexicon serve --uninstall
```

The first run creates `~/.config/lexicon/serve.json` (mode 0600, next to your
global lexicon; follows `LEXICON_PATH` and `XDG_CONFIG_HOME`):

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

Every request except `GET /health` needs `Authorization: Bearer <token>`.
Requests and responses are JSON (`Content-Type: application/json`) unless
noted. Errors are `{ "error": "<message>" }`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | | `{ ok: true, version, terms, projectTrust?, port }` (no auth) |
| POST | `/normalize` | `{ text, dryRun?, minConfidence?, cwd? }` | `NormalizeResult` (`input`, `output`, `replacements[]`, `changed`) plus `summary` |
| POST | `/learn` | `{ heard, meant, scope? , cwd? }` | `{ term, created, aliasAdded, path }` |
| POST | `/add` | `{ canonical, aliases?, phonetic?, category?, notes?, never?, scope?, cwd? }` | `{ term, path, created }` |
| GET | `/lexicon` | | `{ lexicon, paths: { global, project? }, projectTrust?, skippedProject? }` |
| GET | `/export/:format` | | the export as text; `Content-Type` per format (see below) |
| GET | `/stats` | | `LexiconStats` |

Status codes: 400 invalid JSON or a bad field, 401 missing or wrong token,
403 a project-scope write into an untrusted `.lexicon.yaml`, 404 unknown
route or export format, 405 wrong method, 413 body over 1 MB, 503 more than
64 requests in flight.

`cwd` picks which project `.lexicon.yaml` is considered (body field on POST,
`?cwd=` on GET). It defaults to the directory the server was started in. An
untrusted project file is never merged; `/health` and `/lexicon` report
`projectTrust: "untrusted"` and `/lexicon` names the skipped file by path.

Export content types: `csv` -> `text/csv`, `json` (also `superwhisper`,
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

## Raycast script command

Save as `~/raycast-scripts/fix-dictation.sh`, `chmod +x`, and add the folder
under Raycast > Extensions > Script Commands. It corrects the clipboard in
place and shows the diff summary.

```bash
#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Fix dictation
# @raycast.mode compact
# @raycast.packageName Lexicon

# Optional parameters:
# @raycast.icon 🎙️
# @raycast.description Correct the clipboard with your lexicon (lexicon serve)

set -euo pipefail

CONFIG="${LEXICON_SERVE_JSON:-$HOME/.config/lexicon/serve.json}"
TOKEN=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token' "$CONFIG")
PORT=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port' "$CONFIG")

BODY=$(pbpaste | node -pe 'JSON.stringify({ text: require("fs").readFileSync(0, "utf8") })')
RESPONSE=$(curl -sS --max-time 3 -X POST "http://127.0.0.1:${PORT}/normalize" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  --data-binary "$BODY")

printf '%s' "$RESPONSE" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (r.error) { console.log("lexicon: " + r.error); process.exit(1); }
  if (!r.changed) { console.log("no changes"); process.exit(0); }
  require("child_process").execFileSync("pbcopy", { input: r.output });
  console.log(r.summary.split("\n").join("; "));
'
```

Pair it with a Raycast hotkey to run right after dictating; add `--paste`
behaviour with `osascript -e 'tell application "System Events" to keystroke "v" using command down'`
at the end if you want the corrected text pasted automatically (needs
Accessibility permission for Raycast).

## Embedding

The server is a plain `node:http` server behind one function:

```ts
import { createServer } from './dist/serve/index.js'; // src/serve/index.js in-repo; not a package subpath export yet

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
beyond that. See `SECURITY.md`.
