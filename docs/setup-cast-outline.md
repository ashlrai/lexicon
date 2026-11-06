# Setup cast recording outline

A reproducible terminal recording of the current source-checkout setup wizard:
show a viewer how a misspelled name becomes a useful correction. This is a
recording plan, not a finished cast. Allow roughly two minutes, plus build time.
The example person, Avery Example, is fictional; Ashlr.AI is the public product
name. Do not use real names, contacts, transcripts, account details or secrets.

## Prepare off camera

Use a disposable POSIX shell on macOS or Linux, Node 20 or newer, and a checkout
with dependencies installed. From the checkout root, build the current CLI:

```sh
npm install
npm run build
```

In that same shell, set up the isolated recording environment before starting
the recorder. Use a clean terminal profile with a neutral prompt, title and
working directory display; hide notifications. The directory is outside the
checkout so setup cannot harvest or infer its project metadata. The explicit
person avoids reading a Git user name. Paths and exact output may vary.

```sh
cast_cli="$PWD/dist/cli/index.js"
cast_home=$(mktemp -d)
export HOME="$cast_home" XDG_CONFIG_HOME="$cast_home/.config" LEXICON_PATH="$cast_home/lexicon.yaml"
cd "$cast_home"
```

Start a terminal recorder such as asciinema in this shell, saving its output
outside the temporary home. Record a terminal with both input and output attached
to a TTY; a pipe or redirected output causes setup to use defaults instead of
asking questions. Leave the isolation commands and absolute paths off camera.

## Recording sequence

1. Introduce the problem: dictation can turn a product name into a different
   spelling. Run the current setup command, disabling optional integrations for
   this isolated demonstration:

   ```sh
   node "$cast_cli" setup --person "Avery Example" --clients none --no-packs --no-harvest --no-serve --app none
   ```

2. In **Global lexicon**, answer these representative prompts as they appear:

   | Prompt | Answer |
   |---|---|
   | Your company or product name | `Ashlr.AI` |
   | phonetic hint | `ASH-ler` |
   | add another term? | `n` |

   The person and company are added to the temporary lexicon. The explicit flags
   skip packs, repo harvest, client registration, the login service and dictation
   export, so their questions do not appear. Point out those skipped steps rather
   than implying this run configured an agent.

3. Pause on **Does it work?** and the `you dictate`, `your agent sees`, and
   `fixed` lines. The wizard constructs the example from the terms it just
   seeded. Then show a separate correction against the saved lexicon:

   ```sh
   node "$cast_cli" normalize "ping Ashler about the launch"
   ```

   Expected output: `ping Ashlr.AI about the launch`. This is a CLI demonstration;
   a real agent needs its own client registration. End with the summary and
   direct viewers to [QUICKSTART.md](QUICKSTART.md) and [CLIENTS.md](CLIENTS.md).

## Review and reset

Stop recording before cleanup. Replay the entire cast, including terminal title,
scrollback and any recorder metadata, and discard and re-record it if it contains
personal data, credentials or local paths. Check that the prompt answers, skipped
integrations and corrected output are legible. To repeat, leave the temporary
home and delete only the directory created above:

```sh
cd /
rm -rf "$cast_home"
```

Keep the cast outside that directory if it is to be retained. For an actual
client installation, use the normal instructions in [QUICKSTART.md](QUICKSTART.md).
