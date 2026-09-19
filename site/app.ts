/**
 * Browser demo for @ashlr/lexicon (https://ashlrai.github.io/lexicon/).
 *
 * Runs the same matcher, schema and exporters the CLI and MCP server use,
 * bundled by scripts/build-site.mjs. Everything happens on this page: the
 * only network activity is the optional font stylesheet in index.html. The
 * "Dictate" button hands audio to the browser's own speech recognizer, which
 * on Chrome is a remote service; the page itself never sends anything.
 *
 * Only browser-safe core modules may be imported here (no store/harvest/trust,
 * they use node:fs). The build script fails if a node: builtin slips in.
 */
import { isMap, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import { EXPORT_FORMATS, EXPORT_FORMAT_INFO, exportLexicon } from '../src/core/exporters/index.js';
import { DEFAULT_MIN_CONFIDENCE } from '../src/core/matcher.js';
import { normalize } from '../src/core/normalize.js';
import { emptyLexicon, parseLexicon } from '../src/core/schema.js';
import { suggestAliases } from '../src/core/suggest.js';
import type { ExportFormat, Lexicon, NormalizeResult } from '../src/core/types.js';
import exampleYaml from '../examples/lexicon.example.yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_SENTENCE =
  'tell ashler to deploy cooper netties on head sner with pie dantic and ping mason white about the sass pricing';

const STORAGE = {
  input: 'lexicon-demo.input',
  yaml: 'lexicon-demo.yaml',
  settings: 'lexicon-demo.settings',
} as const;

const DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------------
// Minimal Web Speech API surface (lib.dom does not ship the constructor).
// ---------------------------------------------------------------------------

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult extends ArrayLike<SpeechAlternative> {
  isFinal: boolean;
}
interface SpeechResultEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface SpeechErrorEvent extends Event {
  error?: string;
}
interface SpeechRecognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

function speechRecognizerCtor(): SpeechRecognizerCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognizerCtor;
    webkitSpeechRecognition?: SpeechRecognizerCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`site: missing #${id}`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

function loadItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or quota exceeded: the page works without persistence.
  }
}

/** Briefly swap a button's label (e.g. "Copy" -> "Copied"). */
function flash(button: HTMLButtonElement, label: string): void {
  const original = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = original;
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall back to the legacy path for non-secure contexts (plain http://).
    const area = el('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Settings {
  phonetic: boolean;
  fuzzy: boolean;
  minConfidence: number;
  format: ExportFormat;
}

interface State {
  input: string;
  yaml: string;
  /** The last lexicon that parsed; kept while the YAML pane has errors. */
  lexicon: Lexicon;
  lexiconError: string | null;
  settings: Settings;
}

function loadSettings(): Settings {
  const defaults: Settings = {
    phonetic: true,
    fuzzy: true,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    format: 'wispr',
  };
  const raw = loadItem(STORAGE.settings);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      phonetic: typeof parsed.phonetic === 'boolean' ? parsed.phonetic : defaults.phonetic,
      fuzzy: typeof parsed.fuzzy === 'boolean' ? parsed.fuzzy : defaults.fuzzy,
      minConfidence:
        typeof parsed.minConfidence === 'number' && parsed.minConfidence >= 0.7 && parsed.minConfidence <= 0.95
          ? parsed.minConfidence
          : defaults.minConfidence,
      format:
        typeof parsed.format === 'string' && (EXPORT_FORMATS as readonly string[]).includes(parsed.format)
          ? (parsed.format as ExportFormat)
          : defaults.format,
    };
  } catch {
    return defaults;
  }
}

type Compiled = { lexicon: Lexicon; error: null } | { lexicon: null; error: string };

