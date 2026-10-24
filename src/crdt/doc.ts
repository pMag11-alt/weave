/**
 * A collaborative text document: the Fugue sequence CRDT.
 *
 * Fugue (Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in
 * Collaborative Text Editing", 2023) arranges characters in a tree. Every character is a
 * left or right child of another one, and the text is the tree's in-order traversal
 * (left children, the node itself, then right children). Siblings on the same side are
 * ordered by id. Because each replica's run of typing becomes one chain of right children,
 * concurrent insertions at the same spot never interleave character by character, which
 * simpler CRDTs like RGA can't promise.
 *
 * Deleted characters stay in the tree as tombstones so concurrent operations that refer to
 * them still have a place to attach. Operations are applied in causal order: ones that
 * arrive early (their parent isn't here yet) wait in a buffer.
 */

import { Seq, type Chunk, type SeqItem } from "./seq.js";
import type { Anchor, Change, DeleteOp, Id, InsertOp, Op, ReplicaId, VersionVector } from "./types.js";
import { opSpan } from "./types.js";

interface Node extends SeqItem {
  replica: ReplicaId;
  counter: number;
  value: string;
  deleted: boolean;
  parent: Node | null;
  side: "L" | "R";
  /** Children, created on first use: most characters never get any. */
  left: Node[] | null;
  right: Node[] | null;
  chunk: Chunk<SeqItem> | null;
}

function compareIds(a: Node, b: Node): number {
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.counter - b.counter;
}

function leftmost(n: Node): Node {
  while (n.left?.length) n = n.left[0];
  return n;
}

function rightmost(n: Node): Node {
  while (n.right?.length) n = n.right[n.right.length - 1];
  return n;
}

export class Doc {
  readonly replica: ReplicaId;
  private nextCounter = 0;
  private readonly root: Node;
  private readonly seq = new Seq<Node>();
  /** nodes[replica][counter]; delete ops leave holes. */
  private readonly nodes = new Map<ReplicaId, Node[]>();
  private readonly vv = new Map<ReplicaId, number>();
  /** Every applied op, in an order that respects causality. */
  private readonly log: Op[] = [];
  private pending: Op[] = [];

  constructor(replica: ReplicaId) {
    if (!replica || replica.includes(":")) throw new Error(`bad replica id ${JSON.stringify(replica)}`);
    this.replica = replica;
    this.root = { replica: "", counter: -1, value: "", deleted: true, parent: null, side: "R", left: null, right: null, chunk: null };
  }

  get length(): number {
    return this.seq.visibleSize;
  }

  text(): string {
    let s = "";
    for (const n of this.seq) if (!n.deleted) s += n.value;
    return s;
  }

  // -------------------------------------------------------------------------
  // Local edits
  // -------------------------------------------------------------------------

  /** Insert `text` before visible position `index`; returns the op to broadcast. */
  insert(index: number, text: string): InsertOp {
    if (index < 0 || index > this.length) throw new RangeError(`insert index ${index} out of range`);
    if (!text) throw new Error("empty insert");
    const leftOrigin = index === 0 ? this.root : this.seq.atVisible(index - 1);
    let parent: Node;
    let side: "L" | "R";
    if (!leftOrigin.right?.length) {
      parent = leftOrigin;
      side = "R";
    } else {
      // The next element (maybe a tombstone) is the leftmost node of leftOrigin's right
      // subtree, so it has no left children: become its left child.
      parent = (leftOrigin === this.root ? this.seq.first() : this.seq.next(leftOrigin)) as Node;
      side = "L";
    }
    const op: InsertOp = {
      t: "ins",
      id: [this.replica, this.nextCounter],
      parent: parent === this.root ? null : [parent.replica, parent.counter],
      side,
      text,
    };
    this.applyReady(op);
    return op;
  }

  /** Delete `count` visible characters starting at `index`; null if count is 0. */
  delete(index: number, count: number): DeleteOp | null {
    if (count <= 0) return null;
    if (index < 0 || index + count > this.length) throw new RangeError(`delete range ${index}+${count} out of range`);
    const targets: [ReplicaId, number, number][] = [];
    let node: Node | null = this.seq.atVisible(index);
    let remaining = count;
    while (remaining > 0 && node) {
      if (!node.deleted) {
        const last = targets[targets.length - 1];
        if (last && last[0] === node.replica && last[1] + last[2] === node.counter) last[2]++;
        else targets.push([node.replica, node.counter, 1]);
        remaining--;
      }
      node = this.seq.next(node);
    }
    const op: DeleteOp = { t: "del", id: [this.replica, this.nextCounter], targets };
    this.applyReady(op);
    return op;
  }

