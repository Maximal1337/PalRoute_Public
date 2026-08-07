/**
 * Min-heap keyed by a numeric priority. Has no decrease-key: callers push a
 * duplicate and skip stale pops.
 */
export class MinHeap<T> {
  private readonly keys: number[] = [];
  private readonly vals: T[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: T): void {
    this.keys.push(key);
    this.vals.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { key: number; value: T } | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[0]!;
    const value = this.vals[0]!;
    const lastKey = this.keys.pop()!;
    const lastVal = this.vals.pop()!;

    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < n && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { key, value };
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.vals[a], this.vals[b]] = [this.vals[b]!, this.vals[a]!];
  }
}
