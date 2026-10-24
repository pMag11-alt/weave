/**
 * The document's elements (including tombstones) in order, as a list of chunks.
 *
 * Each chunk caches how many of its elements are visible, so mapping between a
 * visible index and an element costs O(chunks + chunk size) instead of O(n), and
 * inserting is a splice into one small array.
 */

export interface SeqItem {
  deleted: boolean;
  chunk: Chunk<SeqItem> | null;
}

export class Chunk<T extends SeqItem> {
  items: T[] = [];
  visible = 0;
}

const MAX_CHUNK = 512;

export class Seq<T extends SeqItem> {
  private chunks: Chunk<T>[] = [new Chunk<T>()];
  private total = 0;
  private visibleTotal = 0;

  get size(): number {
    return this.total;
  }

  get visibleSize(): number {
    return this.visibleTotal;
  }

  /** Insert `item` right after `ref` (or at the very start when `ref` is null). */
  insertAfter(ref: T | null, item: T): void {
    if (ref === null) {
      this.insertAt(this.chunks[0], 0, item);
      return;
    }
    const chunk = ref.chunk as Chunk<T>;
    this.insertAt(chunk, chunk.items.indexOf(ref) + 1, item);
  }

  insertBefore(ref: T, item: T): void {
    const chunk = ref.chunk as Chunk<T>;
    this.insertAt(chunk, chunk.items.indexOf(ref), item);
  }

  private insertAt(chunk: Chunk<T>, pos: number, item: T): void {
    chunk.items.splice(pos, 0, item);
    item.chunk = chunk as unknown as Chunk<SeqItem>;
    this.total++;
    if (!item.deleted) {
      chunk.visible++;
      this.visibleTotal++;
    }
    if (chunk.items.length > MAX_CHUNK) this.split(chunk);
  }

  private split(chunk: Chunk<T>): void {
    const right = new Chunk<T>();
    right.items = chunk.items.splice(chunk.items.length >> 1);
    for (const it of right.items) {
      it.chunk = right as unknown as Chunk<SeqItem>;
      if (!it.deleted) right.visible++;
    }
    chunk.visible -= right.visible;
    this.chunks.splice(this.chunks.indexOf(chunk) + 1, 0, right);
  }

  /** Mark an item invisible (it stays in the sequence as a tombstone). */
  hide(item: T): void {
    if (item.deleted) return;
    item.deleted = true;
    (item.chunk as Chunk<T>).visible--;
    this.visibleTotal--;
  }

  /** The element after `item`, tombstones included. */
  next(item: T): T | null {
    const chunk = item.chunk as Chunk<T>;
    const i = chunk.items.indexOf(item);
    if (i + 1 < chunk.items.length) return chunk.items[i + 1];
    for (let c = this.chunks.indexOf(chunk) + 1; c < this.chunks.length; c++) {
      if (this.chunks[c].items.length) return this.chunks[c].items[0];
    }
    return null;
  }

  first(): T | null {
    for (const c of this.chunks) if (c.items.length) return c.items[0];
    return null;
  }

  /** Number of visible elements before `item`. Works for tombstones too. */
  visibleIndex(item: T): number {
    let n = 0;
    const target = item.chunk as Chunk<T>;
    for (const c of this.chunks) {
      if (c === target) break;
      n += c.visible;
    }
    for (const it of target.items) {
      if (it === item) break;
      if (!it.deleted) n++;
    }
    return n;
  }

  /** The `i`-th visible element. */
  atVisible(i: number): T {
    if (i < 0 || i >= this.visibleTotal) throw new RangeError(`index ${i} out of range (length ${this.visibleTotal})`);
    for (const c of this.chunks) {
      if (i >= c.visible) {
        i -= c.visible;
        continue;
      }
      for (const it of c.items) {
        if (it.deleted) continue;
        if (i === 0) return it;
        i--;
      }
    }
    throw new Error("unreachable: visible counts are inconsistent");
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const c of this.chunks) yield* c.items;
  }

  /** Internal consistency check, for tests. */
  check(): void {
    let total = 0;
    let visible = 0;
    for (const c of this.chunks) {
      let v = 0;
      for (const it of c.items) {
        if (it.chunk !== (c as unknown as Chunk<SeqItem>)) throw new Error("item has a stale chunk pointer");
        if (!it.deleted) v++;
      }
      if (v !== c.visible) throw new Error("chunk visible count is wrong");
      if (c.items.length > MAX_CHUNK) throw new Error("chunk too large");
      total += c.items.length;
      visible += v;
    }
    if (total !== this.total || visible !== this.visibleTotal) throw new Error("totals are wrong");
  }
}