  // -------------------------------------------------------------------------
  // Remote operations
  // -------------------------------------------------------------------------

  /**
   * Apply operations from another replica (in any order, duplicates allowed). Returns the
   * visible changes, in the order they happened, so an editor can patch its text.
   */
  apply(ops: Op | Op[]): Change[] {
    const changes: Change[] = [];
    for (const op of Array.isArray(ops) ? ops : [ops]) {
      const status = this.readiness(op);
      if (status === "applied") continue;
      if (status === "wait") {
        this.pending.push(op);
        continue;
      }
      changes.push(...this.applyReady(op));
      changes.push(...this.drainPending());
    }
    return changes;
  }

  /** Ops received but not applicable yet because something they depend on is missing. */
  get pendingCount(): number {
    return this.pending.length;
  }

  private drainPending(): Change[] {
    const changes: Change[] = [];
    let progress = true;
    while (progress && this.pending.length) {
      progress = false;
      const still: Op[] = [];
      for (const op of this.pending) {
        const status = this.readiness(op);
        if (status === "ready") {
          changes.push(...this.applyReady(op));
          progress = true;
        } else if (status === "wait") {
          still.push(op);
        }
      }
      this.pending = still;
    }
    return changes;
  }

  private readiness(op: Op): "ready" | "wait" | "applied" {
    const [replica, counter] = op.id;
    const expected = (this.vv.get(replica) ?? -1) + 1;
    if (counter < expected) return "applied";
    if (counter > expected) return "wait";
    if (op.t === "ins") return op.parent === null || this.lookup(op.parent) ? "ready" : "wait";
    for (const [r, c, n] of op.targets) {
      for (let k = 0; k < n; k++) if (!this.lookup([r, c + k])) return "wait";
    }
    return "ready";
  }

  private lookup(id: Id): Node | undefined {
    return this.nodes.get(id[0])?.[id[1]];
  }

  private applyReady(op: Op): Change[] {
    const [replica, counter] = op.id;
    const changes = op.t === "ins" ? this.integrateInsert(op) : this.integrateDelete(op);
    this.vv.set(replica, counter + opSpan(op) - 1);
    if (replica === this.replica) this.nextCounter = counter + opSpan(op);
    this.log.push(op);
    return changes;
  }

  private integrateInsert(op: InsertOp): Change[] {
    const [replica, start] = op.id;
    let slots = this.nodes.get(replica);
    if (!slots) this.nodes.set(replica, (slots = []));
    let parent = op.parent === null ? this.root : (this.lookup(op.parent) as Node);
    let side = op.side;
    let first: Node | null = null;
    for (let k = 0; k < op.text.length; k++) {
      const node: Node = {
        replica,
        counter: start + k,
        value: op.text[k],
        deleted: false,
        parent,
        side,
        left: null,
        right: null,
        chunk: null,
      };
      this.place(node);
      slots[start + k] = node;
      first ??= node;
      parent = node;
      side = "R";
    }
    return [{ index: this.seq.visibleIndex(first as Node), deleted: 0, inserted: op.text }];
  }

  /** Attach `node` to the tree and put it at the matching position in the sequence. */
  private place(node: Node): void {
    const parent = node.parent as Node;
    const siblings = node.side === "L" ? (parent.left ??= []) : (parent.right ??= []);
    let k = 0;
    while (k < siblings.length && compareIds(siblings[k], node) < 0) k++;
    if (k < siblings.length) {
      // before the first element of the next sibling's subtree
      this.seq.insertBefore(leftmost(siblings[k]), node);
    } else if (node.side === "L") {
      // after all other left subtrees: directly before the parent
      this.seq.insertBefore(parent, node);
    } else {
      // after the end of the parent's whole subtree
      const last = rightmost(parent);
      this.seq.insertAfter(last === this.root ? null : last, node);
    }
    siblings.splice(k, 0, node);
  }

