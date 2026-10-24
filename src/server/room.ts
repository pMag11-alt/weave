/**
 * A room: one shared document, the clients editing it, and its append-only op log on disk.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Doc } from "../crdt/doc.js";
import type { Op } from "../crdt/types.js";
import { type Peer, type ServerMessage, isOp } from "../net/protocol.js";

export interface Client {
  replica: string;
  peer: Peer;
  send(msg: ServerMessage): void;
}

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class Room {
  /** The server's copy. It never edits, so its replica id never appears in an op. */
  readonly doc = new Doc("server");
  readonly clients = new Map<string, Client>();
  private readonly file: string | null;

  constructor(
    readonly name: string,
    dataDir: string | null,
  ) {
    this.file = dataDir ? join(dataDir, `${name}.jsonl`) : null;
    if (this.file && existsSync(this.file)) {
      const ops: Op[] = [];
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line);
          if (isOp(op)) ops.push(op);
        } catch {
          // a torn last line from a crash: skip it, the client still has the op and will resend
        }
      }
      this.doc.apply(ops);
    }
  }

  join(client: Client): void {
    this.clients.get(client.replica)?.send({ type: "error", message: "replaced by a newer connection" });
    this.clients.set(client.replica, client);
    this.broadcast({ type: "presence", peer: client.peer }, client.replica);
  }

  leave(client: Client): void {
    if (this.clients.get(client.replica) !== client) return;
    this.clients.delete(client.replica);
    this.broadcast({ type: "leave", replica: client.replica });
  }

  peers(except: string): Peer[] {
    return [...this.clients.values()].filter((c) => c.replica !== except).map((c) => c.peer);
  }

  /**
   * Apply ops from `from`, persist the ones that were new, and forward them to everyone
   * else. A client may only submit its own operations.
   */
  receive(from: Client, ops: Op[]): number {
    const own = ops.filter((op) => op.id[0] === from.replica);
    const before = this.doc.opCount;
    this.doc.apply(own);
    const fresh = this.doc.opsFrom(before);
    if (!fresh.length) return 0;
    if (this.file) {
      mkdirSync(join(this.file, ".."), { recursive: true });
      appendFileSync(this.file, fresh.map((op) => JSON.stringify(op)).join("\n") + "\n");
    }
    this.broadcast({ type: "ops", ops: fresh }, from.replica);
    return fresh.length;
  }

  updatePresence(client: Client): void {
    this.broadcast({ type: "presence", peer: client.peer }, client.replica);
  }

  private broadcast(msg: ServerMessage, except?: string): void {
    for (const [replica, c] of this.clients) if (replica !== except) c.send(msg);
  }
}
