/**
 * Draws other people's carets (and selections) on top of a <textarea>.
 *
 * Textareas don't expose where a character is on screen, so we lay the text out again in
 * an invisible "mirror" div with identical styling and measure a marker element there.
 */

const COPIED_STYLES = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

export interface RemoteCaret {
  id: string;
  name: string;
  color: string;
  /** Selection start/end as string indices (equal for a plain caret). */
  from: number;
  to: number;
}

export class CursorLayer {
  private readonly layer: HTMLDivElement;
  private readonly mirror: HTMLDivElement;

  constructor(private readonly textarea: HTMLTextAreaElement) {
    const wrap = textarea.parentElement as HTMLElement;
    if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    this.layer = document.createElement("div");
    this.layer.className = "cursor-layer";
    this.layer.setAttribute("aria-hidden", "true");
    wrap.appendChild(this.layer);
    this.mirror = document.createElement("div");
    this.mirror.setAttribute("aria-hidden", "true");
    Object.assign(this.mirror.style, {
      position: "absolute",
      visibility: "hidden",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      top: "0",
      left: "-9999px",
    });
    document.body.appendChild(this.mirror);
  }

  /** Top-left of the character position `index`, relative to the textarea's box. */
  private coords(index: number): { top: number; left: number; height: number } {
    const ta = this.textarea;
    const cs = getComputedStyle(ta);
    for (const p of COPIED_STYLES) this.mirror.style[p] = cs[p];
    // the textarea's content box narrows when it shows a scrollbar
    this.mirror.style.width = `${ta.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
    this.mirror.textContent = ta.value.slice(0, index);
    const marker = document.createElement("span");
    marker.textContent = ta.value.slice(index) || ".";
    this.mirror.appendChild(marker);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    return {
      top: marker.offsetTop - ta.scrollTop + ta.offsetTop,
      left: marker.offsetLeft - ta.scrollLeft + ta.offsetLeft,
      height: lineHeight,
    };
  }

  render(carets: RemoteCaret[]): void {
    const ta = this.textarea;
    const frag = document.createDocumentFragment();
    const len = ta.value.length;
    for (const c of carets) {
      const head = Math.max(0, Math.min(c.to, len));
      const pos = this.coords(head);
      // hide carets scrolled out of view
      if (pos.top < ta.offsetTop - 2 || pos.top + pos.height > ta.offsetTop + ta.clientHeight + 2) continue;
      const caret = document.createElement("div");
      caret.className = "remote-caret";
      caret.style.cssText = `top:${pos.top}px;left:${pos.left}px;height:${pos.height}px;--c:${c.color}`;
      const label = document.createElement("span");
      label.className = "remote-caret-label";
      label.textContent = c.name;
      caret.appendChild(label);
      frag.appendChild(caret);
      if (c.from !== c.to) {
        // a light highlight from the selection's start to its caret, one box per line
        const [a, b] = c.from < c.to ? [c.from, c.to] : [c.to, c.from];
        const start = this.coords(Math.max(0, Math.min(a, len)));
        const end = this.coords(Math.max(0, Math.min(b, len)));
        const right = ta.offsetLeft + ta.clientWidth - parseFloat(getComputedStyle(ta).paddingRight);
        const leftEdge = ta.offsetLeft + parseFloat(getComputedStyle(ta).paddingLeft);
        for (let y = start.top; y <= end.top + 1; y += pos.height) {
          const x0 = y === start.top ? start.left : leftEdge;
          const x1 = Math.abs(y - end.top) < 1 ? end.left : right;
          if (x1 <= x0) continue;
          const box = document.createElement("div");
          box.className = "remote-selection";
          box.style.cssText = `top:${y}px;left:${x0}px;width:${x1 - x0}px;height:${pos.height}px;--c:${c.color}`;
          frag.appendChild(box);
        }
      }
    }
    this.layer.replaceChildren(frag);
  }
}
