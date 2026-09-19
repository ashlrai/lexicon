export class LexiconStore {
  private readonly entries: string[] = [];
  add(entry: string): void {
    this.entries.push(entry);
  }
}

export interface LexiconStoreOptions {
  root: string;
}

export function makeStore(_opts: LexiconStoreOptions): LexiconStore {
  return new LexiconStore();
}