  private integrateDelete(op: DeleteOp): Change[] {
    const changes: Change[] = [];
    for (const [r, c, n] of op.targets) {
      for (let k = 0; k < n; k++) {
        const node = this.lookup([r, c + k]) as Node;
        if (node.deleted) continue; // concurrent deletes of the same character are fine
        const index = this.seq.visibleIndex(node);
        this.seq.hide(node);
        const last = changes[changes.length - 1];
        if (last && last.index === index) last.deleted++;
        else changes.push({ index, deleted: 1, inserted: "" });
      }
    }
    return changes;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  versionVector(): VersionVector {
    return Object.fromEntries(this.vv);
  }

  /** Ops the holder of `vv` hasn't seen, in causal order. */
  opsSince(vv: VersionVector): Op[] {
    return this.log.filter((op) => op.id[1] + opSpan(op) - 1 > (vv[op.id[0]] ?? -1));
  }

  /** Has this replica seen everything described by `vv`? */
  covers(vv: VersionVector): boolean {
    return Object.entries(vv).every(([r, c]) => (this.vv.get(r) ?? -1) >= c);
  }

  get opCount(): number {
    return this.log.length;
  }

  /** Ops applied since the log had `n` entries (e.g. what one `apply` call added). */
  opsFrom(n: number): Op[] {
    return this.log.slice(n);
  }

  // -------------------------------------------------------------------------
  // Cursors and undo support
  // -------------------------------------------------------------------------

  /** Anchor a cursor at visible position `index` so it follows concurrent edits. */
  anchorAt(index: number): Anchor {
    if (index <= 0) return null;
    const n = this.seq.atVisible(Math.min(index, this.length) - 1);
    return [n.replica, n.counter];
  }

  /** Current visible position of an anchored cursor. */
  indexOfAnchor(anchor: Anchor): number {
    if (anchor === null) return 0;
    const n = this.lookup(anchor);
    if (!n) return 0;
    return this.seq.visibleIndex(n) + (n.deleted ? 0 : 1);
  }

  /** Visible index of a character, or -1 if it's deleted or unknown. */
  indexOfId(id: Id): number {
    const n = this.lookup(id);
    return n && !n.deleted ? this.seq.visibleIndex(n) : -1;
  }

  /** Where a (possibly deleted) character is or would be: its visible index if it were visible. */
  positionOfId(id: Id): number {
    const n = this.lookup(id);
    return n ? this.seq.visibleIndex(n) : -1;
  }

  valueOf(id: Id): string | undefined {
    return this.lookup(id)?.value;
  }

  /** Ids of the visible characters in [index, index + count). */
  idsInRange(index: number, count: number): Id[] {
    const out: Id[] = [];
    if (count <= 0) return out;
    let node: Node | null = this.seq.atVisible(index);
    while (node && out.length < count) {
      if (!node.deleted) out.push([node.replica, node.counter]);
      node = this.seq.next(node);
    }
    return out;
  }

  /** Delete specific characters by id (for undoing an insert). */
  deleteIds(ids: Id[]): { op: DeleteOp | null; changes: Change[] } {
    const targets: [ReplicaId, number, number][] = [];
    for (const id of ids) {
      const n = this.lookup(id);
      if (!n || n.deleted) continue;
      const last = targets[targets.length - 1];
      if (last && last[0] === n.replica && last[1] + last[2] === n.counter) last[2]++;
      else targets.push([n.replica, n.counter, 1]);
    }
    if (!targets.length) return { op: null, changes: [] };
    const op: DeleteOp = { t: "del", id: [this.replica, this.nextCounter], targets };
    return { op, changes: this.applyReady(op) };
  }

  // -------------------------------------------------------------------------
  // Introspection (for the playground's tree view and for tests)
  // -------------------------------------------------------------------------

  /** Every element in document order, tombstones included. */
  elements(): { id: Id; value: string; deleted: boolean; parent: Id | null; side: "L" | "R"; depth: number }[] {
    const out = [];
    for (const n of this.seq) {
      let depth = 0;
      for (let p = n.parent; p; p = p.parent) depth++;
      const parent: Id | null = n.parent === this.root || !n.parent ? null : [n.parent.replica, n.parent.counter];
      out.push({ id: [n.replica, n.counter] as Id, value: n.value, deleted: n.deleted, parent, side: n.side, depth });
    }
    return out;
  }

  /** Recompute the in-order traversal from the tree and compare with the sequence (tests). */
  checkInvariants(): void {
    this.seq.check();
    const order: Node[] = [];
    const stack: [Node, boolean][] = [[this.root, false]];
    while (stack.length) {
      const [n, expanded] = stack.pop() as [Node, boolean];
      if (expanded) {
        if (n !== this.root) order.push(n);
        for (let i = (n.right?.length ?? 0) - 1; i >= 0; i--) stack.push([(n.right as Node[])[i], false]);
        continue;
      }
      stack.push([n, true]);
      for (let i = (n.left?.length ?? 0) - 1; i >= 0; i--) stack.push([(n.left as Node[])[i], false]);
    }
    const seqOrder = [...this.seq];
    if (order.length !== seqOrder.length || order.some((n, i) => n !== seqOrder[i])) {
      throw new Error("sequence order differs from the tree's in-order traversal");
    }
  }
}
