/**
 * The playground: three peers in one page, each with its own Doc, talking through a
 * simulated network with latency, reordering and an offline switch per peer.
 */

import { Doc } from "../crdt/doc.js";
import type { Op } from "../crdt/types.js";
import type { Cursor } from "../net/protocol.js";
import { TextareaBinding } from "./binding.js";
import { CursorLayer } from "./cursors.js";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

interface SimPeer {
  name: string;
  replica: string;
  color: string;
  doc: Doc;
  binding: TextareaBinding;
  cursors: CursorLayer;
  textarea: HTMLTextAreaElement;
  card: HTMLElement;
  stats: HTMLElement;
  toggle: HTMLInputElement;
  online: boolean;
  sent: number;
  received: number;
  /** What this peer knows about everyone else's cursor. */
  seen: Map<string, Cursor | null>;
}

const PEOPLE = [
  { name: "Ann", replica: "ann", color: "#e5484d" },
  { name: "Ben", replica: "ben", color: "#0090ff" },
  { name: "Cy", replica: "cy", color: "#30a46c" },
];

let peers: SimPeer[] = [];
let latency = 400;
let jitter = true;
let inflight = 0;
/** Bumped on reset so messages from the previous session are dropped. */
let generation = 0;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// ---------------------------------------------------------------------------
// The simulated network
// ---------------------------------------------------------------------------

function transmit(from: SimPeer, to: SimPeer, deliver: () => void): void {
  const gen = generation;
  inflight++;
  const delay = latency * (jitter ? 0.3 + Math.random() * 1.4 : 1);
  setTimeout(() => {
    if (gen !== generation) return;
    inflight--;
    // a link that went down while the message was in flight loses it; the version-vector
    // sync on reconnect repairs that
    if (from.online && to.online) deliver();
    refresh();
  }, delay);
}

function sendOps(from: SimPeer, to: SimPeer, ops: Op[]): void {
  if (!ops.length) return;
  from.sent += ops.length;
  transmit(from, to, () => {
    to.binding.receive(ops);
    to.received += ops.length;
  });
}

function broadcastOps(from: SimPeer, ops: Op[]): void {
  if (!from.online) return; // kept locally; synced on reconnect
  for (const p of peers) if (p !== from && p.online) sendOps(from, p, ops);
}

function broadcastCursor(from: SimPeer): void {
  if (!from.online) return;
  const cursor = document.activeElement === from.textarea ? from.binding.cursor() : null;
  for (const p of peers) {
    if (p !== from && p.online) transmit(from, p, () => p.seen.set(from.replica, cursor));
  }
}

/** Anti-entropy: exchange exactly the operations each side is missing. */
function resync(peer: SimPeer): void {
  for (const q of peers) {
    if (q === peer || !q.online) continue;
    sendOps(q, peer, q.doc.opsSince(peer.doc.versionVector()));
    sendOps(peer, q, peer.doc.opsSince(q.doc.versionVector()));
  }
}

function setOnline(peer: SimPeer, online: boolean): void {
  peer.online = online;
  peer.toggle.checked = online;
  peer.card.classList.toggle("offline", !online);
  if (online) {
    resync(peer);
    broadcastCursor(peer);
  }
  refresh();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function build(initial: string): void {
  generation++;
  inflight = 0;
  const container = $("#peers");
  container.replaceChildren();
  // everyone starts from the same, already-synced text
  const docs = PEOPLE.map((who) => new Doc(who.replica));
  if (initial) {
    const op = docs[0].insert(0, initial);
    for (const d of docs.slice(1)) d.apply(op);
  }
  peers = PEOPLE.map((who, i) => {
    const card = document.createElement("div");
    card.className = "peer";
    card.style.setProperty("--c", who.color);
    card.innerHTML = `
      <div class="peer-head">
        <strong>${who.name}</strong>
        <label class="toggle"><input type="checkbox" checked /> online</label>
      </div>
      <div class="editor-box"><textarea spellcheck="false" aria-label="${who.name}'s copy"></textarea></div>
      <div class="peer-stats"></div>`;
    container.appendChild(card);
    const textarea = card.querySelector("textarea") as HTMLTextAreaElement;
    const doc = docs[i];
    const peer = {
      ...who,
      doc,
      textarea,
      card,
      stats: card.querySelector(".peer-stats") as HTMLElement,
      toggle: card.querySelector("input") as HTMLInputElement,
      online: true,
      sent: 0,
      received: 0,
      seen: new Map(),
    } as unknown as SimPeer;
    peer.cursors = new CursorLayer(textarea);
    peer.binding = new TextareaBinding(
      doc,
      textarea,
      (ops) => {
        broadcastOps(peer, ops);
        broadcastCursor(peer);
      },
      () => refresh(),
    );
    peer.toggle.addEventListener("change", () => setOnline(peer, peer.toggle.checked));
    const cursorMoved = () => broadcastCursor(peer);
    textarea.addEventListener("keyup", cursorMoved);
    textarea.addEventListener("mouseup", cursorMoved);
    textarea.addEventListener("focus", cursorMoved);
    textarea.addEventListener("blur", cursorMoved);
    textarea.addEventListener("scroll", () => drawCursors(peer));
    return peer;
  });
  const select = $<HTMLSelectElement>("#tree-peer");
  const chosen = select.value || "ann";
  select.replaceChildren(...peers.map((p) => new Option(p.name, p.replica, false, p.replica === chosen)));
  $("#caption").textContent = "";
  refresh();
}

function drawCursors(peer: SimPeer): void {
  const carets = [];
  for (const other of peers) {
    const c = peer.seen.get(other.replica);
    if (other === peer || !c) continue;
    if (c.head && peer.doc.positionOfId(c.head) < 0) continue; // we haven't seen that character yet
    carets.push({ id: other.replica, name: other.name, color: other.color, from: peer.doc.indexOfAnchor(c.anchor), to: peer.doc.indexOfAnchor(c.head) });
  }
  peer.cursors.render(carets);
}

let frame = 0;
function refresh(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const p of peers) {
      p.stats.textContent = `${p.doc.length} chars · sent ${p.sent} · got ${p.received} · buffered ${p.doc.pendingCount}`;
      drawCursors(p);
    }
    renderStatus();
    renderTree();
  });
}

