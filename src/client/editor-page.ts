/**
 * The collaborative editor page (/r/<room>): connects to the server over WebSocket, keeps
 * working offline, and resynchronises with version vectors when the connection returns.
 */

import { Doc } from "../crdt/doc.js";
import type { Op } from "../crdt/types.js";
import type { ClientMessage, Peer, ServerMessage } from "../net/protocol.js";
import { TextareaBinding } from "./binding.js";
import { CursorLayer } from "./cursors.js";
import { PALETTE, randomName, replicaId } from "./identity.js";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const room = decodeURIComponent(location.pathname.split("/")[2] || "demo");
const textarea = $<HTMLTextAreaElement>("#text");
const statusEl = $<HTMLElement>("#status");
const peopleEl = $<HTMLElement>("#people");
const statsEl = $<HTMLElement>("#stats");
const nameInput = $<HTMLInputElement>("#name");
$<HTMLElement>("#room").textContent = room;
document.title = `${room} · weave`;

/** Per-tab identity (sessionStorage), so two windows of one browser are two people. */
function stored(key: string, fallback: () => string): string {
  try {
    const v = sessionStorage.getItem(key);
    if (v) return v;
    const fresh = fallback();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return fallback();
  }
}

const me = {
  replica: replicaId(),
  name: stored("weave:name", randomName),
  color: stored("weave:color", () => PALETTE[Math.floor(Math.random() * PALETTE.length)]),
};
nameInput.value = me.name;

const doc = new Doc(me.replica);
const peers = new Map<string, Peer>();
let ws: WebSocket | null = null;
let synced = false;
let unsent: Op[] = [];
let retry = 0;

const cursors = new CursorLayer(textarea);
const binding = new TextareaBinding(
  doc,
  textarea,
  (ops) => {
    if (!ops.length) return;
    if (synced) send({ type: "ops", ops });
    else unsent.push(...ops); // offline: these go out when we reconnect
    schedulePresence();
  },
  () => {
    drawCursors();
    updateStats();
  },
);

function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setStatus(state: "online" | "connecting" | "offline", text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  setStatus("connecting", retry ? "reconnecting…" : "connecting…");
  ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(room)}`);
  ws.onopen = () => {
    send({ type: "hello", replica: me.replica, name: me.name, color: me.color, vv: doc.versionVector() });
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data as string) as ServerMessage);
  ws.onclose = () => {
    synced = false;
    peers.clear();
    renderPeople();
    drawCursors();
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setStatus("offline", `offline: edits are kept and will sync (retrying in ${Math.round(delay / 1000)}s)`);
    setTimeout(connect, delay);
  };
}

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome": {
      binding.receive(msg.ops);
      // anything the server hasn't seen from us (offline edits) goes up now
      const mine = doc.opsSince(msg.vv).filter((op) => op.id[0] === me.replica);
      if (mine.length) send({ type: "ops", ops: mine });
      unsent = [];
      synced = true;
      retry = 0;
      peers.clear();
      for (const p of msg.peers) peers.set(p.replica, p);
      setStatus("online", "connected");
      renderPeople();
      sendPresence();
      break;
    }
    case "ops":
      binding.receive(msg.ops);
      break;
    case "presence":
      peers.set(msg.peer.replica, msg.peer);
      renderPeople();
      drawCursors();
      break;
    case "leave":
      peers.delete(msg.replica);
      renderPeople();
      drawCursors();
      break;
    case "error":
      setStatus("offline", msg.message);
      break;
  }
}

// --- presence ---------------------------------------------------------------

let presenceTimer = 0;
function schedulePresence(): void {
  if (!presenceTimer) presenceTimer = window.setTimeout(sendPresence, 40);
}
function sendPresence(): void {
  presenceTimer = 0;
  if (synced) send({ type: "presence", cursor: binding.cursor(), name: me.name, color: me.color });
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === textarea) schedulePresence();
});
textarea.addEventListener("blur", () => synced && send({ type: "presence", cursor: null }));

function drawCursors(): void {
  const carets = [];
  for (const p of peers.values()) {
    if (!p.cursor) continue;
    carets.push({
      id: p.replica,
      name: p.name,
      color: p.color,
      from: doc.indexOfAnchor(p.cursor.anchor),
      to: doc.indexOfAnchor(p.cursor.head),
    });
  }
  cursors.render(carets);
}
textarea.addEventListener("scroll", drawCursors);
window.addEventListener("resize", drawCursors);

function renderPeople(): void {
  const everyone = [{ ...me, replica: me.replica, cursor: null, self: true }, ...[...peers.values()].map((p) => ({ ...p, self: false }))];
  peopleEl.replaceChildren(
    ...everyone.map((p) => {
      const el = document.createElement("span");
      el.className = "avatar";
      el.style.setProperty("--c", p.color);
      el.title = p.self ? `${p.name} (you)` : p.name;
      el.textContent = p.name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      return el;
    }),
  );
}

function updateStats(): void {
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  statsEl.textContent = `${plural(doc.length, "character")} · ${plural(doc.opCount, "operation")}${unsent.length ? ` · ${plural(unsent.length, "edit")} waiting to sync` : ""}`;
}

nameInput.addEventListener("change", () => {
  me.name = nameInput.value.trim().slice(0, 40) || randomName();
  nameInput.value = me.name;
  try {
    sessionStorage.setItem("weave:name", me.name);
  } catch {
    /* private mode: fine */
  }
  renderPeople();
  sendPresence();
});

$<HTMLButtonElement>("#share").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $<HTMLButtonElement>("#share").textContent = "Link copied";
  } catch {
    prompt("Share this link", location.href);
  }
});

renderPeople();
updateStats();
connect();
textarea.focus();
