/**
 * Sealed Case — saving progress, and the two doors in from outside.
 *
 * Progress is saved to `anna.storage` as ids only: which objects were
 * examined, which questions were asked (suspect id + topic id), the phase, and
 * the ids of a staged accusation. No text from the case and nothing from the
 * solution is ever written.
 *
 * A saved record is untrusted on the way back in. Anything in storage could
 * have been written by someone else, so restoring replays the ids through the
 * ordinary engine calls (each one validates its input) and stops there. A
 * verdict is never restored. If the player had already confirmed an
 * accusation, the same accusation comes back staged, and it has to be clicked
 * again.
 *
 * The other door is `entry_payload`, which the Anna chat fills when it opens or
 * updates the window. From it the window takes one thing: a short `say`
 * string, which goes to the GM as the player's words. Everything else in the
 * payload is ignored. `runtimeState` and `runtime_state_synced` are not read
 * anywhere in this app.
 */

import { PHASES } from "./engine.js";
import { TOPICS } from "./gm.js";

export const STORAGE_KEY = "sealed-case.progress.v1";
export const ENTRY_SAY_MAX = 500;

const ID = /^[a-z0-9_]{1,40}$/;
const OFF_TOPIC = "-";
const MAX_RECORD_CHARS = 8192;

// ---------------------------------------------------------------------------
// entry_payload
// ---------------------------------------------------------------------------

/** The only thing taken from an entry payload: a short `say` string, or null. */
export function readEntrySay(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!Object.hasOwn(payload, "say") || typeof payload.say !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = payload.say.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return s ? s.slice(0, ENTRY_SAY_MAX) : null;
}

/** A 32-bit FNV-1a hash, so a `say` can be remembered without storing its text. */
export function sayHash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

const idsOf = (o) =>
  o && ID.test(o.culprit) && ID.test(o.method) && ID.test(o.motive)
    ? { culprit: o.culprit, method: o.method, motive: o.motive }
    : null;

/** What gets saved. `lastStaged` is the accusation that was on the table when the verdict came. */
export function progressRecord(engine, { lastStaged = null, entry = 0 } = {}) {
  const s = engine.get();
  const idByName = new Map(engine.suspects().map((x) => [x.name, x.id]));
  const staged = s.pending ? idsOf(s.pending) : s.phase === PHASES.VERDICT ? idsOf(lastStaged) : null;
  return {
    v: 1,
    phase: s.phase === PHASES.BRIEFING ? PHASES.BRIEFING : PHASES.INVESTIGATION,
    examined: s.examined.filter((id) => ID.test(id)),
    asked: s.interviews.map((i) => [idByName.get(i.suspect) ?? "", TOPICS.includes(i.topic) ? i.topic : OFF_TOPIC]),
    staged,
    entry: Number.isInteger(entry) && entry >= 0 ? entry : 0,
  };
}

/** Read a stored value back into a clean record, or null. Unknown fields are dropped. */
export function parseRecord(raw) {
  let r = raw;
  if (typeof r === "string") {
    if (r.length > MAX_RECORD_CHARS) return null;
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r) || r.v !== 1) return null;

  const phases = [PHASES.BRIEFING, PHASES.INVESTIGATION, PHASES.VERDICT];
  if (!phases.includes(r.phase)) return null;

  const examined = Array.isArray(r.examined)
    ? [...new Set(r.examined.slice(0, 64).filter((id) => typeof id === "string" && ID.test(id)))]
    : [];
  const asked = Array.isArray(r.asked)
    ? r.asked
        .slice(0, 64)
        .filter(
          (q) =>
            Array.isArray(q) &&
            q.length === 2 &&
            typeof q[0] === "string" &&
            ID.test(q[0]) &&
            (TOPICS.includes(q[1]) || q[1] === OFF_TOPIC),
        )
        .map((q) => [q[0], q[1]])
    : [];
  const staged = r.staged && typeof r.staged === "object" ? idsOf(r.staged) : null;
  const entry = Number.isInteger(r.entry) && r.entry >= 0 && r.entry <= 0xffffffff ? r.entry : 0;
  return { phase: r.phase, examined, asked, staged, entry };
}

/**
 * Replay a record into the engine through its ordinary calls. Never confirms.
 * A record in the verdict phase comes back as an investigation with the
 * accusation staged again.
 */
export function applyRecord(engine, raw) {
  const rec = parseRecord(raw);
  if (!rec) return { restored: false, entry: 0 };
  engine.restart();
  if (rec.phase === PHASES.BRIEFING) return { restored: true, entry: rec.entry };

  engine.beginInvestigation();
  const objects = new Set(engine.searchable().map((o) => o.id));
  for (const id of rec.examined) if (objects.has(id)) engine.examine(id);

  const suspects = new Set(engine.suspects().map((s) => s.id));
  for (const [who, topic] of rec.asked) {
    if (engine.get().interviewsLeft <= 0) break;
    if (suspects.has(who)) engine.interview(who, topic);
  }

  if (rec.staged) engine.proposeAccusation({ ...rec.staged }); // the engine checks the ids
  return { restored: true, entry: rec.entry };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** Accept both `{value}` and the `{ok, result: {value}}` envelope. */
function unwrap(res) {
  if (res && typeof res === "object" && res.ok === false) return null;
  if (res && typeof res === "object" && res.ok === true && "result" in res) return res.result;
  return res;
}

/**
 * @param {{ anna?: any, engine: ReturnType<import("./engine.js").createEngine>,
 *           delayMs?: number, setTimer?: Function, clearTimer?: Function }} deps
 */
export function createPersistence({
  anna = null,
  engine,
  delayMs = 400,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const ok = Boolean(anna && anna.storage && typeof anna.storage.get === "function" && typeof anna.storage.set === "function");
  let lastStaged = null;
  let entry = 0;
  let restoring = false;
  let timer = null;
  let lastSaved = null;
  let unsubscribe = null;

  function track(s) {
    if (s.pending) lastStaged = idsOf(s.pending);
    else if (s.phase === PHASES.BRIEFING) lastStaged = null;
  }

  async function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!ok) return false;
    const value = progressRecord(engine, { lastStaged, entry });
    const text = JSON.stringify(value);
    if (text === lastSaved) return false;
    try {
      await anna.storage.set({ key: STORAGE_KEY, value });
      lastSaved = text;
      return true;
    } catch {
      return false; // a failed save costs progress on reload, nothing more
    }
  }

  function schedule() {
    if (!ok || restoring) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delayMs);
  }

  return {
    /** Load and replay saved progress. Never throws. */
    async restore() {
      if (!ok) return { restored: false, reason: "no-storage" };
      let res;
      try {
        res = unwrap(await anna.storage.get({ key: STORAGE_KEY }));
      } catch {
        return { restored: false, reason: "read-failed" };
      }
      const value = res && typeof res === "object" ? res.value : undefined;
      if (value === undefined || value === null) return { restored: false, reason: "empty" };
      restoring = true;
      try {
        const r = applyRecord(engine, value);
        entry = r.entry;
        return r.restored ? { restored: true } : { restored: false, reason: "invalid" };
      } catch {
        return { restored: false, reason: "invalid" };
      } finally {
        restoring = false;
      }
    },
    start() {
      if (unsubscribe) return;
      unsubscribe = engine.subscribe((s) => {
        track(s);
        schedule();
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    flush,
    /** Remember (as a hash) the last `say` taken from the chat, so a reload does not replay it. */
    rememberEntry(say) {
      entry = sayHash(say);
      schedule();
    },
    isRemembered(say) {
      return entry !== 0 && entry === sayHash(say);
    },
  };
}
