import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Doc } from "../src/crdt/doc.js";
import type { Op } from "../src/crdt/types.js";
import { rng } from "./helpers.js";

/** Apply a list of index-based changes to a plain string, as an editor would. */
function patch(text: string, changes: { index: number; deleted: number; inserted: string }[]): string {
  for (const c of changes) text = text.slice(0, c.index) + c.inserted + text.slice(c.index + c.deleted);
  return text;
}

describe("local editing", () => {
  test("behaves like a string", () => {
    const d = new Doc("a");
    d.insert(0, "hello");
    d.insert(5, " world");
    d.insert(0, ">> ");
    d.delete(3, 5);
    d.insert(3, "goodbye,");
    assert.equal(d.text(), ">> goodbye, world");
    assert.equal(d.length, 17);
    d.checkInvariants();
  });

  test("random edits match a plain string model", () => {
    const r = rng(1);
    const d = new Doc("a");
    let model = "";
    for (let i = 0; i < 3000; i++) {
      if (model.length && r.next() < 0.4) {
        const at = r.int(model.length);
        const n = 1 + r.int(Math.min(5, model.length - at));
        d.delete(at, n);
        model = model.slice(0, at) + model.slice(at + n);
      } else {
        const at = r.int(model.length + 1);
        const s = "abcdefghij".slice(0, 1 + r.int(4));
        d.insert(at, s);
        model = model.slice(0, at) + s + model.slice(at);
      }
    }
    assert.equal(d.text(), model);
    d.checkInvariants();
  });

  test("rejects out-of-range edits", () => {
    const d = new Doc("a");
    d.insert(0, "abc");
    assert.throws(() => d.insert(4, "x"), RangeError);
    assert.throws(() => d.delete(2, 2), RangeError);
    assert.equal(d.delete(1, 0), null);
  });

  test("replica ids are validated", () => {
    assert.throws(() => new Doc(""));
    assert.throws(() => new Doc("a:b"));
  });
});

describe("convergence", () => {
  /**
   * Several replicas edit concurrently; every op is delivered to every other replica
   * in a random order (with duplicates). All replicas must end with the same text and
   * the same internal structure, and each replica's incremental changes must reproduce
   * its text.
   */
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`random concurrent edits converge (seed ${seed})`, () => {
      const r = rng(seed * 7919);
      const names = ["ann", "bob", "cyd", "dee"].slice(0, 2 + (seed % 3));
      const docs = names.map((n) => new Doc(n));
      const mirrors = docs.map(() => "");
      const inbox: Op[][] = docs.map(() => []);
      for (let round = 0; round < 150; round++) {
        const i = r.int(docs.length);
        const d = docs[i];
        let op: Op | null;
        if (d.length && r.next() < 0.35) {
          const at = r.int(d.length);
          op = d.delete(at, 1 + r.int(Math.min(3, d.length - at)));
        } else {
          op = d.insert(r.int(d.length + 1), r.pick(["x", "yz", "hello", "!", "abc"]));
        }
        mirrors[i] = d.text();
        if (op) for (let j = 0; j < docs.length; j++) if (j !== i) inbox[j].push(op);
        // deliver a random subset, in random order, sometimes twice
        if (r.next() < 0.3) {
          const j = r.int(docs.length);
          const batch = r.shuffle(inbox[j]).slice(0, r.int(inbox[j].length + 1));
          inbox[j] = inbox[j].filter((o) => !batch.includes(o) || r.next() < 0.2);
          mirrors[j] = patch(mirrors[j], docs[j].apply(batch));
          assert.equal(mirrors[j], docs[j].text(), "changes must describe the visible edit");
        }
      }
      for (let j = 0; j < docs.length; j++) {
        mirrors[j] = patch(mirrors[j], docs[j].apply(r.shuffle(inbox[j])));
        assert.equal(docs[j].pendingCount, 0);
        assert.equal(mirrors[j], docs[j].text());
        docs[j].checkInvariants();
      }
      const texts = docs.map((d) => d.text());
      assert.ok(texts.every((t) => t === texts[0]), `diverged: ${JSON.stringify(texts)}`);
      const shapes = docs.map((d) => JSON.stringify(d.elements()));
      assert.ok(shapes.every((s) => s === shapes[0]), "internal trees differ");
    });
  }

  test("ops that arrive before their dependencies wait in a buffer", () => {
    const a = new Doc("a");
    const op1 = a.insert(0, "abc");
    const op2 = a.insert(3, "def");
    const op3 = a.delete(1, 4) as Op;
    const b = new Doc("b");
    b.apply(op3);
    b.apply(op2);
    assert.equal(b.text(), "");
    assert.equal(b.pendingCount, 2);
    b.apply(op1);
    assert.equal(b.text(), "af");
    assert.equal(b.pendingCount, 0);
  });

  test("delta sync with version vectors", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    a.insert(0, "shared ");
    b.apply(a.opsSince(b.versionVector()));
    a.insert(7, "from a");
    b.insert(0, "[b] ");
    // exchange only what the other side is missing
    const toB = a.opsSince(b.versionVector());
    const toA = b.opsSince(a.versionVector());
    assert.equal(toB.length, 1);
    assert.equal(toA.length, 1);
    b.apply(toB);
    a.apply(toA);
    assert.equal(a.text(), "[b] shared from a");
    assert.equal(b.text(), a.text());
    assert.ok(a.covers(b.versionVector()) && b.covers(a.versionVector()));
    assert.deepEqual(a.opsSince(b.versionVector()), []);
  });

  test("concurrent deletes of the same text are idempotent", () => {
    const a = new Doc("a");
    a.insert(0, "abcdef");
    const b = new Doc("b");
    b.apply(a.opsSince({}));
    const da = a.delete(1, 3) as Op;
    const db = b.delete(2, 3) as Op;
    a.apply(db);
    b.apply(da);
    // the union of both deletions is gone
    assert.equal(a.text(), "af");
    assert.equal(b.text(), "af");
  });
});

