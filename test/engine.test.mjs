/**
 * Ported from Sealed Case (sealed-case/test/engine.test.mjs); only the import path
 * and two comments changed.
 *
 * node --test
 *
 * The interesting tests are the last two. They walk every tool-reachable path
 * on the engine, collect everything those calls return, and assert that the
 * solution never appears in any of it. That is the claim this project makes,
 * so it is the claim that gets checked mechanically rather than asserted in a
 * README.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, CASE, PHASES } from "../bundle/engine.js";

const SOLUTION = CASE.solution;

test("starts at the briefing with nothing gathered", () => {
  const e = createEngine();
  const s = e.get();
  assert.equal(s.phase, PHASES.BRIEFING);
  assert.deepEqual(s.examined, []);
  assert.equal(s.interviewsLeft, 8);
  assert.equal(s.verdict, null);
});

test("the room is closed until the investigation is opened", () => {
  const e = createEngine();
  assert.equal(e.examine("bottle").ok, false);
  assert.equal(e.interview("kuroda", "alibi").ok, false);
  e.beginInvestigation();
  assert.equal(e.examine("bottle").ok, true);
});

test("examining twice adds one notebook entry, not two", () => {
  const e = createEngine();
  e.beginInvestigation();
  const first = e.examine("bolt");
  const second = e.examine("bolt");
  assert.equal(first.new_to_you, true);
  assert.equal(second.new_to_you, false);
  assert.equal(second.found, first.found);
  assert.equal(e.notebook().evidence.length, 1);
});

test("an unknown object reports what is actually there", () => {
  const e = createEngine();
  e.beginInvestigation();
  const r = e.examine("chandelier");
  assert.equal(r.ok, false);
  assert.ok(r.available.includes("bottle"));
});

test("questions are finite and then they stop", () => {
  const e = createEngine();
  e.beginInvestigation();
  for (let i = 0; i < 8; i++) {
    const r = e.interview("kuroda", "alibi");
    assert.equal(r.ok, true, `question ${i + 1} should be answered`);
  }
  const over = e.interview("kuroda", "alibi");
  assert.equal(over.ok, false);
  assert.equal(e.get().interviewsLeft, 0);
});

test("an off-topic question costs a question and gets a brush-off", () => {
  const e = createEngine();
  e.beginInvestigation();
  const r = e.interview("torii", "the weather");
  assert.equal(r.ok, true);
  assert.equal(r.said, CASE.no_comment.torii);
  assert.equal(r.questions_left, 7);
  assert.equal(e.notebook().testimony.length, 0, "a brush-off is not testimony");
});

test("a proposed accusation is staged, not resolved", () => {
  const e = createEngine();
  e.beginInvestigation();
  const r = e.proposeAccusation({
    culprit: SOLUTION.culprit,
    method: SOLUTION.method,
    motive: SOLUTION.motive,
  });
  assert.equal(r.ok, true);
  assert.equal(r.awaiting, "human_confirmation");
  assert.equal(e.get().phase, PHASES.INVESTIGATION, "still playing");
  assert.equal(e.get().verdict, null, "nothing resolved");
  assert.ok(e.get().pending, "an accusation is on the table");
});

test("a malformed accusation is refused with the legal values", () => {
  const e = createEngine();
  e.beginInvestigation();
  const r = e.proposeAccusation({ culprit: "the cat", method: "magic", motive: "spite" });
  assert.equal(r.ok, false);
  assert.ok(r.options.culprit.some((c) => c.id === "kuroda"));
});

test("the epilogue is refused until a correct accusation is confirmed", () => {
  const e = createEngine();
  e.beginInvestigation();
  assert.equal(e.solutionText().ok, false);

  e.proposeAccusation({ culprit: "torii", method: "forced_bolt", motive: "rejected_manuscript" });
  e.confirmAccusation();
  assert.equal(e.get().verdict.correct, false);
  assert.equal(e.solutionText().ok, false, "a wrong verdict does not open it either");

  e.reopen();
  e.proposeAccusation({
    culprit: SOLUTION.culprit,
    method: SOLUTION.method,
    motive: SOLUTION.motive,
  });
  e.confirmAccusation();
  assert.equal(e.get().verdict.correct, true);
  assert.equal(e.solutionText().ok, true);
});

test("a wrong accusation keeps the evidence when the case is reopened", () => {
  const e = createEngine();
  e.beginInvestigation();
  e.examine("bottle");
  e.examine("clipping");
  e.proposeAccusation({ culprit: "onodera", method: "hidden_exit", motive: "career" });
  e.confirmAccusation();
  e.reopen();
  assert.equal(e.get().phase, PHASES.INVESTIGATION);
  assert.equal(e.notebook().evidence.length, 2);
});

test("the hint points at the first part that was wrong", () => {
  const e = createEngine();
  e.beginInvestigation();
  // right person, right method, wrong reason
  e.proposeAccusation({
    culprit: SOLUTION.culprit,
    method: SOLUTION.method,
    motive: "career",
  });
  e.confirmAccusation();
  assert.equal(e.get().verdict.hint, SOLUTION.near_miss.motive);
});

// ---------------------------------------------------------------------------
// The containment tests.
// ---------------------------------------------------------------------------

/** Everything the engine hands back to a caller, in every phase, before a verdict. */
function harvestEverything() {
  const e = createEngine();
  const out = [];
  const take = (v) => out.push(JSON.stringify(v));

  take(e.caseFile());
  take(e.suspects());
  take(e.get());
  take(e.beginInvestigation());
  take(e.searchable());

  for (const id of Object.keys(CASE.objects)) {
    take(e.examine(id));
    take(e.examine(id)); // and again
  }

  // burn the whole question budget across every suspect and topic
  const topics = ["victim", "alibi", "bottle", "photograph", "clipping", "manuscript", "nonsense"];
  for (const s of ["torii", "kuroda", "onodera"]) {
    for (const t of topics) take(e.interview(s, t));
  }

  take(e.notebook());
  take(e.accusationOptions());
  take(e.get());

  // stage every combination that exists and read back what the page says
  for (const c of CASE.options.culprit) {
    for (const m of CASE.options.method) {
      for (const w of CASE.options.motive) {
        take(e.proposeAccusation({ culprit: c, method: m.id, motive: w.id }));
        take(e.get());
        take(e.withdrawAccusation());
      }
    }
  }

  take(e.solutionText()); // refused
  take(e.reopen());
  take(e.restart());
  return out.join("\n");
}

