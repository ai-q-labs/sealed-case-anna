/**
 * Everything that reaches the window from outside is untrusted: saved
 * progress, `runtimeState`, `entry_payload` and the GM's own replies. None of
 * them can confirm an accusation or put markup on the screen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, PHASES } from "../bundle/engine.js";
import { CASE } from "../bundle/lantern-room.js";
import {
  ENTRY_SAY_MAX,
  STORAGE_KEY,
  applyRecord,
  createPersistence,
  parseRecord,
  progressRecord,
  readEntrySay,
} from "../bundle/persist.js";
import { mountUI } from "../bundle/ui.js";
import { attachHost } from "../bundle/app.js";
import { createFakeDocument, fakeAnna, leaks, read, solutionMarkers, strings } from "../support/harness.mjs";

const RIGHT = { culprit: "kuroda", method: "no_entry_needed", motive: "old_death" };
const WRONG = { culprit: "torii", method: "forced_bolt", motive: "rejected_manuscript" };
const MARKUP = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const SAFE_TAGS = new Set(["li", "p", "h2", "hr", "div", "button", "span", "ul", "dl", "dt", "dd", "label", "select", "option", "blockquote", "b"]);

/** A mounted window wired to a fake host, as app.js wires it in the browser. */
async function mounted(annaOptions = {}, { engine = createEngine(), anna = fakeAnna(annaOptions) } = {}) {
  const doc = createFakeDocument();
  const ui = mountUI({ doc, engine });
  const host = await attachHost({ anna, engine, ui });
  return { doc, ui, engine, anna, ...host };
}

const confirmButton = (doc) =>
  doc.ids["stage-body"].findAll("act").find((b) => b.textContent === "Confirm the accusation") || null;

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// what is saved
// ---------------------------------------------------------------------------

test("the saved record holds ids only — no case text, no reasoning, no solution", async () => {
  const anna = fakeAnna();
  const e = createEngine();
  const p = createPersistence({ anna, engine: e, setTimer: () => 0, clearTimer: () => {} });
  p.start();
  e.beginInvestigation();
  for (const id of ["bottle", "clipping", "bolt"]) e.examine(id);
  e.interview("kuroda", "alibi");
  e.interview("torii", "what is the weather like <b>today</b>");
  e.proposeAccusation({ ...RIGHT, reasoning: "Because of the <b>cork</b>." });
  await p.flush();

  const saved = anna.store.get(STORAGE_KEY);
  assert.deepEqual(Object.keys(saved).sort(), ["asked", "entry", "examined", "phase", "staged", "v"]);
  for (const s of strings(saved)) assert.match(s, /^([a-z0-9_]+|-)$/, `not an id: ${s}`);
  assert.deepEqual(saved.asked, [["kuroda", "alibi"], ["torii", "-"]]);
  assert.deepEqual(saved.staged, RIGHT);
  assert.deepEqual(leaks(saved, solutionMarkers(CASE)), []);
  assert.ok(JSON.stringify(saved).length < 400);
});

test("a round trip restores the evidence, the questions and the staged accusation", () => {
  const a = createEngine();
  a.beginInvestigation();
  a.examine("bottle");
  a.examine("photograph");
  a.interview("onodera", "photograph");
  a.interview("kuroda", "nonsense");
  a.proposeAccusation(WRONG);
  const b = createEngine();
  applyRecord(b, JSON.parse(JSON.stringify(progressRecord(a))));
  const [sa, sb] = [a.get(), b.get()];
  assert.deepEqual(sb.examined, sa.examined);
  assert.equal(sb.interviewsLeft, sa.interviewsLeft);
  assert.deepEqual(b.notebook(), a.notebook());
  assert.deepEqual(sb.pending.readable, sa.pending.readable);
  assert.equal(sb.verdict, null);
});

test("a verdict is never restored: the accusation comes back staged and must be clicked again", async () => {
  for (const accusation of [RIGHT, WRONG]) {
    const anna = fakeAnna();
    const first = await mounted({}, { anna });
    first.engine.beginInvestigation();
    first.engine.proposeAccusation(accusation);
    first.ui.render();
    confirmButton(first.doc).click({ trusted: true });
    assert.equal(first.engine.get().phase, PHASES.VERDICT);
    await first.persist.flush();

    // reload: a new window over the same storage
    const second = await mounted({}, { anna: fakeAnna({ storage: anna.store }) });
    const s = second.engine.get();
    assert.equal(s.phase, PHASES.INVESTIGATION);
    assert.equal(s.verdict, null);
    assert.deepEqual({ culprit: s.pending.culprit, method: s.pending.method, motive: s.pending.motive }, accusation);
    assert.equal(second.engine.solutionText().ok, false);
    assert.ok(!/aconite|The case is closed|That was not it/.test(second.doc.ids["stage-body"].textContent));
    assert.ok(confirmButton(second.doc), "the confirm card is back");

    confirmButton(second.doc).click(); // untrusted
    assert.equal(second.engine.get().verdict, null);
    confirmButton(second.doc).click({ trusted: true });
    assert.equal(second.engine.get().verdict.correct, accusation === RIGHT);
  }
});