describe("intention preservation", () => {
  function syncAll(...docs: Doc[]) {
    for (const x of docs) for (const y of docs) if (x !== y) y.apply(x.opsSince(y.versionVector()));
  }

  test("concurrent typing at the same spot does not interleave (forward)", () => {
    const a = new Doc("a");
    a.insert(0, "[]");
    const b = new Doc("b");
    syncAll(a, b);
    // both type a word one character at a time at the same position
    for (const [i, ch] of [..."alice"].entries()) a.insert(1 + i, ch);
    for (const [i, ch] of [..."bob"].entries()) b.insert(1 + i, ch);
    syncAll(a, b);
    assert.ok(["[alicebob]", "[bobalice]"].includes(a.text()), a.text());
    assert.equal(a.text(), b.text());
  });

  test("concurrent typing does not interleave (backward, i.e. always inserting at the same index)", () => {
    const a = new Doc("a");
    a.insert(0, "[]");
    const b = new Doc("b");
    syncAll(a, b);
    for (const ch of [..."ecila"]) a.insert(1, ch); // ends up as "alice"
    for (const ch of [..."bob"]) b.insert(1, ch);
    syncAll(a, b);
    assert.ok(["[alicebob]", "[bobalice]"].includes(a.text()), a.text());
  });

  test("an insert next to concurrently deleted text keeps its place", () => {
    const a = new Doc("a");
    a.insert(0, "The quick fox");
    const b = new Doc("b");
    syncAll(a, b);
    a.delete(4, 6); // "The fox"
    b.insert(10, "brown "); // "The quick brown fox"
    syncAll(a, b);
    assert.equal(a.text(), "The brown fox");
    assert.equal(b.text(), "The brown fox");
  });

  test("cursors anchored to characters follow remote edits", () => {
    const a = new Doc("a");
    a.insert(0, "hello world");
    const b = new Doc("b");
    syncAll(a, b);
    const cursor = b.anchorAt(6); // before "world"
    a.insert(0, ">>> ");
    a.delete(4, 5); // remove "hello"
    syncAll(a, b);
    assert.equal(b.text(), ">>>  world");
    assert.equal(b.indexOfAnchor(cursor), 5);
    assert.equal(b.indexOfAnchor(null), 0);
    assert.equal(b.indexOfAnchor(b.anchorAt(b.length)), b.length);
  });
});

describe("scale", () => {
  test("100k single-character edits stay fast and consistent", () => {
    const d = new Doc("a");
    const r = rng(9);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      if (d.length > 10 && r.next() < 0.2) d.delete(r.int(d.length), 1);
      else d.insert(r.int(d.length + 1), "x");
    }
    const ms = performance.now() - t0;
    d.checkInvariants();
    assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
  });
});
