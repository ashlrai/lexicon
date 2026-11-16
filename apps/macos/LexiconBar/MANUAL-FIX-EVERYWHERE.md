# Fix everywhere manual checklist

Run on a Mac with LexiconBar and the matching `lexicon serve` release installed.
In onboarding, grant Accessibility yourself once in System Settings. Enable Fix
everywhere and the correction bubble. Add an alias with a context-gated term;
keep a separate ordinary alias for the basic checks.

For each row, focus an editable composer, insert a dictation-sized burst with
the ordinary alias, and confirm the correction and bubble appear. Click Undo
and confirm the exact original text returns. Repeat with a context-gated alias
after its context word in the existing field, then without that context word;
only the first should be corrected. Try a middle-of-text insertion as well.

| Application | Composer checked | Correction | Bubble Undo | Context |
| --- | --- | --- | --- | --- |
| Mail | Compose body | [ ] | [ ] | [ ] |
| Messages | Message field | [ ] | [ ] | [ ] |
| Grok Bot app | Message field | [ ] | [ ] | [ ] |
| Phantom | Message field | [ ] | [ ] | [ ] |
| Electron app | Editable field | [ ] | [ ] | [ ] |
| Chrome | Text field and contenteditable | [ ] | [ ] | [ ] |

Also check that a secure field and an excluded app are untouched, disabling Fix
everywhere stops corrections, and editing or changing focus before a response
does not overwrite newer text. Record app versions and any failures in the PR.
