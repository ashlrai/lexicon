# GET /aliases response reference

`GET /aliases` generates likely speech-to-text spellings for a canonical name.
It does not read stored aliases or add a term. Review suggestions before using
them. Start `lexicon serve` and send the bearer token as described in the
[local HTTP API guide](LOCAL-API.md). The default base URL is
`http://127.0.0.1:41733`.

## Request

The required `canonical` query parameter is the correct spelling of the name
to suggest aliases for. URL-encode its value, including spaces. The endpoint
accepts one `canonical` parameter and no other query parameters.

```http
GET /aliases?canonical=Mason%20Wyatt
```

Send `Authorization: Bearer <token>` with the request. The server strips
invisible characters and trims surrounding whitespace before validating the
name. The cleaned value must be nonempty and at most 80 characters; remaining
control characters, U+FFFE, U+FFFF and unpaired surrogates are rejected.

## Response

HTTP 200 (`application/json; charset=utf-8`):

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

`canonical` is the cleaned name. `aliases` is an array of generated
suggestions, which can be empty. These are suggestions for the supplied name,
not the aliases stored in a lexicon.

For example, omitting the required parameter returns:

```http
GET /aliases
```

HTTP 400:

```json
{"error":"canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)"}
```

See the [aliases API examples](aliases-api-examples.md) for more inputs and
validation errors, and the [contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
for the full API.
