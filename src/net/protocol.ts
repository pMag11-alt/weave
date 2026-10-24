/**
 * Messages exchanged over the WebSocket, as JSON. The server is a hub: clients send it
 * their own operations, it stores them and forwards them to everyone else in the room.
 *
 *   client                               server
 *     | -- hello {replica, vv} ----------> |   vv = what the client already has
 *     | <- welcome {vv, ops, peers} ------ |   ops = everything the client is missing
 *     | -- ops {ops} --------------------> |   the client's offline edits the server lacks
 *     | <- ops {ops} / presence / leave -- |   live updates
 */

import type { Anchor, Id, Op, VersionVector } from "../crdt/types.js";

export interface Cursor {
  anchor: Anchor;
  head: Anchor;
}

export interface Peer {
  replica: string;
  name: string;
  color: string;
  cursor: Cursor | null;
}

export type ClientMessage =
  | { type: "hello"; replica: string; name: string; color: string; vv: VersionVector }
  | { type: "ops"; ops: Op[] }
  | { type: "presence"; cursor: Cursor | null; name?: string; color?: string };

export type ServerMessage =
  | { type: "welcome"; vv: VersionVector; ops: Op[]; peers: Peer[] }
  | { type: "ops"; ops: Op[] }
  | { type: "presence"; peer: Peer }
  | { type: "leave"; replica: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Validation: everything from the network is untrusted
// ---------------------------------------------------------------------------

const MAX_TEXT = 1 << 20;
const MAX_OPS = 10_000;

function isReplica(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= 64 && !x.includes(":");
}

function isCounter(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 0;
}

function isId(x: unknown): x is Id {
  return Array.isArray(x) && x.length === 2 && isReplica(x[0]) && isCounter(x[1]);
}

function isAnchor(x: unknown): x is Anchor {
  return x === null || isId(x);
}

export function isOp(x: unknown): x is Op {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (!isId(o.id)) return false;
  if (o.t === "ins") {
    return (o.parent === null || isId(o.parent)) && (o.side === "L" || o.side === "R") && typeof o.text === "string" && o.text.length > 0 && o.text.length <= MAX_TEXT;
  }
  if (o.t === "del") {
    return (
      Array.isArray(o.targets) &&
      o.targets.length > 0 &&
      o.targets.length <= MAX_OPS &&
      o.targets.every((t) => Array.isArray(t) && t.length === 3 && isReplica(t[0]) && isCounter(t[1]) && Number.isSafeInteger(t[2]) && t[2] > 0 && t[2] <= MAX_TEXT)
    );
  }
  return false;
}

function isCursor(x: unknown): x is Cursor | null {
  if (x === null) return true;
  if (typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return isAnchor(c.anchor) && isAnchor(c.head);
}

function isVersionVector(x: unknown): x is VersionVector {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.entries(x).every(([k, v]) => isReplica(k) && Number.isSafeInteger(v) && (v as number) >= -1);
}

function shortString(x: unknown, max = 64): x is string {
  return typeof x === "string" && x.length <= max;
}

/** Parse and validate a client message; returns null if it's malformed. */
export function parseClientMessage(text: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "hello":
      return isReplica(o.replica) && shortString(o.name) && shortString(o.color, 32) && isVersionVector(o.vv) ? (o as ClientMessage) : null;
    case "ops":
      return Array.isArray(o.ops) && o.ops.length <= MAX_OPS && o.ops.every(isOp) ? (o as ClientMessage) : null;
    case "presence":
      return isCursor(o.cursor) && (o.name === undefined || shortString(o.name)) && (o.color === undefined || shortString(o.color, 32)) ? (o as ClientMessage) : null;
    default:
      return null;
  }
}
