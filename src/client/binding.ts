/**
 * Binds a Doc to a <textarea>: local typing becomes CRDT operations, remote operations
 * patch the text without moving the user's caret, and undo/redo only ever touches the
 * user's own edits.
 */

import type { Doc } from "../crdt/doc.js";
import type { Change, Id, Op } from "../crdt/types.js";
import type { Cursor } from "../net/protocol.js";

/** Work out what an input event changed, using the caret to resolve ambiguous repeats. */
export function diffInput(before: string, after: string, caret: number): { index: number; deleted: number; inserted: string } {
  // text after the caret must be untouched for typing, pasting and deleting
  const maxSuffix = Math.min(before.length, after.length - caret);
  let suffix = 0;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const maxPrefix = Math.min(before.length, after.length) - suffix;
  let prefix = 0;
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  return { index: prefix, deleted: before.length - prefix - suffix, inserted: after.slice(prefix, after.length - suffix) };
}

type UndoStep = { kind: "inserted"; ids: Id[] } | { kind: "deleted"; ids: Id[]; text: string };

interface UndoGroup {
  steps: UndoStep[];
  at: number;
}

export class TextareaBinding {
  /** What the textarea showed after we last synchronised with the doc. */
  private shadow: string;
  private undoStack: UndoGroup[] = [];
  private redoStack: UndoGroup[] = [];
  private lastWasTyping = false;

  constructor(
    readonly doc: Doc,
    readonly textarea: HTMLTextAreaElement,
    /** Called with every op this editor creates, to send to other replicas. */
    private readonly emit: (ops: Op[]) => void,
    /** Called after the text or the selection changed (for redrawing cursors). */
    private readonly onChange: () => void = () => {},
  ) {
    this.shadow = doc.text();
    textarea.value = this.shadow;
    textarea.addEventListener("input", () => this.flushLocal());
    textarea.addEventListener("keydown", (e) => this.onKeyDown(e));
    textarea.addEventListener("beforeinput", (e) => {
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
        e.preventDefault();
        if (e.inputType === "historyUndo") this.undo();
        else this.redo();
      }
    });
  }

  /** Turn whatever the user did since the last sync into ops. */
  flushLocal(): void {
    const value = this.textarea.value;
    if (value === this.shadow) return;
    const { index, deleted, inserted } = diffInput(this.shadow, value, this.textarea.selectionEnd);
    const ops: Op[] = [];
    const steps: UndoStep[] = [];
    if (deleted) {
      const ids = this.doc.idsInRange(index, deleted);
      const text = this.shadow.slice(index, index + deleted);
      const op = this.doc.delete(index, deleted);
      if (op) ops.push(op);
      steps.push({ kind: "deleted", ids, text });
    }
    if (inserted) {
      const op = this.doc.insert(index, inserted);
      ops.push(op);
      steps.push({ kind: "inserted", ids: idsOf(op) });
    }
    this.shadow = value;
    this.record(steps, !deleted && inserted.length === 1);
    this.emit(ops);
    this.onChange();
  }

  /** Apply remote operations to the doc and patch the textarea, keeping the caret in place. */
  receive(ops: Op[]): void {
    this.flushLocal();
    const changes = this.doc.apply(ops);
    if (changes.length) this.patch(changes);
  }

  private patch(changes: Change[]): void {
    const ta = this.textarea;
    const scroll = ta.scrollTop;
    for (const c of changes) {
      // "preserve" moves the selection exactly as an index transformation would
      ta.setRangeText(c.inserted, c.index, c.index + c.deleted, "preserve");
    }
    ta.scrollTop = scroll;
    this.shadow = ta.value;
    this.onChange();
  }

  /** The local selection as anchors that survive concurrent edits. */
  cursor(): Cursor {
    const ta = this.textarea;
    const [anchor, head] = ta.selectionDirection === "backward" ? [ta.selectionEnd, ta.selectionStart] : [ta.selectionStart, ta.selectionEnd];
    return { anchor: this.doc.anchorAt(anchor), head: this.doc.anchorAt(head) };
  }

  // -------------------------------------------------------------------------
  // Undo/redo of the user's own edits
  // -------------------------------------------------------------------------

  private record(steps: UndoStep[], typing: boolean): void {
    if (!steps.length) return;
    this.redoStack = [];
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    // merge a burst of typing into one undo step, like native editors do
    if (typing && this.lastWasTyping && top && now - top.at < 1000) {
      top.steps.push(...steps);
      top.at = now;
    } else {
      this.undoStack.push({ steps, at: now });
      if (this.undoStack.length > 500) this.undoStack.shift();
    }
    this.lastWasTyping = typing;
  }

  undo(): void {
    this.flushLocal();
    const group = this.undoStack.pop();
    if (group) this.redoStack.push(this.invert(group));
    this.lastWasTyping = false;
  }

  redo(): void {
    this.flushLocal();
    const group = this.redoStack.pop();
    if (group) this.undoStack.push(this.invert(group));
    this.lastWasTyping = false;
  }

  /** Revert a group's steps (newest first); returns the group that would redo them. */
  private invert(group: UndoGroup): UndoGroup {
    const inverse: UndoStep[] = [];
    const ops: Op[] = [];
    const changes: Change[] = [];
    let caret = -1;
    for (const step of [...group.steps].reverse()) {
      if (step.kind === "inserted") {
        // delete those characters again (any that others already deleted are skipped)
        const alive = step.ids.filter((id) => this.doc.indexOfId(id) >= 0);
        const text = alive.map((id) => this.doc.valueOf(id)).join("");
        const { op, changes: ch } = this.doc.deleteIds(alive);
        if (op) ops.push(op);
        changes.push(...ch);
        if (ch.length) caret = ch[0].index;
        inverse.push({ kind: "deleted", ids: alive, text });
      } else {
        // put the text back where its tombstones are
        if (!step.text) continue;
        const at = Math.min(Math.max(0, this.doc.positionOfId(step.ids[0])), this.doc.length);
        const op = this.doc.insert(at, step.text);
        ops.push(op);
        changes.push({ index: at, deleted: 0, inserted: step.text });
        caret = at + step.text.length;
        inverse.push({ kind: "inserted", ids: idsOf(op) });
      }
    }
    if (changes.length) {
      this.patch(changes);
      if (caret >= 0) this.textarea.setSelectionRange(caret, caret);
    }
    this.emit(ops);
    this.onChange();
    return { steps: inverse.reverse(), at: Date.now() };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      this.redo();
    }
  }
}

function idsOf(op: Op): Id[] {
  if (op.t !== "ins") return [];
  // one id per UTF-16 code unit, matching how the doc counts characters
  return Array.from({ length: op.text.length }, (_, k) => [op.id[0], op.id[1] + k] as Id);
}
