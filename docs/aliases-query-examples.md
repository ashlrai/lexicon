# Aliases query examples

`GET /aliases` generates possible speech-to-text spellings from a canonical
name. Start `lexicon serve`, prepend its base URL (normally
`http://127.0.0.1:41733`) to the request targets below, and send
`Authorization: Bearer <token>`. See the [local API guide](LOCAL-API.md) for
setup and obtaining the token.

Supply `canonical` once and URL-encode its value. For a name with a space:

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

The JSON response contains `canonical`, the cleaned name, and `aliases`, an
array of generated suggestions. The server strips invisible characters and
trims surrounding whitespace before validation. Suggestions are not stored
aliases, and this request does not add a term. Review them before use. The
array can be empty:

```http
GET /aliases?canonical=Bob
```

HTTP 200:

```json
{"canonical":"Bob","aliases":[]}
```

A missing or blank canonical returns HTTP 400 with an `error` string:

```http
GET /aliases
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

Repeated or unknown query parameters are rejected. See the [endpoint
contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
for validation rules and the [API examples](aliases-api-examples.md) for more
requests and errors.
