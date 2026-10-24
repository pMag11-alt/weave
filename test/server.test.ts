import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { Doc } from "../src/crdt/doc.js";
import type { Op } from "../src/crdt/types.js";
import type { ServerMessage } from "../src/net/protocol.js";
import { startServer } from "../src/server/server.js";
import { rng } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "weave-test-"));
  dirs.push(d);
  return d;
}

/** A headless client: a Doc wired to the server like the browser editor is. */
class TestClient {
  doc: Doc;
  ws!: WebSocket;
  private waiters: ((m: ServerMessage) => boolean)[] = [];
  closeCode = 0;

  constructor(
    readonly url: string,
    replica: string,
  ) {
    this.doc = new Doc(replica);
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (e) => this.onMessage(JSON.parse(e.data as string)));
    this.ws.addEventListener("close", (e) => (this.closeCode = (e as CloseEvent).code));
    await new Promise((ok) => this.ws.addEventListener("open", ok));
    const welcome = this.waitFor((m) => m.type === "welcome");
    this.ws.send(JSON.stringify({ type: "hello", replica: this.doc.replica, name: this.doc.replica, color: "#000", vv: this.doc.versionVector() }));
    const w = (await welcome) as Extract<ServerMessage, { type: "welcome" }>;
    const mine = this.doc.opsSince(w.vv).filter((op) => op.id[0] === this.doc.replica);
    if (mine.length) this.send(mine);
  }

  private onMessage(m: ServerMessage): void {
    if (m.type === "welcome" || m.type === "ops") this.doc.apply(m.ops);
    this.waiters = this.waiters.filter((w) => !w(m));
  }

  waitFor(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    return new Promise((ok) =>
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        ok(m);
        return true;
      }),
    );
  }

  send(ops: Op[]): void {
    this.ws.send(JSON.stringify({ type: "ops", ops }));
  }

  insert(i: number, s: string): void {
    this.send([this.doc.insert(i, s)]);
  }

  close(): Promise<void> {
    const closed = new Promise<void>((ok) => this.ws.addEventListener("close", () => ok()));
    this.ws.close();
    return closed;
  }
}

async function settle(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for convergence");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}

describe("server", () => {
  test("three clients editing concurrently converge with the server", async () => {
    const srv = await startServer({ port: 0, dataDir: null });
    const url = `ws://127.0.0.1:${srv.port}/ws/room1`;
    const clients = ["ann", "ben", "cyd"].map((r) => new TestClient(url, r));
    for (const c of clients) await c.connect();
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const c = r.pick(clients);
      if (c.doc.length > 5 && r.next() < 0.3) {
        const at = r.int(c.doc.length - 2);
        const op = c.doc.delete(at, 2);
        if (op) c.send([op]);
      } else {
        c.insert(r.int(c.doc.length + 1), r.pick(["a", "bc", "def", " "]));
      }
      if (i % 25 === 0) await new Promise((ok) => setTimeout(ok, 1)); // let messages interleave
    }
    const room = srv.rooms.get("room1")!;
    await settle(() => clients.every((c) => c.doc.text() === room.doc.text() && c.doc.opCount === room.doc.opCount));
    assert.ok(room.doc.length > 0);
    for (const c of clients) await c.close();
    await srv.close();
  });

  test("edits survive a restart, and a client that was offline catches up both ways", async () => {
    const dataDir = tempDir();
    let srv = await startServer({ port: 0, dataDir });
    let url = `ws://127.0.0.1:${srv.port}/ws/notes`;
    const ann = new TestClient(url, "ann");
    await ann.connect();
    ann.insert(0, "shopping list:\n");
    const ben = new TestClient(url, "ben");
    await ben.connect();
    await settle(() => ben.doc.text() === "shopping list:\n");
    ben.insert(15, "- eggs\n");
    await settle(() => ann.doc.text() === "shopping list:\n- eggs\n");
    await ann.close();
    await ben.close();
    await srv.close();

    // Ann edits offline while the server is down
    ann.doc.insert(ann.doc.length, "- milk\n");

    srv = await startServer({ port: 0, dataDir });
    url = `ws://127.0.0.1:${srv.port}/ws/notes`;
    assert.equal(srv.rooms.size, 0);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/rooms/notes/text`);
    assert.equal(await res.text(), "shopping list:\n- eggs\n", "restored from the op log");

    const annAgain = Object.assign(new TestClient(url, "ann"), { doc: ann.doc });
    await annAgain.connect(); // pushes the offline edit
    const cyd = new TestClient(url, "cyd");
    await cyd.connect();
    await settle(() => cyd.doc.text() === "shopping list:\n- eggs\n- milk\n");
    await annAgain.close();
    await cyd.close();
    await srv.close();
  });

  test("presence is relayed and cleared on leave", async () => {
    const srv = await startServer({ port: 0, dataDir: null });
    const url = `ws://127.0.0.1:${srv.port}/ws/p`;
    const a = new TestClient(url, "a");
    await a.connect();
    const joined = a.waitFor((m) => m.type === "presence" && m.peer.replica === "b");
    const b = new TestClient(url, "b");
    await b.connect();
    await joined;
    const moved = a.waitFor((m) => m.type === "presence" && m.peer.cursor !== null);
    b.ws.send(JSON.stringify({ type: "presence", cursor: { anchor: null, head: null } }));
    await moved;
    const left = a.waitFor((m) => m.type === "leave" && m.replica === "b");
    await b.close();
    await left;
    await a.close();
    await srv.close();
  });

  test("untrusted input: malformed messages close the socket, forged ops are ignored", async () => {
    const srv = await startServer({ port: 0, dataDir: null });
    const url = `ws://127.0.0.1:${srv.port}/ws/sec`;
    const evil = new TestClient(url, "evil");
    await evil.connect();
    // an op claiming to be from someone else
    evil.send([{ t: "ins", id: ["victim", 0], parent: null, side: "R", text: "forged" }]);
    evil.insert(0, "ok");
    await settle(() => srv.rooms.get("sec")!.doc.text() === "ok");
    const closed = new Promise<void>((ok) => evil.ws.addEventListener("close", () => ok()));
    evil.ws.send(JSON.stringify({ type: "ops", ops: [{ t: "ins", id: ["evil", -1], parent: null, side: "X", text: "" }] }));
    await closed;
    assert.equal(evil.closeCode, 1008);
    await srv.close();
  });

  test("http routes", async () => {
    const srv = await startServer({ port: 0, dataDir: null });
    const base = `http://127.0.0.1:${srv.port}`;
    const page = await fetch(`${base}/r/anything`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /editor-page\.js/);
    assert.equal((await fetch(`${base}/playground`)).status, 200);
    assert.equal((await fetch(`${base}/style.css`)).headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await fetch(`${base}/js/crdt/doc.js`)).status, 200);
    assert.notEqual((await fetch(`${base}/js/..%2f..%2fpackage.json`)).status, 200);
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${base}/api/rooms/bad%20name`)).status, 400);
    // pages don't create rooms; only the API and WebSocket connections do
    assert.deepEqual(await (await fetch(`${base}/api/rooms`)).json(), []);
    await srv.close();
  });
});
