# Alias suggestions for onboarding

An onboarding form can use the local API's `GET /aliases` endpoint to suggest
spellings that speech-to-text may produce for a name. Ask for the correct
spelling first, then send it as the required `canonical` query parameter. The
endpoint generates suggestions; it does not look up stored aliases or write a
term to the lexicon.

Start `lexicon serve` and send `Authorization: Bearer <token>` with the
request. The default base URL is `http://127.0.0.1:41733`. See the [local API
guide](LOCAL-API.md) for server and client setup.

For example, URL-encode the name `Mason Wyatt`:

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

The response contains the cleaned `canonical` and an `aliases` array of
suggestions, which can be empty. Show the suggestions for review before saving.
To save a term and the chosen suggestions, send a separate `POST /add` with
`canonical` and the selected `aliases` in its JSON body. Send `aliases: []` if
none were selected: omitting `aliases` generates suggestions automatically for
a newly created term. See [POST /add](LOCAL-API.md#endpoints) for its other
fields and write behavior.

`canonical` is the only accepted query parameter and may appear only once. The
server strips invisible characters and surrounding whitespace before validation.
An empty value, a value over 80 UTF-16 code units, or a value containing a
remaining control character, U+FFFE, U+FFFF or an unpaired surrogate returns
HTTP 400. A missing or invalid bearer token returns HTTP 401. See the
[aliases response reference](aliases-response-reference.md) for response and
error examples, and the [contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
for the complete API behavior.
