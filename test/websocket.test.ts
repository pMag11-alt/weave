import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { describe, test } from "node:test";

import { CloseCode, FrameParser, Opcode, ProtocolError, type WebSocketConnection, accept, acceptKey, encodeFrame } from "../src/net/websocket.js";

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

describe("frames", () => {
  test("the accept key matches RFC 6455's worked example", () => {
    assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("RFC 6455 section 5.7 examples", () => {
    // unmasked "Hello"
    assert.deepEqual(encodeFrame(Opcode.Text, Buffer.from("Hello")), Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    // masked "Hello"
    assert.deepEqual(
      encodeFrame(Opcode.Text, Buffer.from("Hello"), true, MASK),
      Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]),
    );
    const [f] = new FrameParser(true, 1 << 20).push(Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]));
    assert.equal(f.payload.toString(), "Hello");
  });

  test("16- and 64-bit lengths round-trip, byte by byte", () => {
    for (const size of [0, 125, 126, 65535, 65536, 200_000]) {
      const payload = Buffer.alloc(size, 7);
      const wire = encodeFrame(Opcode.Binary, payload, true, MASK);
      const parser = new FrameParser(true, 1 << 20);
      const frames = [];
      // feed in awkward pieces to exercise partial reads
      for (let i = 0; i < wire.length; i += 4093) frames.push(...parser.push(wire.subarray(i, i + 4093)));
      assert.equal(frames.length, 1);
      assert.equal(frames[0].payload.length, size);
      assert.ok(frames[0].payload.every((b) => b === 7));
    }
  });

  test("protocol violations are rejected", () => {
    const parser = () => new FrameParser(true, 1000);
    const err = (bytes: Buffer, code: number = CloseCode.ProtocolError) =>
      assert.throws(
        () => parser().push(bytes),
        (e: unknown) => e instanceof ProtocolError && e.code === code,
      );
    err(encodeFrame(Opcode.Text, Buffer.from("x"))); // unmasked client frame
    err(Buffer.concat([Buffer.from([0xc1]), encodeFrame(Opcode.Text, Buffer.from("x"), true, MASK).subarray(1)])); // RSV1
    err(encodeFrame(0x3, Buffer.from("x"), true, MASK)); // reserved opcode
    err(encodeFrame(Opcode.Ping, Buffer.alloc(126), true, MASK)); // control frame > 125
    err(encodeFrame(Opcode.Ping, Buffer.alloc(1), false, MASK)); // fragmented control frame
    err(encodeFrame(Opcode.Text, Buffer.alloc(1001), true, MASK), CloseCode.TooBig);
  });
});

