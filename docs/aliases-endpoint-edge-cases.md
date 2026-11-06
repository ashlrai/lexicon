# Alias suggestion edge cases

`GET /aliases` generates possible speech-to-text spellings from the supplied
canonical name. Start `lexicon serve`, prepend its base URL (normally
`http://127.0.0.1:41733`) to the request targets below, and send
`Authorization: Bearer <token>`. See the [local API guide](LOCAL-API.md) for
setup. These examples assume a valid token and otherwise valid requests.

## Missing or empty canonical

The server strips invisible characters, then trims surrounding whitespace.
An omitted `canonical`, an empty value, or a value that becomes empty after
cleaning returns HTTP 400 with the same error. For example:

```http
GET /aliases
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

```http
GET /aliases?canonical=%20%E2%80%8B%20
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

The encoded value contains spaces and a zero-width space. Supply one nonempty
`canonical` query parameter, URL-encoded, and no other query parameters.

## Canonical not in the lexicon

An unknown canonical is still valid: the endpoint generates suggestions from
the cleaned name rather than looking up stored terms. It neither adds the
name nor returns aliases saved for it. For example, even with an empty lexicon:

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

Some names produce no suggestions:

```http
GET /aliases?canonical=Bob
```

HTTP 200:

```json
{"canonical":"Bob","aliases":[]}
```

An empty array does not establish whether a term exists. The contract does not
specify which suggestions any arbitrary name must produce or promise that a
name will have suggestions; these examples show current results, not a lookup
or an exhaustive list. Review generated suggestions before saving them.

The [endpoint contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
also specifies length and character validation, authentication, and shared
HTTP errors. See the [API examples](aliases-api-examples.md) for those cases.
