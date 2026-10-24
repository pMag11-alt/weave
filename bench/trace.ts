/**
 * Replays a real editing trace through the CRDT: the keystrokes of Martin Kleppmann
 * writing a LaTeX paper (automerge-perf, CC BY 4.0), 259,778 edits.
 *
 *   npm run bench
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { Doc } from "../src/crdt/doc.js";
import type { Op } from "../src/crdt/types.js";

const URL = "https://raw.githubusercontent.com/automerge/automerge-perf/master/edit-by-index/editing-trace.js";
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "weave");

async function loadTrace(): Promise<{ edits: [number, number, string?][]; finalText: string }> {
  const file = join(CACHE, "editing-trace.js");
  if (!existsSync(file)) {
    console.log(`downloading ${URL}`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, await res.text());
  }
  // the trace is a JS file with two array/string literals; evaluate it in an empty sandbox
  return runInNewContext(`${readFileSync(file, "utf8")}\n;({ edits, finalText })`, Object.create(null), { timeout: 10_000 });
}

function mb(bytes: number): string {
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

const { edits, finalText } = await loadTrace();
console.log(`${edits.length.toLocaleString()} edits, final document ${finalText.length.toLocaleString()} characters\n`);

global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
let t = performance.now();
const doc = new Doc("author");
const ops: Op[] = [];
for (const [pos, del, ins] of edits) {
  if (del) {
    const op = doc.delete(pos, del);
    if (op) ops.push(op);
  }
  if (ins) ops.push(doc.insert(pos, ins));
}
const localMs = performance.now() - t;
if (doc.text() !== finalText) throw new Error("final text doesn't match the trace!");
global.gc?.();
const heap = process.memoryUsage().heapUsed - heapBefore;

t = performance.now();
const replica = new Doc("reader");
replica.apply(ops);
const remoteMs = performance.now() - t;
if (replica.text() !== finalText) throw new Error("remote replica diverged!");

const wire = JSON.stringify(ops).length;
const row = (name: string, ms: number) => console.log(`${name.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms   ${Math.round(edits.length / (ms / 1000)).toLocaleString().padStart(10)} edits/s`);
row("local editing (as typed)", localMs);
row("remote replay (as received)", remoteMs);
console.log(`\nmemory for the document       ${mb(heap)}${global.gc ? "" : " (run with --expose-gc for an exact figure)"}`);
console.log(`operations sent over the wire  ${ops.length.toLocaleString()} (${mb(wire)} of JSON)`);
console.log("final text matches the trace ✓");
