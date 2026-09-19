import { LexiconStore } from './store.js';

export class OpenClaw {
  constructor(private readonly store: LexiconStore) {}
  run(): string {
    return String(this.store);
  }
}

// Generic identifiers that must be filtered out:
// (HTMLElement is referenced here so the harvester sees it too.)
const err: TypeError = new TypeError('x');
export const noise = { err };
