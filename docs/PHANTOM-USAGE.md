# Using Lexicon with Phantom

Lexicon makes no model calls. It has no API key, no model provider, and no gateway or base URL setting, so there is nothing for Phantom Secrets to proxy and nothing to point at a model gateway.

## Running under `phantom exec`

`phantom exec -- <cmd>` starts `<cmd>` with `phm_` session placeholders in place of real provider keys, and points provider base URLs at a local Phantom proxy that swaps in the real key on the way out. When the command is your coding agent, for example `phantom exec -- claude`, the Lexicon hook, MCP server and CLI the agent runs work the same as without Phantom. Lexicon does not read any provider key variable, so it never sees the placeholders, and it needs no `phm_` value or `phm:` reference of its own.

You do not need to wrap `lexicon` itself in `phantom exec`. Doing so is harmless.

## What Lexicon does send over the network

None of these calls uses a provider key:
- **`lexicon pack` with `--registry <url>`:** fetches a pack index and pack files over `https://` only, or plain `http://` only from this machine.
- **Voice model downloads:** fetch Whisper models from Hugging Face (`https://huggingface.co/ggerganov/whisper.cpp`).
- **`lexicon serve`:** listens on `http://127.0.0.1:41733` only ([LOCAL-API.md](LOCAL-API.md)).

## The `lexicon serve` token

`lexicon serve` keeps its own bearer token in `serve.json` (mode 0600, next to your global lexicon). It is a local token for the loopback API, not a provider key, and Phantom does not manage it.
- Do not paste it into an agent prompt or a shared file. Tools that need it read it from `serve.json` or pair through `lexicon serve --pair`.
- Do not use `phantom reveal` for anything Lexicon needs. Lexicon has no Phantom-stored secret.

## LiteLLM

Not applicable. Lexicon sends no model requests, so a LiteLLM proxy has nothing to route for it. If your agent uses LiteLLM, follow the agent's or gateway's own guidance.
