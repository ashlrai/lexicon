# Aliases endpoint examples

`GET /aliases` generates possible speech-to-text spellings for a name. The
required `canonical` query parameter is the correct spelling to generate from;
URL-encode its value, including spaces. Supply it once, with no other query
parameters. The endpoint suggests aliases without looking up stored aliases or
writing to the lexicon. Review the suggestions before using them.

Start `lexicon serve` and prepend its base URL (normally
`http://127.0.0.1:41733`) to each request target below. Send
`Authorization: Bearer <token>` with every request. See the [local HTTP API
guide](LOCAL-API.md) for setup and `lexicon serve --show` for the configured
URL and token.

## Name containing a space

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

The response contains the cleaned `canonical` string and an `aliases` array
of suggestions, which can be empty. These are generated suggestions, not
stored aliases.

## Cleaning the input

The server strips invisible characters and trims surrounding whitespace before
validation. Here `%E2%80%8B` encodes a zero-width space:

```http
GET /aliases?canonical=%20Ashlr%E2%80%8B.AI%20
```

HTTP 200:

```json
{"canonical":"Ashlr.AI","aliases":["Ashlr AI","Ashlr","Ashler","Ashlar","Ashler AI","Ashlar AI"]}
```

## No suggestions

```http
GET /aliases?canonical=Bob
```

HTTP 200:

```json
{"canonical":"Bob","aliases":[]}
```

## Missing canonical

An omitted value, or one empty after cleaning, returns an error:

```http
GET /aliases
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

## Unsupported query parameter

```http
GET /aliases?canonical=Vercel&limit=3
```

HTTP 400:

```json
{"error":"unknown query parameter \"limit\" (GET /aliases takes canonical)"}
```

Repeated parameters also return 400. After cleaning, a canonical may contain
at most 80 UTF-16 code units and cannot contain control characters, newlines,
U+FFFE, U+FFFF or unpaired surrogates. A missing or invalid bearer token returns
401 with `WWW-Authenticate: Bearer`. See the [aliases API examples](aliases-api-examples.md)
for more validation cases and the [contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
for the full behavior.
