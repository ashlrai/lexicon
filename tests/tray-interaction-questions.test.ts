import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/tray-interaction-questions.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('tray interaction questions', () => {
  it('connects the issue, companion documents and index without presenting questions as shipped', () => {
    expect(index).toContain('[tray-interaction-questions.md](tray-interaction-questions.md)');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/13');
    expect(doc).toContain('[platform scope](tray-platform-scope.md)');
    expect(doc).toContain('[action map](tray-action-map.md)');
    expect(doc).toMatch(/not a specification or a claim that the proposed\s+interactions are implemented/);
    expect(doc).toMatch(/Windows tray has Fix clipboard[\s\S]*no tray push-to-talk/);
    expect(doc).toMatch(/unverified\s+on a real Windows desktop\. Linux has no tray app/);
  });

  it('records interaction and platform questions with the current command boundaries', () => {
    expect(doc).toMatch(/voice --toggle --paste[\s\S]*first toggle[\s\S]*stop call uses its own options/);
    expect(doc).toMatch(/daemon --once --paste[\s\S]*manual paste/);
    expect(doc).toMatch(/exit code of 0[\s\S]*not that a transcript is ready/);
    expect(doc).toMatch(/failed copy[\s\S]*intermediate recording status/);
    expect(doc).toMatch(/clipboard or target changes[\s\S]*paste is\s+blocked/);
    expect(doc).toMatch(/\*\*Windows:\*\*[\s\S]*RegisterHotKey[\s\S]*SendInput/);
    expect(doc).toMatch(/\*\*Linux:\*\*[\s\S]*X11 and Wayland[\s\S]*desktop environment/);
    expect(doc).toMatch(/real target application[\s\S]*lexicon stats[\s\S]*verified paste/);
  });

  it('covers shared state, trust, delivery races and observable desktop outcomes', () => {
    expect(doc).toMatch(/voice --status[\s\S]*another terminal or shortcut/);
    expect(doc).toMatch(/working directory[\s\S]*project\s+trust gate/);
    expect(doc).toMatch(/intermediate status[\s\S]*pasting the old clipboard/);
    expect(doc).toMatch(/Clipboard or focus changes[\s\S]*manual paste/);
    expect(doc).toMatch(/Two actions overlap[\s\S]*clipboard contents remain/);
    expect(doc).toMatch(/Sending input alone cannot establish[\s\S]*target\s+accepted it/);
    expect(doc).toMatch(/final clipboard, actual target\s+result[\s\S]*hit was counted/);
    expect(doc).toMatch(/without including real\s+transcripts or clipboard contents/);
  });
});