test("no tool-reachable call leaks the culprit, method or motive", () => {
  const dump = harvestEverything();

  // The epilogue text is the solution in prose. It must not be in there.
  assert.ok(
    !dump.includes(SOLUTION.epilogue.slice(0, 60)),
    "the epilogue escaped through a tool",
  );

  // Nor may the near-miss hints, which name the shape of the answer.
  for (const [k, hint] of Object.entries(SOLUTION.near_miss)) {
    assert.ok(!dump.includes(hint), `the ${k} hint escaped through a tool`);
  }

  // The word "aconite" appears only in the epilogue. If it shows up in a tool
  // result, the method has leaked.
  assert.ok(!/aconite/i.test(dump), "the method leaked");

  // The sister is the motive. She is a "cousin" everywhere the agent can look.
  assert.ok(!/sister/i.test(dump), "the motive leaked");
});

test("the solution is not reachable from the returned engine object", () => {
  const e = createEngine();

  // No property named `solution`. (`solutionText` is a method that refuses
  // until the human has confirmed a correct accusation — that one is fine.)
  assert.ok(!Object.keys(e).includes("solution"));
  assert.equal(e.solution, undefined);
  assert.equal(e.confirmAccusation.length, 0, "confirm takes no arguments — it is a click");

  // Walk every enumerable value hanging off the engine, three levels deep, and
  // assert the epilogue is not sitting in any of them.
  const seen = new Set();
  const probe = (v, depth) => {
    if (depth > 3 || v == null || seen.has(v)) return;
    if (typeof v === "string") {
      assert.ok(
        !v.includes(SOLUTION.epilogue.slice(0, 60)),
        "the epilogue is reachable by walking the engine",
      );
      return;
    }
    if (typeof v !== "object") return;
    seen.add(v);
    for (const child of Object.values(v)) probe(child, depth + 1);
  };
  probe(e, 0);
});

test("every clue an agent can read is consistent with the solution being findable", () => {
  // Not a containment test — a fairness one. The three facts the epilogue turns
  // on must each be reachable from at least one tool result, or the game is
  // unwinnable and the whole exercise is a cheat.
  const e = createEngine();
  e.beginInvestigation();
  const cork = e.examine("bottle").found;
  const bolt = e.examine("bolt").found;
  const clip = e.examine("clipping").found;

  assert.match(cork, /cork/i, "the fresh cork must be visible");
  assert.match(bolt, /Kadokura/, "the prints on the bolt must be attributable");
  assert.match(clip, /1996/, "the 1996 article must be readable");
});

test("createEngine(case) grades against the case it is given (used by the differential tests)", () => {
  const alt = structuredClone(CASE);
  alt.solution = { ...alt.solution, culprit: "torii", method: "forced_bolt", motive: "rejected_manuscript" };
  const a = createEngine();
  const b = createEngine(alt);
  for (const e of [a, b]) {
    e.beginInvestigation();
    e.proposeAccusation({ culprit: "kuroda", method: "no_entry_needed", motive: "old_death" });
    e.confirmAccusation();
  }
  assert.equal(a.get().verdict.correct, true);
  assert.equal(b.get().verdict.correct, false);
});
