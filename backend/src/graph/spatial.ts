/** Uniform spatial hash over the XY plane, for neighbour lookup during graph build. */
export class SpatialHash {
  private readonly cell: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];

  /** @param cellSize bucket edge length, in the same units as the coordinates. */
  constructor(cellSize: number) {
    if (!(cellSize > 0)) throw new Error(`cellSize must be > 0, got ${cellSize}`);
    this.cell = cellSize;
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  insert(id: number, x: number, y: number): void {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const k = this.key(cx, cy);
    const b = this.buckets.get(k);
    if (b) b.push(id);
    else this.buckets.set(k, [id]);
    this.xs[id] = x;
    this.ys[id] = y;
  }

  /** Broad phase: ids whose bucket overlaps the disc. Callers must still test true distance. */
  query(x: number, y: number, radius: number): number[] {
    const r = Math.max(radius, 0);
    const minX = Math.floor((x - r) / this.cell);
    const maxX = Math.floor((x + r) / this.cell);
    const minY = Math.floor((y - r) / this.cell);
    const maxY = Math.floor((y + r) / this.cell);
    const out: number[] = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (b) out.push(...b);
      }
    }
    return out;
  }

  /** Ids strictly within `radius`, excluding `selfId`. */
  within(x: number, y: number, radius: number, selfId?: number): number[] {
    const r2 = radius * radius;
    const out: number[] = [];
    for (const id of this.query(x, y, radius)) {
      if (id === selfId) continue;
      const dx = this.xs[id]! - x;
      const dy = this.ys[id]! - y;
      if (dx * dx + dy * dy <= r2) out.push(id);
    }
    return out;
  }

  /** The k nearest ids regardless of distance, by growing the radius. Backs the MIN_DEGREE guarantee. */
  kNearest(x: number, y: number, k: number, selfId?: number): number[] {
    if (k <= 0) return [];
    let radius = this.cell;
    const total = this.xs.reduce((n, v) => (v === undefined ? n : n + 1), 0);
    const cap = Math.min(k, Math.max(total - 1, 0));
    if (cap === 0) return [];

    for (let attempt = 0; attempt < 40; attempt++) {
      const cand = this.query(x, y, radius).filter((id) => id !== selfId);
      if (cand.length >= cap) {
        return cand
          .map((id) => {
            const dx = this.xs[id]! - x;
            const dy = this.ys[id]! - y;
            return { id, d2: dx * dx + dy * dy };
          })
          .sort((a, b) => a.d2 - b.d2)
          .slice(0, cap)
          .map((e) => e.id);
      }
      radius *= 2;
    }

    // Degenerate fallback: scan everything.
    const all: { id: number; d2: number }[] = [];
    this.xs.forEach((vx, id) => {
      if (id === selfId || vx === undefined) return;
      const dx = vx - x;
      const dy = this.ys[id]! - y;
      all.push({ id, d2: dx * dx + dy * dy });
    });
    return all
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, cap)
      .map((e) => e.id);
  }
}
