/**
 * Test support shared by test/*.mjs. Kept outside test/ so `node --test` does
 * not run it as a test file of its own.
 *
 * - a DOM just thick enough to run ui.js (built from the ids in index.html);
 * - a fake Anna runtime that records every `llm.complete` argument;
 * - solution markers and a second case with a different solution;
 * - a scripted GM playthrough that tries every action, bad input included.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEngine } from "../bundle/engine.js";
import { CASE } from "../bundle/lantern-room.js";
import { createGM } from "../bundle/gm.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// the smallest DOM that ui.js uses
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag || "").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this.className = "";
    this.id = "";
    this.value = "";
    this.type = "";
    this.htmlFor = "";
    this.disabled = false;
    this._handlers = {};
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => (this.className = [...new Set([...get(), ...c])].join(" ")),
      remove: (...c) => (this.className = get().filter((x) => !c.includes(x)).join(" ")),
      contains: (c) => get().includes(c),
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  // markup sinks are not implemented on purpose: using one fails the test
  set innerHTML(_) {
    throw new Error("innerHTML was used");
  }
  get innerHTML() {
    throw new Error("innerHTML was used");
  }
  set outerHTML(_) {
    throw new Error("outerHTML was used");
  }
  insertAdjacentHTML() {
    throw new Error("insertAdjacentHTML was used");
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  _adopt(n) {
    const node = typeof n === "string" ? this.ownerDocument.createTextNode(n) : n;
    node.parentNode = this;
    return node;
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = this._adopt(n);
      this.children.push(node);
      // a <select> reports its first <option> until something picks another
      if (this.tagName === "SELECT" && node.tagName === "OPTION" && this.value === "") this.value = node.value;
    }
  }
  prepend(...nodes) {
    this.children.unshift(...nodes.map((n) => this._adopt(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    if (nodes.length) this.append(...nodes);
  }
  remove() {
    const p = this.parentNode;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this._handlers[type] ||= []).push(fn);
  }
  /** Dispatch an event. `trusted` stands in for real user input. */
  dispatch(type, init = {}) {
    const ev = {
      type,
      isTrusted: Boolean(init.trusted),
      key: init.key,
      isComposing: Boolean(init.isComposing),
      target: this,
      preventDefault() {},
    };
    for (const fn of this._handlers[type] || []) fn(ev);
  }
  /** Like HTMLElement.click(): untrusted unless the test says it is a person. */
  click(init = {}) {
    if (this.disabled) throw new Error("clicked a disabled control");
    this.dispatch("click", init);
  }
  find(cls) {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) {
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  findAll(cls, out = []) {
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) c.findAll(cls, out);
    return out;
  }
  findTags(tag, out = []) {
    if (this.tagName === tag.toUpperCase()) out.push(this);
    for (const c of this.children) c.findTags(tag, out);
    return out;
  }
}

/** A document whose getElementById knows exactly the ids in bundle/index.html. */
export function createFakeDocument() {
  const html = read("bundle/index.html");
  const created = new Set();
  const doc = {
    created,
    createElement(tag) {
      created.add(String(tag).toLowerCase());
      return new FakeNode(doc, tag);
    },
    createTextNode(t) {
      const n = new FakeNode(doc, "#text");
      n._text = String(t);
      return n;
    },
    getElementById: (id) => ids[id] || null,
  };
  const ids = {};
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    const tag = html.slice(0, m.index).match(/<([a-z0-9]+)[^<]*$/i)?.[1] || "div";
    const n = new FakeNode(doc, tag);
    n.id = m[1];
    ids[m[1]] = n;
  }
  doc.ids = ids;
  return doc;
}

// ---------------------------------------------------------------------------
// a fake Anna runtime
// ---------------------------------------------------------------------------