function renderStatus(): void {
  const el = $("#converged");
  const texts = new Set(peers.map((p) => p.doc.text()));
  const offline = peers.filter((p) => !p.online).map((p) => p.name);
  if (offline.length) {
    el.dataset.state = texts.size === 1 ? "ok" : "diverged";
    el.textContent =
      texts.size === 1
        ? `${offline.join(" and ")} offline · copies still identical`
        : `${offline.join(" and ")} offline · copies differ until they reconnect`;
  } else if (inflight > 0 || texts.size > 1) {
    el.dataset.state = "syncing";
    el.textContent = `syncing… ${inflight} message${inflight === 1 ? "" : "s"} in flight`;
  } else {
    el.dataset.state = "ok";
    el.textContent = "✓ all three copies are identical";
  }
}

function renderTree(): void {
  const peer = peers.find((p) => p.replica === $<HTMLSelectElement>("#tree-peer").value) ?? peers[0];
  const svg = $("#tree") as unknown as SVGSVGElement;
  const all = peer.doc.elements();
  const MAX = 160;
  const els = all.slice(0, MAX);
  $("#tree-size").textContent =
    `${all.length} node${all.length === 1 ? "" : "s"} (${all.filter((e) => e.deleted).length} tombstones)` + (all.length > MAX ? ` · showing the first ${MAX}` : "");
  const colorOf = new Map(PEOPLE.map((p) => [p.replica, p.color]));
  const index = new Map(els.map((e, i) => [`${e.id[0]}:${e.id[1]}`, i]));
  const maxDepth = Math.max(1, ...els.map((e) => e.depth));
  const dx = 24;
  const dy = maxDepth > 14 ? Math.max(7, 340 / maxDepth) : 26;
  const X = (i: number) => 26 + (i + 1) * dx;
  const Y = (depth: number) => 18 + depth * dy;
  const width = X(els.length) + 10;
  const height = Y(maxDepth) + 22;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const parts: string[] = [];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  els.forEach((e, i) => {
    const pi = e.parent ? index.get(`${e.parent[0]}:${e.parent[1]}`) : -1;
    if (pi === undefined) return;
    const pd = e.parent ? els[pi].depth : 0;
    const color = e.side === "L" ? "var(--left-edge)" : "var(--right-edge)";
    parts.push(`<line x1="${X(pi)}" y1="${Y(pd)}" x2="${X(i)}" y2="${Y(e.depth)}" stroke="${color}" stroke-width="1.6" opacity="${e.deleted ? 0.35 : 0.9}"/>`);
  });
  parts.push(`<rect x="${X(-1) - 13}" y="${Y(0) - 9}" width="26" height="18" rx="4" fill="var(--surface-2)" stroke="var(--border)"/>`);
  parts.push(`<text x="${X(-1)}" y="${Y(0) + 4}" text-anchor="middle" style="font-size:9px">root</text>`);
  els.forEach((e, i) => {
    const ch = e.value === " " ? "␣" : e.value === "\n" ? "↵" : e.value;
    const ring = colorOf.get(e.id[0]) ?? "var(--muted)";
    const tip = `${e.id[0]}:${e.id[1]}${e.deleted ? " (deleted)" : ""}, ${e.side === "L" ? "left" : "right"} child of ${e.parent ? `${e.parent[0]}:${e.parent[1]}` : "root"}`;
    parts.push(
      `<g opacity="${e.deleted ? 0.38 : 1}"><title>${esc(tip)}</title>` +
        `<circle cx="${X(i)}" cy="${Y(e.depth)}" r="10" fill="var(--surface)" stroke="${ring}" stroke-width="2"${e.deleted ? ' stroke-dasharray="3 2"' : ""}/>` +
        `<text x="${X(i)}" y="${Y(e.depth) + 4}" text-anchor="middle"${e.deleted ? ' text-decoration="line-through"' : ""}>${esc(ch)}</text></g>`,
    );
  });
  svg.innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------
// Scripted demos
// ---------------------------------------------------------------------------

/** Type like a person: one character at a time at a caret position. */
async function typeInto(peer: SimPeer, at: number, text: string, delay: number, gen: number): Promise<void> {
  for (const ch of text) {
    if (gen !== generation) return;
    const ta = peer.textarea;
    ta.value = ta.value.slice(0, at) + ch + ta.value.slice(at);
    at += ch.length;
    ta.setSelectionRange(at, at);
    ta.dispatchEvent(new Event("input"));
    await sleep(delay);
  }
}

function deleteRange(peer: SimPeer, from: number, to: number): void {
  const ta = peer.textarea;
  ta.value = ta.value.slice(0, from) + ta.value.slice(to);
  ta.setSelectionRange(from, from);
  ta.dispatchEvent(new Event("input"));
}

async function untilConverged(gen: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (gen !== generation) return false;
    if (inflight === 0 && new Set(peers.map((p) => p.doc.text())).size === 1) return true;
  }
  return false;
}

