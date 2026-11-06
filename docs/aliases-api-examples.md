# GET /aliases examples

`GET /aliases` suggests spellings that speech-to-text might produce for a
canonical name. It generates suggestions from the supplied name; it does not
look up stored aliases or add anything to the lexicon. Review the suggestions
before using them. See the [local HTTP API guide](LOCAL-API.md) for starting the
server and client setup, and the [contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets) for the full API.

Start `lexicon serve` and send `Authorization: Bearer <token>` with each
request below. The default base URL is `http://127.0.0.1:41733`; use the URL
and token shown by `lexicon serve --show` if configured differently. The
examples show request targets, so prepend the base URL. URL-encode the value
of `canonical` (for example, `encodeURIComponent(name)` in JavaScript).
The endpoint accepts only one `canonical` query parameter.

## Successful requests

A name containing a space:

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

The server strips invisible characters and trims surrounding whitespace before
validation and suggestion. Here `%E2%80%8B` is a zero-width space:

```http
GET /aliases?canonical=%20Ashlr%E2%80%8B.AI%20
```

HTTP 200:

```json
{"canonical":"Ashlr.AI","aliases":["Ashlr AI","Ashlr","Ashler","Ashlar","Ashler AI","Ashlar AI"]}
```

There may be no suggestions:

```http
GET /aliases?canonical=Bob
```

HTTP 200:

```json
{"canonical":"Bob","aliases":[]}
```

A successful JSON response has two fields:

- `canonical` is the cleaned name as a string, which can differ from the input.
- `aliases` is an array of generated strings in suggestion order. It can be
  empty and contains at most eight suggestions. Suggestions are not the stored
  aliases, and the canonical itself is excluded case-insensitively.

## Invalid requests

A missing or blank name (including one that is blank after cleaning) is rejected:

```http
GET /aliases
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

Control characters inside the cleaned name are rejected. This example encodes
an embedded newline; whitespace at the ends is trimmed first:

```http
GET /aliases?canonical=Ashlr%0AAI
```

HTTP 400:

```json
{"error":"canonical must not contain control characters or newlines"}
```

U+FFFE and U+FFFF are rejected:

```http
GET /aliases?canonical=Ash%EF%BF%BE
```

HTTP 400:

```json
{"error":"canonical must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format)"}
```

Unknown query parameters and repeated `canonical` parameters are rejected:

```http
GET /aliases?canonical=Vercel&limit=3
```

HTTP 400:

```json
{"error":"unknown query parameter \"limit\" (GET /aliases takes canonical)"}
```

```http
GET /aliases?canonical=Bob&canonical=Vercel
```

HTTP 400:

```json
{"error":"query parameter \"canonical\" given more than once"}
```

After cleaning, names longer than 80 UTF-16 code units are rejected. This
name contains 81 `a` characters:

```http
GET /aliases?canonical=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

HTTP 400:

```json
{"error":"canonical must be at most 80 characters"}
```

Validation also rejects C0 and C1 controls, DEL, U+2028, U+2029 and unpaired
surrogates that reach it. Errors have a string `error` field. A missing or
invalid bearer token returns HTTP 401 with `WWW-Authenticate: Bearer`; use
`lexicon serve --show` for a manual client or `lexicon serve --pair` for the
browser extension. `HEAD` accepts the same query and returns the GET status
and headers without a body. See the [local HTTP API guide](LOCAL-API.md) for
other shared HTTP errors and headers.
