/** Every replica (browser tab, server, test peer) has a unique id. */
export type ReplicaId = string;

/** An element or operation id: (replica, counter). Counters increase per replica. */
export type Id = [replica: ReplicaId, counter: number];

/**
 * Insert a run of characters. The first character becomes the `side` child of `parent`
 * (null = the root); each following character is the right child of the one before it,
 * which is exactly what typing them one by one would produce. Character k has id
 * (id[0], id[1] + k).
 */
export interface InsertOp {
  t: "ins";
  id: Id;
  parent: Id | null;
  side: "L" | "R";
  text: string;
}

/** Delete characters, given as runs [replica, first counter, length]. Uses one counter. */
export interface DeleteOp {
  t: "del";
  id: Id;
  targets: [ReplicaId, number, number][];
}

export type Op = InsertOp | DeleteOp;

/** For each replica, the highest counter applied from it (all lower ones are applied too). */
export type VersionVector = Record<ReplicaId, number>;

/** A visible change, in plain string indices, for updating an editor. */
export interface Change {
  index: number;
  /** Number of characters removed at `index`. */
  deleted: number;
  /** Text inserted at `index` (after the deletion). */
  inserted: string;
}

/** A cursor position that survives concurrent edits: the id of the character to its left. */
export type Anchor = Id | null;

/** How many counters an operation consumes. */
export function opSpan(op: Op): number {
  return op.t === "ins" ? op.text.length : 1;
}

export function idKey(id: Id): string {
  return `${id[0]}:${id[1]}`;
}