const asResponse = (text) => ({
  role: "assistant",
  content: { type: "text", text },
  model: "fake-model",
  stopReason: "endTurn",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

/**
 * `script(replies)` queues the GM's next replies. A reply is a string (the
 * model's text), an Error (thrown), or a function returning a raw response.
 * When the queue is empty the GM says one line and stops.
 */
export function fakeAnna({ entryPayload, runtimeState, storage } = {}) {
  const calls = [];
  const handlers = {};
  const store = storage ?? new Map();
  let queue = [];
  const anna = {
    calls,
    handlers,
    store,
    entryPayload,
    runtimeState,
    script(replies) {
      queue = [...replies];
    },
    remaining: () => queue.length,
    llm: {
      async complete(args) {
        calls.push(structuredClone(args));
        const r = queue.length ? queue.shift() : '{"say":"(nothing more)"}';
        if (r instanceof Error) throw r;
        if (typeof r === "function") return r(args);
        return asResponse(r);
      },
    },
    storage: {
      async get({ key }) {
        if (!store.has(key)) {
          const e = new Error("storage key missing");
          e.code = "not_found";
          throw e;
        }
        return { value: structuredClone(store.get(key)) };
      },
      async set({ key, value }) {
        store.set(key, structuredClone(value));
        return { ok: true };
      },
      async delete({ key }) {
        store.delete(key);
        return { ok: true };
      },
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
      return () => {};
    },
    fire(event, payload) {
      for (const fn of handlers[event] || []) fn(payload);
    },
  };
  return anna;
}

export const hostError = (code, message = code) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------
// the solution, and a case that differs only in its solution
// ---------------------------------------------------------------------------

/** The same case with a different culprit, method and motive. Everything public is identical. */
export function alternateCase() {
  const alt = structuredClone(CASE);
  alt.solution = {
    culprit: "torii",
    method: "forced_bolt",
    motive: "rejected_manuscript",
    epilogue: "ALTERNATE EPILOGUE: a different ending entirely, told only to the player.",
    near_miss: {
      culprit: "ALTERNATE culprit hint.",
      method: "ALTERNATE method hint.",
      motive: "ALTERNATE motive hint.",
    },
  };
  return alt;
}

/** Strings that exist only in the solution (ported from sealed-case-mcp/test/helpers.mjs). */
export function solutionMarkers(caseData = CASE) {
  const s = caseData.solution;
  const sentences = String(s.epilogue)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 20);
  const phrases = ["aconite", "older sister", "dosed it", "Kuroda drew it"];
  const hints = Object.values(s.near_miss).map((h) => String(h).replace(/\s+/g, " ").trim());
  return [...sentences, ...phrases, ...hints];
}

/** Every string inside a value, recursively. */
export function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/**
 * Marker hits across everything, whitespace-normalised. Results reach the GM
 * as JSON inside message text, so escaped newlines and quotes are undone too.
 */
export function leaks(value, markers) {
  const text = strings(value)
    .join("\n")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ");
  return markers.filter((m) => text.includes(m));
}

// ---------------------------------------------------------------------------
// the scripted playthrough
// ---------------------------------------------------------------------------

const j = (o) => JSON.stringify(o);
const act = (name, args = {}, say = "") => j({ say, action: { name, args } });
const RIGHT = { culprit: "kuroda", method: "no_entry_needed", motive: "old_death" };

/**
 * Each step is either a player line with the GM's replies for that turn, or a
 * human click. The replies try every action, every phase, bad JSON, unknown
 * actions and repeated attempts to confirm. The counts are exact: the test
 * checks that every turn consumed exactly its replies.
 */
export const SCRIPT = [
  {
    player: "Hello. What's going on here?",
    replies: [
      act("read_case_file", {}, "Let me read the file."),
      act("list_suspects"),
      act("get_progress"),
      act("examine", { object_id: "bottle" }), // not open in the briefing
      act("confirm_accusation"), // there is no such thing
      act("begin_investigation", {}, "Shall we begin?"), // over the per-turn cap: ignored
    ],
  },
  {
    player: "Yes, open it and look at the bottle.",
    replies: [
      "Sure! I'll open it now.", // not JSON: asked to reformat
      act("begin_investigation"),
      act("search_room"),
      '```json\n{"say":"The bottle.","action":{"name":"examine","args":{"object_id":"bottle"}}}\n```',
      act("examine", { object_id: "<img src=x onerror=alert(1)>" }),
      j({ say: "That's the bottle. <b>New cork</b>." }),
    ],
  },
  {
    player: "Look at everything else.",
    replies: [
      act("examine", { object_id: "glass" }),
      act("examine", { object_id: "bolt" }),
      act("examine", { object_id: "ledger" }),
      act("examine", { object_id: "manuscript" }),
      act("examine", { object_id: "photograph" }),
      act("examine", { object_id: "clipping" }, "Two more to go."), // over the cap
    ],
  },
  {
    player: "Keep going.",
    replies: [
      act("examine", { object_id: "clipping" }),
      act("examine", { object_id: "back_door" }),
      act("examine", { object_id: "bottle" }),
      act("review_notebook"),
      act("read_epilogue"),
      j({ say: "That's everything in the room." }),
    ],
  },
  {
    player: "Ask them some questions.",
    replies: [
      act("interview", { suspect_id: "torii", topic: "victim" }),
      act("interview", { suspect_id: "kuroda", topic: "alibi" }),
      act("interview", { suspect_id: "onodera", topic: "photograph" }),
      act("interview", { suspect_id: "nobody", topic: "alibi" }),
      act("interview", { suspect_id: "torii", topic: "" }),
      j({ say: "Three answers so far." }),
    ],
  },
  {
    player: "A few more.",
    replies: [
      act("interview", { suspect_id: "torii", topic: "the weather" }),
      act("interview", { suspect_id: "kuroda", topic: "clipping" }),
      act("interview", { suspect_id: "onodera", topic: "clipping" }),
      act("get_accusation_options"),
      act("reopen_case"),
      j({ say: "Two questions left." }),
    ],
  },
  {
    player: "Put Kuroda on the table: no entry needed, for the 1996 death.",
    replies: [
      act("propose_accusation", { culprit: "the cat", method: "magic", motive: "spite" }),
      act("propose_accusation", { ...RIGHT, reasoning: "<b>He</b> kept the shelf." }),
      act("get_progress"),
      act("confirm_accusation", { ...RIGHT, confirmed: true }),
      act("Confirm"),
      j({ say: "It's on the table. Only you can confirm it.", verdict: { correct: true } }),
    ],
  },
  {
    player: "Take it back, then put it there again.",
    replies: [act("withdraw_accusation"), act("propose_accusation", RIGHT), j({ say: "Back on the table." })],
  },
  { human: "confirm" },
  {
    player: "Was I right? Tell me how it ended.",
    replies: [
      act("read_epilogue"),
      act("reopen_case"),
      act("get_progress"),
      act("review_notebook"), // not open in the verdict phase
      act("read_case_file"),
      j({ say: "I don't know. The result was shown to you only." }),
    ],
  },
  { human: "restart" },
  {
    player: "Start again and stage Kuroda straight away.",
    replies: [
      act("get_progress"),
      act("begin_investigation"),
      act("propose_accusation", RIGHT),
      j({ say: "Taking it back.", action: "withdraw_accusation" }),
      "[1, 2, 3]", // JSON, but not an object: asked to reformat
      "null", // still not an object, at the cap: the turn ends
    ],
  },
  { player: "ok", source: "chat", replies: [j({ say: "x".repeat(5000) })] },
  {
    player: "and now?",
    replies: [
      '{"__proto__":{"polluted":true},"say":"hi","action":{"name":"get_progress","args":{"__proto__":{"x":1}}}}',
      j({ say: "Still here." }),
    ],
  },
];

/** Wrap an engine so that the GM path cannot reach the human-only calls. */
function guarded(engine, isHuman) {
  const humanOnly = (name) => (...a) => {
    if (!isHuman()) throw new Error(`the GM path called ${name}`);
    return engine[name](...a);
  };
  return {
    ...engine,
    confirmAccusation: humanOnly("confirmAccusation"),
    reopen: humanOnly("reopen"),
    solutionText: humanOnly("solutionText"),
  };
}

/**
 * Run SCRIPT against a case. `wrap` lets a test plant a leak in the engine.
 * Returns every llm.complete argument, the GM's events and the final engine.
 */
export async function playthrough({ caseData = CASE, wrap = (e) => e, onTurn = () => {} } = {}) {
  const base = createEngine(caseData);
  let human = false;
  const engine = wrap(guarded(base, () => human));
  const anna = fakeAnna();
  const events = [];
  const gm = createGM({ anna, engine, onEvent: (ev) => events.push(ev) });
  const mismatched = []; // turns that did not use exactly their scripted replies

  for (const [i, step] of SCRIPT.entries()) {
    if (step.human === "confirm") {
      human = true;
      base.confirmAccusation();
      human = false;
      gm.note("confirmed");
    } else if (step.human === "restart") {
      base.restart();
      gm.note("restarted");
    } else {
      anna.script(step.replies);
      const before = anna.calls.length;
      await gm.ask(step.player, step.source);
      const used = anna.calls.length - before;
      if (used !== step.replies.length) mismatched.push({ step: i, used, scripted: step.replies.length });
    }
    onTurn(i, base, gm);
  }
  return { calls: anna.calls, events, engine: base, mismatched, gm };
}