async function demoTyping(): Promise<void> {
  build("Hello world");
  const gen = generation;
  const [ann, ben] = peers;
  const caption = $("#caption");
  setOnline(ann, false);
  setOnline(ben, false);
  caption.textContent = "Ann and Ben are both offline, and both start typing right after “Hello”…";
  await Promise.all([typeInto(ann, 5, ", brave", 110, gen), typeInto(ben, 5, " new", 160, gen)]);
  if (gen !== generation) return;
  caption.textContent = "…and now they reconnect.";
  await sleep(700);
  setOnline(ann, true);
  setOnline(ben, true);
  if (await untilConverged(gen)) {
    caption.textContent = `Every copy now reads “${ann.doc.text()}”. Each word arrived whole, because each person's typing is its own branch of the tree below. A CRDT without this property could produce something like “Hel, nbrewave”.`;
  }
}

async function demoDelete(): Promise<void> {
  build("The quick brown fox");
  const gen = generation;
  const [ann, ben] = peers;
  const caption = $("#caption");
  setOnline(ann, false);
  setOnline(ben, false);
  caption.textContent = "Offline, Ann deletes “quick brown ” while Ben adds “very ” in the middle of it…";
  await sleep(500);
  deleteRange(ann, 4, 16);
  await typeInto(ben, 10, "very ", 120, gen);
  if (gen !== generation) return;
  await sleep(600);
  setOnline(ann, true);
  setOnline(ben, true);
  if (await untilConverged(gen)) {
    caption.textContent = `Result: “${ann.doc.text()}”. Ann's deletion removed only the characters she saw, so Ben's new word survives, attached to a tombstone (the faded nodes in the tree).`;
  }
}

// ---------------------------------------------------------------------------

$<HTMLInputElement>("#latency").addEventListener("input", (e) => {
  latency = Number((e.target as HTMLInputElement).value);
  $("#latency-value").textContent = `${latency} ms`;
});
$<HTMLInputElement>("#jitter").addEventListener("change", (e) => (jitter = (e.target as HTMLInputElement).checked));
$("#reset").addEventListener("click", () => build("Type here. Try going offline!"));
$("#demo-typing").addEventListener("click", () => void demoTyping());
$("#demo-delete").addEventListener("click", () => void demoDelete());
$("#tree-peer").addEventListener("change", () => refresh());
window.addEventListener("resize", () => refresh());

build("Type here. Try going offline!");

// ?demo=typing or ?demo=delete starts a demo straight away (handy for links)
const demo = new URLSearchParams(location.search).get("demo");
if (demo === "typing") void demoTyping();
if (demo === "delete") void demoDelete();
