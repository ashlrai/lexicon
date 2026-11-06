# Support

Where to go for help with `@ashlr/lexicon`, depending on what you need.

## Ask a question

- Setup, clients, or how a feature works: check the [FAQ](docs/FAQ.md) and the [quickstart](docs/QUICKSTART.md) first.
- Anything else: start a thread in [GitHub Discussions](https://github.com/ashlrai/lexicon/discussions). Discussions keep answers searchable for the next person.

Please do not open an issue for a usage question. Issues are for bugs and for specific, scoped work.

## Report a bug

Open a [bug report](https://github.com/ashlrai/lexicon/issues/new?template=bug_report.yml). Include:

- the version (`lexicon --version`) and your Node version;
- the command or client you were using, and what you expected;
- the output of `lexicon doctor` if the problem is in setup or in corrections not happening;
- the smallest input that reproduces it (a dictated phrase is enough).

If speech-to-text writes a name the lexicon does not correct, use the [misheard term issue](https://github.com/ashlrai/lexicon/issues/new?template=misheard_term.yml) form instead. It takes the canonical spelling and what your engine actually wrote.

## Report a security issue

Do not open a public issue or discussion for a vulnerability. Follow the private reporting steps in [SECURITY.md](SECURITY.md#reporting-a-vulnerability), which cover the contact address and what to include. The threat model there also explains which behaviors are deliberate, such as the trust gate on project lexicons.

## Contribute a fix or a new term pack

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the test layout and a recipe for each common kind of change. Everyone taking part in issues, discussions and pull requests follows the [Code of Conduct](CODE_OF_CONDUCT.md).
