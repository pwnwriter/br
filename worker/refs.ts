export type RefEntry = {
  ref: string;
  selector: string;
  role: string;
  name: string;
  fingerprint: string;
  attrs: Record<string, any>;
};

export class RefStore {
  private map = new Map<string, RefEntry>();

  replace(entries: RefEntry[]) {
    this.map.clear();
    for (const entry of entries) this.map.set(entry.ref, entry);
  }

  get(ref: string) {
    return this.map.get(ref);
  }

  list() {
    return [...this.map.values()];
  }
}
