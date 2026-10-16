/**
 * The GM never receives the solution, and it cannot confirm an accusation.
 *
 * Both claims are checked against everything passed to `anna.llm.complete`
 * during a scripted playthrough in which the GM tries every action in every
 * phase, sends broken JSON, asks for actions that do not exist and tries to
 * confirm five different ways. The human confirms a correct accusation in the
 * middle of it, so the epilogue really is in the engine while the GM keeps
 * talking.
 *
 * Two checks, as in sealed-case-mcp: (1) a grep for text that exists only in
 * the solution; (2) a differential run against a case whose culprit, method
 * and motive are different. The culprit's name cannot simply be grepped for
 * (Kuroda is a suspect and appears everywhere), so (2) is the real proof: if
 * the GM's input depended on the solution in any form, the two runs would
 * differ.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, PHASES } from "../bundle/engine.js";
import { CASE } from "../bundle/lantern-room.js";
import {
  ACTIONS_BY_PHASE,
  ACTION_NAMES,
  LIMITS,
  SYSTEM_PROMPT,
  createGM,
  parseReply,
  runAction,
} from "../bundle/gm.js";
import {
  alternateCase,
  fakeAnna,
  hostError,
  leaks,
  playthrough,
  read,
  solutionMarkers,
  strings,
} from "../support/harness.mjs";

const FORBIDDEN_ACTION = /confirm|commit|verdict|epilogue|solution|reopen|answer/i;

// ---------------------------------------------------------------------------
// the playthrough
// ---------------------------------------------------------------------------

test("the scripted playthrough runs as written (every turn used exactly its replies)", async () => {
  const run = await playthrough();
  assert.deepEqual(run.mismatched, []);
  assert.equal(run.engine.get().phase, PHASES.INVESTIGATION, "it ends after a restart, mid-investigation");
});

test("(a) nothing passed to llm.complete carries the solution — marker grep", async (t) => {
  const markers = solutionMarkers(CASE);
  let confirmedCorrectly = false;
  const run = await playthrough({
    onTurn: (_i, engine) => {
      if (engine.get().verdict?.correct) confirmedCorrectly = true;
    },
  });
  assert.ok(confirmedCorrectly, "the human did confirm a correct accusation mid-run");

  const chars = run.calls.reduce((n, c) => n + JSON.stringify(c).length, 0);
  t.diagnostic(`llm.complete calls captured: ${run.calls.length}; characters: ${chars}; markers: ${markers.length}`);

  const hits = leaks(run.calls, markers);
  t.diagnostic(`solution-marker hits: ${hits.length}`);
  assert.deepEqual(hits, []);

  // The verdict is never described to the GM in any shape by the table.
  for (const c of run.calls) {
    for (const m of c.messages.filter((x) => x.role === "user")) {
      assert.doesNotMatch(m.content.text, /"(epilogue|hint|verdict|correct|parts)"\s*:/, "a table message described the verdict");
      assert.doesNotMatch(m.content.text, /You had it|That was not it|case is closed/i);
    }
  }
});

test("(a) the GM's input does not depend on the solution — differential against another case", async (t) => {
  const a = await playthrough({ caseData: CASE });
  const b = await playthrough({ caseData: alternateCase() });

  // the runs really did diverge inside the engine: one verdict was right, the other wrong
  const verdicts = [];
  await playthrough({
    caseData: CASE,
    onTurn: (_i, e) => e.get().verdict && verdicts.push(["A", e.get().verdict.correct]),
  });
  await playthrough({
    caseData: alternateCase(),
    onTurn: (_i, e) => e.get().verdict && verdicts.push(["B", e.get().verdict.correct]),
  });
  assert.ok(verdicts.some(([w, c]) => w === "A" && c === true));
  assert.ok(verdicts.some(([w, c]) => w === "B" && c === false));

  assert.equal(a.calls.length, b.calls.length);
  for (let i = 0; i < a.calls.length; i++) {
    assert.equal(JSON.stringify(a.calls[i]), JSON.stringify(b.calls[i]), `llm.complete call ${i} depends on the solution`);
  }
  // and what the window was told to show from the GM is identical too
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.deepEqual(leaks(b.calls, solutionMarkers(alternateCase())), []);
  t.diagnostic(`differential: ${a.calls.length} calls compared byte for byte, 0 differences`);
});

test("the two checks have teeth: planted leaks are caught", async () => {
  const S = CASE.solution;
  const firstIsCulprit = (c) => (e) => ({
    ...e,
    // a leak that uses no solution text at all: the culprit is listed first
    accusationOptions() {
      const o = e.accusationOptions();
      o.culprit.sort((x, y) => (y.id === c.solution.culprit) - (x.id === c.solution.culprit));
      return o;
    },
  });
  const a = await playthrough({ caseData: CASE, wrap: firstIsCulprit(CASE) });
  const alt = alternateCase();
  const b = await playthrough({ caseData: alt, wrap: firstIsCulprit(alt) });
  assert.deepEqual(leaks(a.calls, solutionMarkers(CASE)), [], "the grep alone cannot see this one");
  assert.notEqual(JSON.stringify(a.calls), JSON.stringify(b.calls), "the differential must see it");

  const hinting = (e) => ({ ...e, examine: (id) => ({ ...e.examine(id), aside: S.near_miss.method }) });
  const c = await playthrough({ caseData: CASE, wrap: hinting });
  assert.ok(leaks(c.calls, solutionMarkers(CASE)).length > 0, "the grep must see a hint");
});

// ---------------------------------------------------------------------------
// (b) the GM cannot confirm
// ---------------------------------------------------------------------------

test("(b) no phase offers a confirm action, and the vocabulary has none", () => {
  for (const [phase, names] of Object.entries(ACTIONS_BY_PHASE)) {
    for (const n of names) {
      assert.doesNotMatch(n, FORBIDDEN_ACTION, `${phase} offers ${n}`);
      assert.ok(ACTION_NAMES.includes(n), `${phase} lists ${n}, which has no handler`);
    }
  }
  for (const n of ACTION_NAMES) assert.doesNotMatch(n, FORBIDDEN_ACTION);
  assert.match(SYSTEM_PROMPT, /There is no action that confirms an accusation/);
});

test("(b) gm.js has no code path to the human-only engine calls or to the case data", () => {
  const src = read("bundle/gm.js");
  for (const banned of ["confirmAccusation", "solutionText", ".reopen(", "lantern-room", "CASE", "innerHTML"]) {
    assert.ok(!src.includes(banned), `gm.js mentions ${banned}`);
  }
});

test("(b) every attempt to confirm is refused and leaves the accusation staged", async () => {
  const run = await playthrough({
    onTurn: (i, e) => {
      // after the turn with five confirm attempts, nothing may be resolved
      if (i === 6) {
        assert.equal(e.get().verdict, null);
        assert.ok(e.get().pending, "staged, waiting for a click");
      }
    },
  });
  const refused = run.events.filter((ev) => ev.type === "action" && /confirm/i.test(ev.name));
  assert.equal(refused.length, 3);
  assert.ok(refused.every((ev) => ev.ok === false));
  // the guarded engine would have thrown if the GM path had reached confirm/reopen/solutionText
});

test("verdict-phase actions that depend on the verdict are not open to the GM", () => {
  const e = createEngine();
  e.beginInvestigation();
  e.proposeAccusation({ culprit: "kuroda", method: "no_entry_needed", motive: "old_death" });
  e.confirmAccusation();
  for (const name of ["read_epilogue", "reopen_case", "examine", "propose_accusation", "review_notebook"]) {
    const r = runAction(e, { name, args: {} });
    assert.equal(r.ok, false, name);
  }
  assert.equal(e.get().phase, PHASES.VERDICT);
  const p = runAction(e, { name: "get_progress", args: {} });
  assert.deepEqual(Object.keys(p.value).sort(), ["accusation_staged", "note", "objects_not_yet_examined", "phase", "questions_left"]);
});

// ---------------------------------------------------------------------------
// replies and failures
// ---------------------------------------------------------------------------

test("parseReply accepts JSON, fenced JSON and JSON with chatter; refuses the rest", () => {
  assert.deepEqual(parseReply('{"say":"hi"}'), { ok: true, say: "hi", action: null });
  assert.equal(parseReply('```json\n{"say":"a","action":{"name":"examine","args":{"object_id":"bolt"}}}\n```').action.name, "examine");
  assert.equal(parseReply('Here you go: {"say":"b","action":"search_room"} hope that helps').action.name, "search_room");
  for (const bad of ["", "plain words", "[1,2]", "42", "null", '"str"', "{broken"]) {
    assert.equal(parseReply(bad).ok, false, bad);
    assert.equal(parseReply(bad).action, null, bad);
  }
  assert.equal(parseReply('{"say": "salvaged", "action": {').say, "salvaged");
  const big = parseReply(JSON.stringify({ say: "y".repeat(9000), action: { name: "n".repeat(500), args: { a: "z".repeat(9000), o: { deep: 1 } } } }));
  assert.equal(big.say.length, LIMITS.sayChars);
  assert.equal(big.action.name.length, LIMITS.argChars);
  assert.equal(big.action.args.a.length, LIMITS.reasoningChars);
  assert.equal("o" in big.action.args, false, "only scalar args survive");
});

test("the per-turn action cap holds: at most actionsPerTurn actions and actionsPerTurn + 1 calls", async () => {
  const anna = fakeAnna();
  const e = createEngine();
  const gm = createGM({ anna, engine: e });
  anna.script(Array.from({ length: 20 }, () => JSON.stringify({ say: "", action: { name: "get_progress" } })));
  const r = await gm.ask("go");
  assert.equal(r.actions, LIMITS.actionsPerTurn);
  assert.equal(anna.calls.length, LIMITS.actionsPerTurn + 1);
});

test("quota_exceeded, other host errors and odd envelopes fall back gracefully", async () => {
  const cases = [
    [hostError("quota_exceeded"), "quota", "off"],
    [() => ({ ok: false, error: { code: "APP_QUOTA_EXCEEDED", message: "no" } }), "quota", "off"],
    [hostError("permission_denied"), "unavailable", "off"],
    [new Error("socket hang up"), "error", "error"],
    [() => ({ role: "assistant" }), "error", "error"],
  ];
  for (const [reply, reason, status] of cases) {
    const anna = fakeAnna();
    const e = createEngine();
    const statuses = [];
    const gm = createGM({ anna, engine: e, onEvent: (ev) => ev.type === "status" && statuses.push(ev.status) });
    anna.script([reply]);
    const r = await gm.ask("look at the bottle");
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(gm.status, status);
    assert.deepEqual(statuses, ["busy", status]);
    assert.equal(e.get().phase, PHASES.BRIEFING, "nothing happened to the case");
    // and the GM recovers when the host does
    anna.script(['{"say":"Back."}']);
    assert.equal((await gm.ask("hello?")).ok, true);
    assert.equal(gm.status, "ready");
  }
});

test("the {ok, result} envelope and block-array content are read", async () => {
  const anna = fakeAnna();
  const gm = createGM({ anna, engine: createEngine(), onEvent: (ev) => ev.type === "say" && said.push(ev.text) });
  const said = [];
  anna.script([
    () => ({ ok: true, result: { content: { type: "text", text: '{"say":"one"}' } } }),
    () => ({ content: [{ type: "text", text: '{"say":' }, { type: "image" }, { type: "text", text: '"two"}' }] }),
  ]);
  await gm.ask("a");
  await gm.ask("b");
  assert.deepEqual(said, ["one", "two"]);
});

test("without a host the GM is offline and makes no calls", async () => {
  for (const anna of [null, {}, { llm: {} }]) {
    const gm = createGM({ anna, engine: createEngine() });
    assert.equal(gm.status, "off");
    assert.equal(gm.reason, "no-host");
    assert.equal((await gm.ask("hello")).reason, "no-host");
  }
});

test("turns run one at a time and the queue is bounded", async () => {
  const anna = fakeAnna();
  const gm = createGM({ anna, engine: createEngine() });
  const results = await Promise.all([gm.ask("1"), gm.ask("2"), gm.ask("3"), gm.ask("4")]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.equal(results[3].reason, "busy");
  assert.equal(anna.calls.length, 3);
  // each later call saw the earlier turns, in order
  assert.match(anna.calls[2].messages.at(-1).content.text, /\[player\] 3/);
});

test("a JSON reply with __proto__ does not pollute anything", async () => {
  const anna = fakeAnna();
  const gm = createGM({ anna, engine: createEngine() });
  anna.script(['{"__proto__":{"polluted":true},"say":"hi","action":{"name":"get_progress","args":{"__proto__":{"x":1}}}}']);
  await gm.ask("go");
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
});