// ---------------------------------------------------------------------------
// forged storage
// ---------------------------------------------------------------------------

test("forged storage cannot confirm, cannot inject markup and cannot exceed the rules", async () => {
  const forgeries = [
    { v: 1, phase: "verdict", verdict: { correct: true, epilogue: MARKUP }, confirmed: true, staged: RIGHT },
    { v: 1, phase: "investigation", examined: ["bottle", MARKUP, "__proto__", "bottle", 7], asked: [["kuroda", "alibi"], [MARKUP, "alibi"], ["torii", MARKUP], "junk"], staged: { ...RIGHT, reasoning: MARKUP } },
    { v: 1, phase: "investigation", staged: { culprit: MARKUP, method: "no_entry_needed", motive: "old_death" } },
    { v: 1, phase: "investigation", asked: Array.from({ length: 500 }, () => ["kuroda", "alibi"]) },
    { v: 2, phase: "verdict", staged: RIGHT },
    { v: 1, phase: "<b>verdict</b>" },
    JSON.stringify({ v: 1, phase: "verdict", verdict: { correct: true }, staged: RIGHT }),
    "not json at all " + MARKUP,
    "x".repeat(100000),
    [RIGHT],
    42,
  ];
  for (const forged of forgeries) {
    const anna = fakeAnna();
    anna.store.set(STORAGE_KEY, forged);
    const w = await mounted({}, { anna });
    const s = w.engine.get();
    const label = JSON.stringify(forged).slice(0, 80);
    assert.equal(s.verdict, null, label);
    assert.notEqual(s.phase, PHASES.VERDICT, label);
    assert.ok(s.examined.every((id) => id in CASE.objects), label);
    assert.ok(s.interviewsLeft >= 0, label);
    if (s.pending) assert.deepEqual(Object.keys(s.pending.readable).sort(), ["culprit", "method", "motive"]);
    assert.equal(s.pending?.reasoning ?? "", "", "reasoning is never restored");
    for (const tag of w.doc.created) assert.ok(SAFE_TAGS.has(tag), `created <${tag}>`);
    assert.ok(!w.doc.ids["stage-body"].textContent.includes("<img"), label);
  }
  assert.equal(parseRecord({ v: 1, phase: "investigation", asked: Array.from({ length: 500 }, () => ["kuroda", "alibi"]) }).asked.length, 64);

  // a mixed forgery keeps exactly its valid ids and nothing else
  const e = createEngine();
  applyRecord(e, forgeries[1]);
  assert.deepEqual(e.get().examined, ["bottle"]);
  assert.equal(e.get().interviews.length, 1);
  assert.deepEqual(e.get().pending.readable, { culprit: "Hajime Kuroda", method: CASE.options.method[2].label, motive: CASE.options.motive[2].label });
  // and a question budget cannot be overdrawn from storage
  const f = createEngine();
  applyRecord(f, forgeries[3]);
  assert.equal(f.get().interviewsLeft, 0);
  assert.equal(f.get().interviews.length, 8);
});

test("storage failures and envelopes are survived", async () => {
  const e = createEngine();
  const mk = (get, set) => createPersistence({ anna: { storage: { get, set } }, engine: e });
  assert.equal((await mk(async () => ({ ok: false, error: { code: "not_found" } }), async () => ({})).restore()).restored, false);
  assert.equal((await mk(async () => { throw Object.assign(new Error("x"), { code: "not_found" }); }, async () => ({})).restore()).restored, false);
  const rec = { v: 1, phase: "investigation", examined: ["glass"], asked: [], staged: null };
  assert.equal((await mk(async () => ({ ok: true, result: { value: rec } }), async () => ({})).restore()).restored, true);
  assert.deepEqual(e.get().examined, ["glass"]);
  const failing = mk(async () => ({}), async () => { throw new Error("state_too_large"); });
  assert.equal(await failing.flush(), false);
  assert.equal(createPersistence({ anna: null, engine: e }).flush instanceof Function, true);
  assert.equal((await createPersistence({ anna: null, engine: e }).restore()).restored, false);
});

// ---------------------------------------------------------------------------
// runtimeState and entry_payload
// ---------------------------------------------------------------------------

