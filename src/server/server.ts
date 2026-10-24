/**
 * HTTP + WebSocket server: serves the editor, the playground and a small JSON API, and
 * relays CRDT operations between the clients of each room.
 */

import { readFile, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { type ClientMessage, type ServerMessage, parseClientMessage } from "../net/protocol.js";
import { CloseCode, type WebSocketConnection, accept } from "../net/websocket.js";
import { type Client, ROOM_NAME, Room } from "./room.js";

/** Repository root: this file is compiled to dist/src/server/server.js. */
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PUBLIC = join(ROOT, "public");
const JS = join(ROOT, "dist", "src");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".json": "application/json",
  ".png": "image/png",
};

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Where room logs are kept; null keeps everything in memory. */
  dataDir?: string | null;
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const dataDir = opts.dataDir === undefined ? join(ROOT, "data") : opts.dataDir;
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const sockets = new Set<WebSocketConnection>();

  const room = (name: string): Room => {
    let r = rooms.get(name);
    if (!r) rooms.set(name, (r = new Room(name, dataDir)));
    return r;
  };

  const server = createServer((req, res) => {
    handleHttp(req, res, rooms, room).catch((err) => {
      log(`error: ${err}`);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    });
  });

  server.on("upgrade", (req, socket) => {
    const match = /^\/ws\/([^/?#]+)/.exec(req.url ?? "");
    if (!match || !ROOM_NAME.test(match[1])) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = accept(req, socket, { heartbeatMs: opts.heartbeatMs ?? 30_000 });
    if (!ws) return;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    serveClient(ws, room(match[1]), log);
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 8080, opts.host ?? "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    rooms,
    close: () =>
      new Promise<void>((ok) => {
        for (const ws of sockets) ws.close(CloseCode.GoingAway, "server shutting down");
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

function serveClient(ws: WebSocketConnection, room: Room, log: (m: string) => void): void {
  let client: Client | null = null;
  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));

  ws.on("message", (text: string) => {
    const msg: ClientMessage | null = parseClientMessage(text);
    if (!msg) {
      ws.close(CloseCode.PolicyViolation, "malformed message");
      return;
    }
    if (msg.type === "hello") {
      if (client) return;
      client = { replica: msg.replica, peer: { replica: msg.replica, name: msg.name, color: msg.color, cursor: null }, send };
      send({ type: "welcome", vv: room.doc.versionVector(), ops: room.doc.opsSince(msg.vv), peers: room.peers(msg.replica) });
      room.join(client);
      log(`${room.name}: ${msg.name} (${msg.replica}) joined, ${room.clients.size} online`);
      return;
    }
    if (!client) {
      ws.close(CloseCode.PolicyViolation, "say hello first");
      return;
    }
    if (msg.type === "ops") {
      room.receive(client, msg.ops);
    } else if (msg.type === "presence") {
      client.peer = { ...client.peer, cursor: msg.cursor, name: msg.name ?? client.peer.name, color: msg.color ?? client.peer.color };
      room.updatePresence(client);
    }
  });

  ws.on("close", () => {
    if (client) {
      room.leave(client);
      log(`${room.name}: ${client.peer.name} left, ${room.clients.size} online`);
    }
  });
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, rooms: Map<string, Room>, room: (n: string) => Room): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body, null, 2) + "\n");
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (path === "/api/rooms") {
    json(
      200,
      [...rooms.values()].map((r) => ({ name: r.name, length: r.doc.length, ops: r.doc.opCount, online: r.clients.size })),
    );
    return;
  }
  const api = /^\/api\/rooms\/([^/]+)(\/text)?$/.exec(path);
  if (api) {
    if (!ROOM_NAME.test(api[1])) return json(400, { error: "bad room name" });
    const r = room(api[1]);
    if (api[2]) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(r.doc.text());
      return;
    }
    return json(200, { name: r.name, text: r.doc.text(), ops: r.doc.opCount, online: [...r.clients.values()].map((c) => c.peer.name) });
  }
  if (path === "/") return sendFile(res, join(PUBLIC, "index.html"));
  if (path === "/playground/") {
    res.writeHead(301, { location: "/playground" }).end();
    return;
  }
  if (path === "/playground") return sendFile(res, join(PUBLIC, "playground.html"));
  if (/^\/r\/[^/]+\/?$/.test(path)) return sendFile(res, join(PUBLIC, "editor.html"));
  if (path.startsWith("/js/")) return sendFile(res, safeJoin(JS, path.slice(4)));
  return sendFile(res, safeJoin(PUBLIC, path.slice(1)));
}

/** Join without letting "../" escape `base`. */
function safeJoin(base: string, rel: string): string | null {
  const full = normalize(join(base, rel));
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function sendFile(res: ServerResponse, file: string | null): Promise<void> {
  if (!file) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}
