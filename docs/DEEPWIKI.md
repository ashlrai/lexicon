# DeepWiki configuration

[.devin/wiki.json](../.devin/wiki.json) guides DeepWiki's generated overview
and subsystem pages. The notes identify source-of-truth files and boundaries;
the page list supplies titles, purposes and parent relationships. Generated
content can be stale or incorrect, so check claims against the source.

For another repository, copy the config, rewrite the notes for its layout and
replace the pages with its actual subsystems. Keep titles unique and make each
parent refer to an existing page. Do not put secrets, personal transcripts or
machine-specific paths in notes. The config alone does not enable indexing or
establish an update schedule; configure repository access in DeepWiki as needed.

Run `npx vitest run tests/deepwiki-config.test.ts` after editing the config.
