# Using Lexicon with Phantom

Lexicon makes no model calls. It has no API key, no model provider, and no gateway or base URL setting, so there is nothing for Phantom Secrets to proxy and nothing to point at a model gateway.

## Running under `phantom exec`

`phantom exec -- <cmd>` starts `<cmd>` with `phm_` session placeholders in place of real provider keys, and points provider base URLs at a local Phantom proxy that swaps in the real key on the way out. When the command is your coding agent, for example `phantom exec -- claude`, the Lexicon hook, MCP server and CLI the agent runs work the same as without Phantom. Lexicon does not read any provider key variable, so it never sees the placeholders, and it needs no `phm_` value or `phm:` reference of its own.

You do not need to wrap `lexicon` itself in `phantom exec`. Doing so is harmless.

## What Lexicon does send over the network

None of these calls uses a provider key:
- **`lexicon pack` with `--registry <url>`:** fetches a pack index and pack files over `https://` only, or plain `http://` only from this machine.
- **`lexicon voice`:** downloads its Whisper model (`base.en` by default, or the name passed to `--model`) from Hugging Face (`https://huggingface.co/ggerganov/whisper.cpp`) when it is not already on disk. A model given as a file path is never downloaded.
- **`lexicon import --guided` and the MCP `import_vocabulary` tool, GitHub source only:** run the `gh` CLI, which calls `api.github.com` with your existing `gh` login (your profile, org members and repo names). Lexicon reads no GitHub token itself, and the contacts and calendar sources read local files only.
- **`lexicon serve`:** listens on `127.0.0.1`, port 41733 by default ([LOCAL-API.md](LOCAL-API.md)). `--host` can bind another interface, which exposes the API to the network; leave it at the default.

## The `lexicon serve` token

`lexicon serve` keeps its own bearer token in `serve.json` (mode 0600, next to your global lexicon). It is a local token for the loopback API, not a provider key, and Phantom does not manage it.
- Do not paste it into an agent prompt or a shared file. Tools that need it read it from `serve.json` or pair through `lexicon serve --pair`.
- Do not use `phantom reveal` for anything Lexicon needs. Lexicon has no Phantom-stored secret.

## LiteLLM

Not applicable. Lexicon sends no model requests, so a LiteLLM proxy has nothing to route for it. If your agent uses LiteLLM, follow the agent's or gateway's own guidance.

## See also

- [INTEGRATION.md](../INTEGRATION.md) - the wider contract Phantom would integrate against (the lexicon file, the trust gate, the normalize entry points).
- [LOCAL-API.md](LOCAL-API.md) - the loopback API behind the `serve.json` token.
- [SECURITY.md](../SECURITY.md) - the threat model both of those live under.

Back to [the docs index](README.md).
