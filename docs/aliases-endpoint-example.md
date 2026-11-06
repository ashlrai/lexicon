# Alias suggestions during onboarding

An onboarding form can ask for the correct spelling of a name and use
`GET /aliases?canonical=X` to suggest spellings that speech-to-text may
produce. Review the suggestions with the user before saving them. This request
generates suggestions; it does not look up stored aliases or change the lexicon.

Start `lexicon serve` and send the request to its base URL (by default
`http://127.0.0.1:41733`) with `Authorization: Bearer <token>`. URL-encode the
required `canonical` query parameter. For the name `Mason Wyatt`:

```http
GET /aliases?canonical=Mason%20Wyatt
```

HTTP 200:

```json
{"canonical":"Mason Wyatt","aliases":["Mason Wiatt","Mason Wyat"]}
```

The response contains the cleaned canonical spelling and suggested aliases;
the array can be empty. See the [contract](CONTRACT.md#srcserve-configts-serverts-indexts-and-srcclicmd-servets)
for validation and the [local API guide](LOCAL-API.md) for setup and saving a
term.
