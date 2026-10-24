import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TextareaBinding, diffInput } from "../src/client/binding.js";
import { Doc } from "../src/crdt/doc.js";
import type { Op } from "../src/crdt/types.js";

/** Just enough of HTMLTextAreaElement, with setRangeText's "preserve" rules from the HTML spec. */
class FakeTextarea {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "forward";
  scrollTop = 0;
  private listeners = new Map<string, ((e: unknown) => void)[]>();

  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  private fire(type: string, e: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  setSelectionRange(a: number, b: number): void {
    this.selectionStart = a;
    this.selectionEnd = b;
  }

  setRangeText(text: string, start: number, end: number): void {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    const delta = text.length - (end - start);
    const newEnd = start + text.length;
    if (this.selectionStart > end) this.selectionStart += delta;
    else if (this.selectionStart > start) this.selectionStart = start;
    if (this.selectionEnd > end) this.selectionEnd += delta;
    else if (this.selectionEnd > start) this.selectionEnd = newEnd;
  }

  /** What the browser does when the user types or pastes over the selection. */
  type(text: string): void {
    const at = this.selectionStart;
    this.value = this.value.slice(0, at) + text + this.value.slice(this.selectionEnd);
    this.setSelectionRange(at + text.length, at + text.length);
    this.fire("input");
  }

  backspace(n = 1): void {
    for (let i = 0; i < n; i++) {
      const at = this.selectionStart;
      if (this.selectionEnd > at) {
        this.value = this.value.slice(0, at) + this.value.slice(this.selectionEnd);
      } else {
        this.value = this.value.slice(0, at - 1) + this.value.slice(at);
        this.selectionStart = at - 1;
      }
      this.selectionEnd = this.selectionStart;
      this.fire("input");
    }
  }

  keydown(key: string, mods: { meta?: boolean; shift?: boolean } = {}): void {
    this.fire("keydown", { key, metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, preventDefault() {} });
  }
}

/** Two editors wired together with instant delivery. */
function pair() {
  const ta = new FakeTextarea();
  const tb = new FakeTextarea();
  const holder: { a?: TextareaBinding; b?: TextareaBinding } = {};
  const a = new TextareaBinding(new Doc("a"), ta as unknown as HTMLTextAreaElement, (ops: Op[]) => holder.b?.receive(ops));
  const b = new TextareaBinding(new Doc("b"), tb as unknown as HTMLTextAreaElement, (ops: Op[]) => holder.a?.receive(ops));
  holder.a = a;
  holder.b = b;
  return { a, b, ta, tb };
}

describe("diffInput", () => {
  test("typing, deleting, pasting and replacing", () => {
    assert.deepEqual(diffInput("helo", "hello", 4), { index: 3, deleted: 0, inserted: "l" });
    // a repeated letter: the caret decides which "l" is new
    assert.deepEqual(diffInput("all", "alll", 2), { index: 1, deleted: 0, inserted: "l" });
    assert.deepEqual(diffInput("hello", "hllo", 1), { index: 1, deleted: 1, inserted: "" });
    assert.deepEqual(diffInput("abcdef", "abXYZef", 5), { index: 2, deleted: 2, inserted: "XYZ" });
    assert.deepEqual(diffInput("", "pasted text", 11), { index: 0, deleted: 0, inserted: "pasted text" });
    const none = diffInput("same", "same", 2);
    assert.equal(none.deleted + none.inserted.length, 0);
  });
});

describe("TextareaBinding", () => {
  test("typing propagates and the other caret stays put", () => {
    const { ta, tb } = pair();
    ta.type("hello world");
    assert.equal(tb.value, "hello world");
    tb.setSelectionRange(6, 6); // B's caret before "world"
    ta.setSelectionRange(0, 0);
    ta.type(">> ");
    assert.equal(tb.value, ">> hello world");
    assert.deepEqual([tb.selectionStart, tb.selectionEnd], [9, 9], "B's caret moved with its text");
    tb.type("big ");
    assert.equal(ta.value, ">> hello big world");
  });

  test("undo and redo only touch your own edits", () => {
    const { ta, tb } = pair();
    ta.type("hello");
    tb.setSelectionRange(5, 5);
    tb.type(" world");
    ta.keydown("z", { meta: true }); // undo A's typing
    assert.equal(ta.value, " world");
    assert.equal(tb.value, " world");
    ta.keydown("z", { meta: true, shift: true }); // redo
    assert.equal(ta.value, "hello world");
    assert.equal(tb.value, "hello world");
  });

  test("undoing a deletion puts the text back in the right place despite remote edits", () => {
    const { ta, tb } = pair();
    ta.type("The quick brown fox");
    ta.setSelectionRange(4, 10); // "quick "
    ta.backspace();
    assert.equal(tb.value, "The brown fox");
    tb.setSelectionRange(0, 0);
    tb.type("[!] "); // a remote insertion before the deleted text
    ta.keydown("z", { meta: true });
    assert.equal(ta.value, "[!] The quick brown fox");
    assert.equal(tb.value, ta.value);
  });

  test("a burst of typing undoes as one step", () => {
    const { ta } = pair();
    for (const ch of "abc") ta.type(ch);
    ta.type(" ");
    ta.keydown("z", { meta: true });
    assert.equal(ta.value, "");
  });

  test("cursors are reported as anchors", () => {
    const { a, ta } = pair();
    ta.type("abc");
    ta.setSelectionRange(1, 3);
    const c = a.cursor();
    assert.equal(a.doc.indexOfAnchor(c.anchor), 1);
    assert.equal(a.doc.indexOfAnchor(c.head), 3);
  });
});