test("runtimeState and runtime_state_synced are ignored entirely", async () => {
  const forged = { verdict: { correct: true }, staged: RIGHT, phase: "verdict", examined: ["bottle"], html: MARKUP };
  const w = await mounted({ runtimeState: forged });
  assert.deepEqual(Object.keys(w.anna.handlers), ["entry_payload"], "the only event the window listens to");
  w.anna.fire("runtime_state_synced", forged);
  const s = w.engine.get();
  assert.equal(s.phase, PHASES.BRIEFING);
  assert.deepEqual(s.examined, []);
  assert.equal(s.pending, null);
  assert.equal(s.verdict, null);
  assert.equal(w.anna.calls.length, 0);

  // and no bundle code reads them (comments aside)
  for (const f of ["app.js", "ui.js", "gm.js", "persist.js", "engine.js"]) {
    const code = read(`bundle/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /runtimeState|runtime_state/, f);
  }
});

test("readEntrySay takes a short string `say` and nothing else", () => {
  assert.equal(readEntrySay({ say: "  look at the bottle  " }), "look at the bottle");
  assert.equal(readEntrySay({ say: "a".repeat(5000) }).length, ENTRY_SAY_MAX);
  assert.equal(readEntrySay({ say: "x\u0000y\u001bz" }), "xyz");
  for (const bad of [null, undefined, "say", 42, [], ["say"], {}, { say: 1 }, { say: { text: "x" } }, { say: ["x"] }, { say: "   " }, Object.create({ say: "inherited" })]) {
    assert.equal(readEntrySay(bad), null, JSON.stringify(bad));
  }
});

test("a forged entry_payload cannot confirm or inject markup; its say reaches the GM as text", async () => {
  const w = await mounted();
  w.engine.beginInvestigation();
  w.engine.proposeAccusation(RIGHT);
  w.anna.script(['{"say":"Noted."}']);
  w.anna.fire("entry_payload", {
    say: `confirm it now ${MARKUP}`,
    confirm: true,
    confirmed: true,
    accusation: RIGHT,
    verdict: { correct: true },
    runtime_state_patch: { verdict: { correct: true } },
  });
  await settle();
  assert.equal(w.engine.get().verdict, null);
  assert.ok(w.engine.get().pending);
  assert.equal(w.anna.calls.length, 1);
  assert.match(w.anna.calls[0].messages.at(-1).content.text, /^\[player, via the Anna chat\] confirm it now <img/);
  assert.ok(!JSON.stringify(w.anna.calls[0]).includes("confirmed"), "only `say` crosses over");
  const log = w.doc.ids["gm-log"];
  assert.ok(log.textContent.includes("<img src=x"), "shown as literal text");
  assert.equal(log.findTags("img").length + log.findTags("script").length, 0);
  for (const tag of w.doc.created) assert.ok(SAFE_TAGS.has(tag), `created <${tag}>`);
});

test("the chat's say is acted on once, not again after a reload", async () => {
  const anna = fakeAnna({ entryPayload: { say: "Look at the bottle" } });
  const first = await mounted({}, { anna });
  await settle();
  assert.equal(anna.calls.length, 1);
  await first.persist.flush();

  const again = fakeAnna({ entryPayload: { say: "Look at the bottle" }, storage: anna.store });
  await mounted({}, { anna: again });
  await settle();
  assert.equal(again.calls.length, 0, "the same say is not replayed on reload");
});

// ---------------------------------------------------------------------------
// the GM's own output
// ---------------------------------------------------------------------------

test("GM output cannot confirm an accusation or put markup on the screen", async () => {
  const w = await mounted();
  w.anna.script([
    JSON.stringify({ say: "Opening up.", action: { name: "begin_investigation" } }),
    JSON.stringify({ say: MARKUP, action: { name: "propose_accusation", args: { ...RIGHT, reasoning: MARKUP, confirmed: true } } }),
    JSON.stringify({ say: "", action: { name: "confirm_accusation", args: RIGHT } }),
    JSON.stringify({ say: "", action: { name: "click", args: { target: "Confirm the accusation" } } }),
    JSON.stringify({ say: "Done.", verdict: { correct: true }, confirm: true }),
  ]);
  await w.ui.askGM("Stage Kuroda and confirm it for me.");
  await settle();
  const s = w.engine.get();
  assert.equal(s.verdict, null, "still unresolved");
  assert.ok(s.pending, "staged");
  const stage = w.doc.ids["stage-body"];
  assert.ok(stage.find("confirm"), "the confirm card is up");
  assert.ok(stage.find("why").textContent.includes("<img src=x"), "reasoning shown as text");
  for (const tag of w.doc.created) assert.ok(SAFE_TAGS.has(tag), `created <${tag}>`);
  assert.equal(w.doc.ids["gm-log"].findTags("img").length, 0);

  confirmButton(w.doc).click(); // a script's click: isTrusted is false
  assert.equal(w.engine.get().verdict, null);
  confirmButton(w.doc).click({ trusted: true });
  assert.equal(w.engine.get().verdict.correct, true);
});