/** A raw TCP client that speaks just enough WebSocket to misbehave on purpose. */
async function rawClient(port: number): Promise<{ send(b: Buffer): void; received: () => Buffer; closed: Promise<void>; destroy(): void }> {
  const sock = connect(port, "127.0.0.1");
  await new Promise<void>((ok) => sock.once("connect", () => ok()));
  sock.write(
    "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  let data = Buffer.alloc(0);
  sock.on("data", (d) => (data = Buffer.concat([data, d])));
  const closed = new Promise<void>((ok) => sock.on("close", () => ok()));
  await new Promise((ok) => setTimeout(ok, 50));
  const head = data.indexOf("\r\n\r\n");
  assert.match(data.subarray(0, head).toString(), /^HTTP\/1.1 101/);
  assert.match(data.toString(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  const start = head + 4;
  return { send: (b) => sock.write(b), received: () => data.subarray(start), closed, destroy: () => sock.destroy() };
}

describe("connections", () => {
  async function server(onConn: (ws: WebSocketConnection) => void) {
    const srv = createServer();
    srv.on("upgrade", (req, socket) => {
      const ws = accept(req, socket);
      if (ws) onConn(ws);
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const close = () => {
      srv.closeAllConnections();
      srv.close();
    };
    return { srv: { close }, port: (srv.address() as AddressInfo).port };
  }

  test("echo through Node's own WebSocket client, including a 1 MB message", async () => {
    const { srv, port } = await server((ws) => ws.on("message", (m: string) => ws.send(m.toUpperCase())));
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise((ok) => client.addEventListener("open", ok));
    const replies: string[] = [];
    const got = new Promise<void>((ok) =>
      client.addEventListener("message", (e) => {
        replies.push(e.data as string);
        if (replies.length === 2) ok();
      }),
    );
    client.send("héllo, wörld ✓");
    client.send("x".repeat(1 << 20));
    await got;
    assert.equal(replies[0], "HÉLLO, WÖRLD ✓");
    assert.equal(replies[1].length, 1 << 20);
    const closed = new Promise<CloseEvent>((ok) => client.addEventListener("close", (e) => ok(e as CloseEvent)));
    client.close(1000, "bye");
    assert.equal((await closed).code, 1000);
    srv.close();
  });

  test("fragmented messages are reassembled; pings are answered", async () => {
    let message = "";
    const { srv, port } = await server((ws) => ws.on("message", (m: string) => (message = m)));
    const c = await rawClient(port);
    c.send(encodeFrame(Opcode.Text, Buffer.from("frag"), false, MASK));
    c.send(encodeFrame(Opcode.Ping, Buffer.from("p!"), true, MASK)); // control frames may interleave
    c.send(encodeFrame(Opcode.Continuation, Buffer.from("men"), false, MASK));
    c.send(encodeFrame(Opcode.Continuation, Buffer.from("ted"), true, MASK));
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(message, "fragmented");
    const frames = new FrameParser(false, 1 << 20).push(c.received());
    assert.deepEqual(
      frames.map((f) => [f.opcode, f.payload.toString()]),
      [[Opcode.Pong, "p!"]],
    );
    c.destroy();
    srv.close();
  });

  test("invalid UTF-8 closes with 1007, unmasked frames with 1002", async () => {
    const codes: number[] = [];
    const { srv, port } = await server((ws) => ws.on("close", (code: number) => codes.push(code)));
    const a = await rawClient(port);
    a.send(encodeFrame(Opcode.Text, Buffer.from([0xc3, 0x28]), true, MASK));
    await a.closed;
    const b = await rawClient(port);
    b.send(encodeFrame(Opcode.Text, Buffer.from("hi")));
    await b.closed;
    assert.deepEqual(codes, [CloseCode.InvalidData, CloseCode.ProtocolError]);
    const [closeFrame] = new FrameParser(false, 1 << 20).push(a.received());
    assert.equal(closeFrame.opcode, Opcode.Close);
    assert.equal(closeFrame.payload.readUInt16BE(0), CloseCode.InvalidData);
    srv.close();
  });

  test("a client that disappears mid-connection doesn't take the server down", async () => {
    const closes: number[] = [];
    const { srv, port } = await server((ws) => ws.on("close", (code: number) => closes.push(code)));
    const c = await rawClient(port);
    c.send(encodeFrame(Opcode.Text, Buffer.from("half a mess"), false, MASK));
    c.destroy(); // no close frame, just gone (the server may see ECONNRESET)
    try {
      for (let i = 0; i < 50 && !closes.length; i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.deepEqual(closes, [CloseCode.GoingAway]);
    } finally {
      srv.close();
    }
  });

  test("bad handshakes get HTTP errors", async () => {
    const { srv, port } = await server(() => {});
    const reply = async (headers: string) => {
      const sock = connect(port, "127.0.0.1");
      let data = "";
      sock.on("data", (d) => (data += d));
      await new Promise<void>((ok) => sock.once("connect", () => ok()));
      sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`);
      await new Promise<void>((ok) => sock.on("close", () => ok()));
      return data.split("\r\n")[0];
    };
    assert.equal(await reply("Sec-WebSocket-Version: 13\r\n"), "HTTP/1.1 400 Bad Request"); // no key
    assert.equal(await reply("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n"), "HTTP/1.1 426 Upgrade Required");
    srv.close();
  });
});
