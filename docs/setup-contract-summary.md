# Guided first-run contract summary

This page summarizes the current [setup contract](CONTRACT.md#srcclicmd-setupts)
for maintainers. The contract is the source for exact options, return shapes and
edge cases; this page is not a new specification. The questions below are prompts
for future investigation, not commitments or claims that behavior is missing.

## Documented responsibilities

`lexicon setup` guides a first run through seven steps and then reports what
happened:

1. **Global lexicon.** Create it if missing and seed a person and company when
   available. Suggestions use Git and package identity; the user can provide
   names explicitly. Existing names are not duplicated, and an established
   lexicon is not reseeded with guessed defaults unless requested.
2. **Starter packs.** Offer a checklist on a terminal. A non-interactive run
   installs no packs unless they are explicitly selected.
3. **Repository harvest.** Offer candidate names from a Git repository and
   exclude names already covered globally. Interactive confirmation defaults to
   no; non-interactive harvest requires an explicit request. A normal CLI write
   uses the project trust gate. The MCP flow can leave a new, untrusted or
   changed project file untrusted and directs the user to review it.
4. **Agent clients.** Detect clients or use the supplied selection, then install
   the chosen integrations and report each result. On a terminal, detected
   clients are preselected; a non-interactive CLI run selects detected clients
   unless a list is supplied. The MCP tool instead installs no clients when its
   list is omitted or empty.
5. **Local API.** Offer a login service on supported platforms. A terminal
   confirmation defaults to yes; a non-interactive run requires an explicit
   request. Report an installation failure or a platform skip.
6. **Dictation app export.** Offer an export for a supported app; the
   non-interactive default is none. Preserve a differing existing export unless
   the user confirms replacement, choosing an available numbered file instead.
7. **Demonstration.** Show a dictated phrase and its correction using the user's
   terms when possible. Otherwise identify the built-in example as an example;
   it is not added to the user's lexicon.

The final card reports the lexicon path, additions, packs, clients, service and
exports, plus a next action. Invalid supplied names and phonetic hints are
refused before any step writes. A closed prompt or a step failure stops the run
and reports completed work and a way to resume. Client and service installation
failures are reported while the remaining steps run, with a failing exit code.

## Preview and agent responsibilities

`lexicon setup --dry-run` writes nothing and asks nothing. Its plan describes the
corresponding real run, including questions, default outcomes, detected clients,
proposed exports and any service blocker. Packs on offer are distinct from packs
the run would actually install. The plan provides a command to apply it. JSON
mode puts the plan or summary on stdout and reports failure through `ok` and the
exit code.

The MCP `setup_lexicon` tool previews by default and asks the agent to show the
plan before calling it with `apply: true`. Applying installs only the clients named in the request; an omitted or empty
client list installs nothing, and harvest or the service runs only when explicitly
enabled. Applying does not
implicitly trust a project file: the response names a file needing review and a
separate trust decision. The `onboard` prompt asks for exact names and client
choices and ends with a sentence to dictate. See the [MCP contract](CONTRACT.md)
for the tool and prompt details.

## Open questions

These are review questions raised by this summary. The setup contract does not
answer them as product decisions, and they do not change the behavior above.

- How should setup measure whether a user successfully used a correction in a
  real client after the demonstration?
- When client detection finds multiple installations or ambiguous evidence,
  what information would help a user choose the intended integration?
- What recovery guidance best helps users reconcile a partially completed setup
  across clients, service installation and exports?
- What additional accessibility or localization requirements should the guided
  prompts and demonstration meet?