function compileLexicon(text: string): Compiled {
  try {
    const raw: unknown = parseYaml(text, { prettyErrors: true });
    return { lexicon: parseLexicon(raw), error: null };
  } catch (err) {
    return { lexicon: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const initialYaml = loadItem(STORAGE.yaml) ?? exampleYaml;
const initialCompiled = compileLexicon(initialYaml);

const state: State = {
  input: loadItem(STORAGE.input) ?? DEMO_SENTENCE,
  yaml: initialYaml,
  lexicon: initialCompiled.lexicon ?? emptyLexicon(),
  lexiconError: initialCompiled.error,
  settings: loadSettings(),
};

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const ui = {
  input: $<HTMLTextAreaElement>('input'),
  dictate: $<HTMLButtonElement>('dictate'),
  interim: $<HTMLParagraphElement>('interim'),
  speechNote: $<HTMLParagraphElement>('speech-note'),
  resetInput: $<HTMLButtonElement>('reset-input'),
  clearInput: $<HTMLButtonElement>('clear-input'),
  optPhonetic: $<HTMLInputElement>('opt-phonetic'),
  optFuzzy: $<HTMLInputElement>('opt-fuzzy'),
  optMinConf: $<HTMLInputElement>('opt-minconf'),
  optMinConfOut: $<HTMLOutputElement>('opt-minconf-out'),

  output: $<HTMLDivElement>('output'),
  diff: $<HTMLUListElement>('diff'),
  stats: $<HTMLSpanElement>('stats'),

  yaml: $<HTMLTextAreaElement>('yaml'),
  yamlError: $<HTMLPreElement>('yaml-error'),
  yamlStatus: $<HTMLSpanElement>('yaml-status'),
  resetYaml: $<HTMLButtonElement>('reset-yaml'),
  addTerm: $<HTMLFormElement>('add-term'),
  canonical: $<HTMLInputElement>('canonical'),
  aliases: $<HTMLInputElement>('aliases'),
  suggestions: $<HTMLDivElement>('suggestions'),
  useSuggestions: $<HTMLButtonElement>('use-suggestions'),
  addError: $<HTMLParagraphElement>('add-error'),
  format: $<HTMLSelectElement>('format'),
  formatInfo: $<HTMLSpanElement>('format-info'),
  copyExport: $<HTMLButtonElement>('copy-export'),
  downloadExport: $<HTMLButtonElement>('download-export'),
  exportPreview: $<HTMLPreElement>('export-preview'),
  copyInstall: $<HTMLButtonElement>('copy-install'),
};

// ---------------------------------------------------------------------------
// Output panel
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

function renderOutput(result: NormalizeResult): void {
  ui.output.replaceChildren();
  if (result.input.trim().length === 0) {
    ui.output.append(el('span', 'placeholder', 'Type or dictate something on the left.'));
    return;
  }
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const r of result.replacements) {
    if (r.start > cursor) frag.append(document.createTextNode(result.input.slice(cursor, r.start)));
    const mark = el('mark', `hit hit-${r.reason}`, r.replacement);
    const tip = `${r.original} → ${r.replacement} (${r.reason}, ${r.confidence.toFixed(2)})`;
    mark.dataset.tip = tip;
    mark.setAttribute('aria-label', tip);
    mark.tabIndex = 0;
    frag.append(mark);
    cursor = r.end;
  }
  if (cursor < result.input.length) frag.append(document.createTextNode(result.input.slice(cursor)));
  ui.output.append(frag);
}

function renderDiff(result: NormalizeResult): void {
  ui.diff.replaceChildren();
  if (result.replacements.length === 0) {
    const li = el('li', 'diff-empty', result.input.trim() ? 'No changes. Nothing in the text matched the lexicon.' : '');
    ui.diff.append(li);
    return;
  }
  for (const r of result.replacements) {
    const li = el('li', 'diff-row');
    li.append(
      el('span', 'diff-from', r.original),
      el('span', 'diff-arrow', '→'),
      el('span', 'diff-to', r.replacement),
      el('span', `badge badge-${r.reason}`, r.reason),
      el('span', 'diff-conf', r.confidence.toFixed(2)),
    );
    ui.diff.append(li);
  }
}

function renderStats(result: NormalizeResult, ms: number): void {
  const n = result.replacements.length;
  if (result.input.trim().length === 0) {
    ui.stats.textContent = '';
    return;
  }
  ui.stats.textContent = `${n} ${n === 1 ? 'correction' : 'corrections'} · ${formatMs(ms)}`;
}

function refreshOutput(): void {
  const t0 = performance.now();
  const result = normalize(state.input, state.lexicon, {
    phonetic: state.settings.phonetic,
    fuzzy: state.settings.fuzzy,
    minConfidence: state.settings.minConfidence,
  });
  const ms = performance.now() - t0;
  renderOutput(result);
  renderDiff(result);
  renderStats(result, ms);
}

// ---------------------------------------------------------------------------
// Lexicon panel
// ---------------------------------------------------------------------------

function renderLexiconStatus(): void {
  if (state.lexiconError) {
    ui.yamlError.textContent = state.lexiconError;
    ui.yamlError.hidden = false;
    ui.yaml.setAttribute('aria-invalid', 'true');
    ui.yamlStatus.textContent = 'invalid, using last good version';
    ui.yamlStatus.className = 'status status-bad';
  } else {
    ui.yamlError.hidden = true;
    ui.yamlError.textContent = '';
    ui.yaml.removeAttribute('aria-invalid');
    const n = state.lexicon.terms.length;
    ui.yamlStatus.textContent = `${n} ${n === 1 ? 'term' : 'terms'}`;
    ui.yamlStatus.className = 'status status-ok';
  }
}

function refreshExport(): void {
  const format = state.settings.format;
  const info = EXPORT_FORMAT_INFO[format];
  ui.formatInfo.textContent = `${info.description} (.${info.ext})`;
  try {
    ui.exportPreview.textContent = exportLexicon(state.lexicon, format);
  } catch (err) {
    ui.exportPreview.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Recompile the YAML pane; on success the output and export follow. */
function applyYaml(text: string): void {
  state.yaml = text;
  saveItem(STORAGE.yaml, text);
  const compiled = compileLexicon(text);
  state.lexiconError = compiled.error;
  if (compiled.lexicon) state.lexicon = compiled.lexicon;
  renderLexiconStatus();
  refreshOutput();
  refreshExport();
}

function setYaml(text: string): void {
  ui.yaml.value = text;
  applyYaml(text);
}

function splitAliases(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const v = part.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

function renderSuggestions(canonical: string): void {
  ui.suggestions.replaceChildren();
  const list = canonical.trim() ? suggestAliases(canonical) : [];
  ui.useSuggestions.disabled = list.length === 0;
  if (list.length === 0) {
    if (canonical.trim()) ui.suggestions.append(el('span', 'chips-empty', 'No obvious misspellings for this one.'));
    return;
  }
  for (const s of list) {
    const chip = el('button', 'chip', s);
    chip.type = 'button';
    chip.title = 'Add this alias';
    chip.addEventListener('click', () => {
      const current = splitAliases(ui.aliases.value);
      if (!current.some((a) => a.toLowerCase() === s.toLowerCase())) current.push(s);
      ui.aliases.value = current.join(', ');
      ui.aliases.focus();
    });
    ui.suggestions.append(chip);
  }
}

/**
 * Add (or merge into) a term in the YAML pane. Goes through the yaml Document
 * API so the user's comments and ordering survive; the file is re-validated
 * afterwards like any other edit.
 */
function addTerm(canonical: string, aliases: string[]): string | null {
  if (state.lexiconError) return 'Fix the YAML errors above first.';
  try {
    parseLexicon({ version: 1, terms: [{ canonical, aliases }] });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  // An empty pane parses to a null document; start from a minimal file instead.
  const doc = parseDocument(state.yaml.trim() ? state.yaml : 'version: 1\nterms: []\n');
  if (doc.errors.length > 0) return doc.errors[0].message;

  let terms = doc.get('terms');
  if (!isSeq(terms)) {
    terms = doc.createNode([]);
    doc.set('terms', terms);
  }
  if (!isSeq(terms)) return 'Could not find a terms list in the YAML.';

  for (const item of terms.items) {
    if (!isMap(item)) continue;
    const existing = item.get('canonical');
    if (typeof existing !== 'string' || existing.toLowerCase() !== canonical.toLowerCase()) continue;
    const existingAliases = item.get('aliases');
    const current: string[] = [];
    if (isSeq(existingAliases)) {
      for (const a of existingAliases.items) {
        const v = isMap(a) ? undefined : (a as { value?: unknown }).value;
        if (typeof v === 'string') current.push(v);
      }
    }
    const merged = [...current];
    for (const a of aliases) if (!merged.some((m) => m.toLowerCase() === a.toLowerCase())) merged.push(a);
    item.set('aliases', doc.createNode(merged));
    setYaml(doc.toString());
    return null;
  }

  terms.add(doc.createNode({ canonical, aliases }));
  setYaml(doc.toString());
  return null;
}

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

function setupDictation(): void {
  const Ctor = speechRecognizerCtor();
  if (!Ctor) {
    ui.dictate.disabled = true;
    ui.dictate.title = 'Speech recognition is not available in this browser. Chrome, Edge and Safari support it.';
    ui.speechNote.textContent = 'Dictation needs a browser with the Web Speech API (Chrome, Edge, Safari). Paste text instead.';
    return;
  }

  let recognizer: SpeechRecognizer | null = null;
  let listening = false;

  const setListening = (on: boolean): void => {
    listening = on;
    ui.dictate.classList.toggle('listening', on);
    ui.dictate.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.dictate.querySelector('.label')!.textContent = on ? 'Listening' : 'Dictate';
    if (!on) ui.interim.textContent = '';
  };

  const appendFinal = (transcript: string): void => {
    const text = transcript.trim();
    if (!text) return;
    const current = ui.input.value;
    const joined = current.trim().length === 0 ? text : `${current.replace(/\s+$/, '')} ${text}`;
    ui.input.value = joined;
    onInputChanged(joined);
  };

  const stop = (): void => {
    if (recognizer) {
      try {
        recognizer.stop();
      } catch {
        // Already stopped.
      }
    }
  };

  const start = (): void => {
    const r = new Ctor();
    r.continuous = false;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onstart = () => {
      ui.speechNote.textContent = 'Say something like "tell Ashler to deploy Kubernetes" and watch it get fixed.';
      setListening(true);
    };
    r.onresult = (event) => {
      let interim = '';
      let finals = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) finals += transcript;
        else interim += transcript;
      }
      ui.interim.textContent = interim;
      if (finals) appendFinal(finals);
    };
    r.onerror = (event) => {
      const code = event.error ?? 'unknown';
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access was denied. Allow it in the browser and try again.',
        'service-not-allowed': 'Speech recognition is blocked in this context.',
        'no-speech': 'No speech detected. Try again and speak a little closer to the mic.',
        'audio-capture': 'No microphone found.',
        'network': 'The browser’s speech service needs a network connection.',
        'aborted': '',
      };
      const message = messages[code] ?? `Speech recognition error: ${code}`;
      if (message) ui.speechNote.textContent = message;
    };
    r.onend = () => {
      recognizer = null;
      setListening(false);
    };
    recognizer = r;
    try {
      r.start();
    } catch (err) {
      ui.speechNote.textContent = `Could not start dictation: ${err instanceof Error ? err.message : String(err)}`;
      recognizer = null;
      setListening(false);
    }
  };

  ui.speechNote.textContent =
    'Uses your browser’s speech recognizer (Chrome sends audio to Google for this step). The page itself sends nothing.';

  ui.dictate.addEventListener('click', () => {
    if (listening) stop();
    else start();
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function saveSettings(): void {
  saveItem(STORAGE.settings, JSON.stringify(state.settings));
}

function onInputChanged(text: string): void {
  state.input = text;
  saveItem(STORAGE.input, text);
  refreshOutput();
}

const onInputDebounced = debounce(onInputChanged, DEBOUNCE_MS);
const onYamlDebounced = debounce(applyYaml, DEBOUNCE_MS);

function init(): void {
  // Input
  ui.input.value = state.input;
  ui.input.addEventListener('input', () => onInputDebounced(ui.input.value));
  ui.resetInput.addEventListener('click', () => {
    ui.input.value = DEMO_SENTENCE;
    onInputChanged(DEMO_SENTENCE);
  });
  ui.clearInput.addEventListener('click', () => {
    ui.input.value = '';
    onInputChanged('');
    ui.input.focus();
  });

  // Settings
  ui.optPhonetic.checked = state.settings.phonetic;
  ui.optFuzzy.checked = state.settings.fuzzy;
  ui.optMinConf.value = String(state.settings.minConfidence);
  ui.optMinConfOut.value = state.settings.minConfidence.toFixed(2);
  ui.optPhonetic.addEventListener('change', () => {
    state.settings.phonetic = ui.optPhonetic.checked;
    saveSettings();
    refreshOutput();
  });
  ui.optFuzzy.addEventListener('change', () => {
    state.settings.fuzzy = ui.optFuzzy.checked;
    saveSettings();
    refreshOutput();
  });
  ui.optMinConf.addEventListener('input', () => {
    state.settings.minConfidence = Number(ui.optMinConf.value);
    ui.optMinConfOut.value = state.settings.minConfidence.toFixed(2);
    saveSettings();
    refreshOutput();
  });

  // Lexicon
  ui.yaml.value = state.yaml;
  ui.yaml.addEventListener('input', () => onYamlDebounced(ui.yaml.value));
  ui.resetYaml.addEventListener('click', () => setYaml(exampleYaml));

  ui.canonical.addEventListener('input', () => renderSuggestions(ui.canonical.value));
  ui.useSuggestions.addEventListener('click', () => {
    const list = suggestAliases(ui.canonical.value);
    ui.aliases.value = list.join(', ');
    ui.aliases.focus();
  });
  ui.addTerm.addEventListener('submit', (event) => {
    event.preventDefault();
    const canonical = ui.canonical.value.trim();
    const aliases = splitAliases(ui.aliases.value);
    if (!canonical) {
      ui.addError.textContent = 'Enter the correct spelling first.';
      ui.canonical.focus();
      return;
    }
    const error = addTerm(canonical, aliases);
    ui.addError.textContent = error ?? '';
    if (error) return;
    ui.canonical.value = '';
    ui.aliases.value = '';
    renderSuggestions('');
    ui.canonical.focus();
  });

  // Export
  for (const format of EXPORT_FORMATS) {
    const option = el('option', undefined, format);
    option.value = format;
    ui.format.append(option);
  }
  ui.format.value = state.settings.format;
  ui.format.addEventListener('change', () => {
    state.settings.format = ui.format.value as ExportFormat;
    saveSettings();
    refreshExport();
  });
  ui.copyExport.addEventListener('click', async () => {
    const ok = await copyText(ui.exportPreview.textContent ?? '');
    flash(ui.copyExport, ok ? 'Copied' : 'Copy failed');
  });
  ui.downloadExport.addEventListener('click', () => {
    const format = state.settings.format;
    const ext = EXPORT_FORMAT_INFO[format].ext;
    const mime = ext === 'json' ? 'application/json' : 'text/plain';
    downloadText(`lexicon-${format}.${ext}`, ui.exportPreview.textContent ?? '', `${mime};charset=utf-8`);
  });

  // Header install snippet
  ui.copyInstall.addEventListener('click', async () => {
    const ok = await copyText('npm i -g @ashlr/lexicon');
    flash(ui.copyInstall, ok ? 'Copied' : 'Copy failed');
  });

  setupDictation();
  renderLexiconStatus();
  renderSuggestions('');
  refreshOutput();
  refreshExport();
}

init();
