/**
 * A WebSocket server endpoint (RFC 6455) on top of Node's HTTP upgrade event, with no
 * dependencies: the opening handshake, frame parsing (masking, fragmentation, 16/64-bit
 * lengths), control frames, UTF-8 validation, the closing handshake and heartbeats.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  Unsupported: 1003,
  NoStatus: 1005,
  InvalidData: 1007,
  PolicyViolation: 1008,
  TooBig: 1009,
  InternalError: 1011,
} as const;

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number = CloseCode.ProtocolError,
  ) {
    super(message);
  }
}

/** Incremental frame decoder: feed it bytes as they arrive, get back complete frames. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private readonly requireMask: boolean,
    private readonly maxPayload: number,
  ) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.parseOne();
      if (!frame) return frames;
      frames.push(frame);
    }
  }

  private parseOne(): Frame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    if (b[0] & 0x70) throw new ProtocolError("reserved bits set without a negotiated extension");
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let pos = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      pos = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("frame too large", CloseCode.TooBig);
      len = Number(big);
      pos = 10;
    }
    if (opcode >= 0x8) {
      if (!fin) throw new ProtocolError("control frames must not be fragmented");
      if (len > 125) throw new ProtocolError("control frame payload over 125 bytes");
    } else if (opcode > Opcode.Binary) {
      throw new ProtocolError(`unknown opcode ${opcode}`);
    }
    if (opcode >= 0xb) throw new ProtocolError(`unknown opcode ${opcode}`);
    if (this.requireMask && !masked) throw new ProtocolError("client frames must be masked");
    if (len > this.maxPayload) throw new ProtocolError("message too big", CloseCode.TooBig);
    const maskLen = masked ? 4 : 0;
    if (b.length < pos + maskLen + len) return null;
    let payload = b.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const key = b.subarray(pos, pos + 4);
      payload = Buffer.from(payload); // don't unmask in place: the buffer may be shared
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    this.buf = b.subarray(pos + maskLen + len);
    return { fin, opcode, payload };
  }
}

/** Encode one frame. Servers send unmasked frames; pass `mask` to act as a client. */
export function encodeFrame(opcode: number, payload: Buffer, fin = true, mask?: Buffer): Buffer {
  const len = payload.length;
  const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = (mask ? 0x80 : 0) | (len < 126 ? len : len < 65536 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  mask.copy(head, 2 + lenBytes);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, body]);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface SocketOptions {
  maxPayload?: number;
  /** Send a ping this often and drop the connection if the previous one got no pong. */
  heartbeatMs?: number;
}

/**
 * One server-side connection. Events: "message" (text: string), "close" (code, reason),
 * "error" (err).
 */
export class WebSocketConnection extends EventEmitter {
  state: "open" | "closing" | "closed" = "open";
  private parser: FrameParser;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private alive = true;
  private heartbeat?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;

  constructor(
    private readonly socket: Duplex,
    private readonly opts: SocketOptions = {},
  ) {
    super();
    const maxPayload = opts.maxPayload ?? 16 << 20;
    this.parser = new FrameParser(true, maxPayload);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.finish(CloseCode.GoingAway, "connection lost"));
    // upgraded sockets allow half-open connections, so a peer that just hangs up only sends
    // FIN: finish our side too, or the connection lingers forever
    socket.on("end", () => {
      socket.end();
      this.finish(CloseCode.GoingAway, "connection lost");
    });
    socket.on("error", (err) => {
      // a peer vanishing (ECONNRESET, EPIPE) is routine; only report it if someone listens,
      // since an unhandled "error" event would crash the whole server
      if (this.listenerCount("error")) this.emit("error", err);
      this.finish(CloseCode.GoingAway, err.message);
    });
    if (opts.heartbeatMs) {
      this.heartbeat = setInterval(() => {
        if (!this.alive) {
          socket.destroy();
          return;
        }
        this.alive = false;
        this.write(Opcode.Ping, Buffer.alloc(0));
      }, opts.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  send(text: string): void {
    if (this.state !== "open") return;
    this.write(Opcode.Text, Buffer.from(text, "utf8"));
  }

  close(code: number = CloseCode.Normal, reason = ""): void {
    if (this.state !== "open") return;
    this.state = "closing";
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(Opcode.Close, payload);
    // the peer should answer with its own close frame; don't wait forever
    this.closeTimer = setTimeout(() => this.socket.destroy(), 2000);
    this.closeTimer.unref();
  }

  private write(opcode: number, payload: Buffer): void {
    if (!this.socket.writable) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      const e = err as ProtocolError;
      this.fail(e.code ?? CloseCode.ProtocolError, e.message);
      return;
    }
    for (const f of frames) {
      if (this.state === "closed") return;
      try {
        this.onFrame(f);
      } catch (err) {
        const e = err as ProtocolError;
        this.fail(e.code ?? CloseCode.ProtocolError, e.message);
        return;
      }
    }
  }

  private onFrame(f: Frame): void {
    this.alive = true;
    switch (f.opcode) {
      case Opcode.Ping:
        this.write(Opcode.Pong, f.payload);
        return;
      case Opcode.Pong:
        return;
      case Opcode.Close: {
        if (f.payload.length === 1) throw new ProtocolError("close frame with a 1-byte payload");
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : CloseCode.NoStatus;
        const reason = f.payload.length > 2 ? utf8.decode(f.payload.subarray(2)) : "";
        if (this.state === "open") {
          // echo the close, then hang up
          this.state = "closing";
          const echo = code === CloseCode.NoStatus ? Buffer.alloc(0) : f.payload.subarray(0, 2);
          this.write(Opcode.Close, echo);
        }
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case Opcode.Continuation: {
        if (!this.fragments.length) throw new ProtocolError("continuation frame without a message to continue");
        this.addFragment(f);
        return;
      }
      default: {
        if (this.fragments.length) throw new ProtocolError("new message started before the previous one finished");
        this.fragmentOpcode = f.opcode;
        this.addFragment(f);
      }
    }
  }

  private addFragment(f: Frame): void {
    this.fragments.push(f.payload);
    this.fragmentBytes += f.payload.length;
    if (this.fragmentBytes > (this.opts.maxPayload ?? 16 << 20)) throw new ProtocolError("message too big", CloseCode.TooBig);
    if (!f.fin) return;
    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    if (this.fragmentOpcode === Opcode.Binary) {
      throw new ProtocolError("binary messages are not supported", CloseCode.Unsupported);
    }
    let text: string;
    try {
      text = utf8.decode(data);
    } catch {
      throw new ProtocolError("text message is not valid UTF-8", CloseCode.InvalidData);
    }
    this.emit("message", text);
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
    this.socket.end();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearInterval(this.heartbeat);
    clearTimeout(this.closeTimer);
    this.emit("close", code, reason);
  }
}

/**
 * Complete the opening handshake for an HTTP upgrade request. Returns null (after
 * answering with an HTTP error) if the request isn't a valid WebSocket handshake.
 */
export function accept(req: IncomingMessage, socket: Duplex, opts: SocketOptions = {}): WebSocketConnection | null {
  const key = req.headers["sec-websocket-key"];
  const valid =
    req.method === "GET" &&
    req.headers.upgrade?.toLowerCase() === "websocket" &&
    /\bupgrade\b/i.test(req.headers.connection ?? "") &&
    typeof key === "string" &&
    Buffer.from(key, "base64").length === 16;
  if (!valid) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  if (req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
  return new WebSocketConnection(socket, opts);
}
