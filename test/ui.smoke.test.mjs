/**
 * Smoke tests for the window, run against a fake DOM (support/harness.mjs)
 * built from the ids in bundle/index.html.
 *
 * What this covers: every render path, a full playthrough with buttons only,
 * the trusted-click gate on Confirm, the GM panel in its offline / quota /
 * working states, and static checks on the bundle files (CSP-friendly HTML,
 * no webfonts, no hover-only styles, tap targets, safe areas).
 *
 * What it does NOT cover: a real browser. Layout at 320 px, the real CSP, the
 * real SDK, real `isTrusted` values, keyboard activation and screen readers
 * are not exercised here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, PHASES } from "../bundle/engine.js";
import { isTrustedClick, mountUI } from "../bundle/ui.js";
import { attachHost, connectAnna } from "../bundle/app.js";
import { createFakeDocument, fakeAnna, hostError, read } from "../support/harness.mjs";

// ---------------------------------------------------------------------------
// static checks on the bundle
// ---------------------------------------------------------------------------

test("index.html: no viewport meta, no inline script, nothing external, app.js as a module", () => {
  const html = read("bundle/index.html");
  assert.doesNotMatch(html, /<meta[^>]+name="viewport"/i, "the mobile shell injects its own viewport");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "inline scripts are blocked by script-src 'self'");
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\//, "no external URLs (fonts, links, itch.io)");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
  assert.doesNotMatch(html, /footer|colophon|demo|devpost|webmcp/i);
});

test("style.css: system fonts only, no :hover, tap targets, safe areas", () => {
  const css = read("bundle/style.css");
  assert.doesNotMatch(css, /@font-face|@import|url\(/, "no fonts or remote resources");
  assert.doesNotMatch(css, /EB Garamond|IBM Plex/);
  assert.match(css, /--serif: Georgia, "Times New Roman", serif;/);
  assert.match(css, /--mono: ui-monospace, "SFMono-Regular", Consolas, monospace;/);
  assert.doesNotMatch(css, /:hover/, "reviewers grep for :hover");
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /--anna-safe-area-top/);
  assert.match(css, /--tap: 44px/);
  for (const sel of ["\\.obj \\{", "button\\.act \\{", "\\.ask select \\{", "\\.gm-ask input \\{"]) {
    const block = css.match(new RegExp(`${sel}[^}]*\\}`))?.[0] ?? "";
    assert.match(block, /min-height: var\(--tap\)/, `${sel} has a 44px tap target`);
  }
});

test("bundle code: no markup sinks, no leftover demo hooks, only app.js loads the SDK", () => {
  for (const f of ["app.js", "ui.js", "gm.js", "persist.js", "engine.js"]) {
    const src = read(`bundle/${f}`);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
    assert.doesNotMatch(src, /speechSynthesis|window\.sealedCase|demo\.js|\?demo|itch\.io|localStorage/, f);
    if (f !== "app.js") assert.doesNotMatch(src, /anna-apps\/_sdk/, f);
  }
  assert.match(read("bundle/app.js"), /"\/static\/anna-apps\/_sdk\/latest\/index\.js"/);
  for (const f of ["ui.js", "gm.js", "persist.js", "app.js"]) {
    assert.doesNotMatch(read(`bundle/${f}`), /lantern-room|\bCASE\b/, `${f} must not import the case data`);
  }
});

test("manifest.json: the design's manifest, host_api limited to llm.complete and storage", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.equal(m.schema, 3);
  assert.deepEqual(m.required_executas, []);
  assert.deepEqual(m.ui.host_api, { llm: ["complete"], storage: ["get", "set", "delete"] });
  assert.deepEqual(m.ui.form_factors, ["desktop", "mobile"]);
  assert.equal(m.ui.bundle.entry, "index.html");
  assert.equal((m.system_prompt_addendum.match(/app_id=573\b/g) || []).length, 2, "real app id (Developer Console app=573) in both open_app_view calls");
  assert.ok(!m.system_prompt_addendum.includes("<APP_ID>"), "placeholder replaced");
  for (const f of [m.ui.bundle.entry, m.ui.views[0].icon]) assert.ok(read(`bundle/${f}`).length > 0, f);
  const app = JSON.parse(read("app.json"));
  assert.equal(app.slug, "sealed-case");
  assert.equal(app.category, "entertainment");
  assert.ok(app.tagline.length <= 160);
});

// ---------------------------------------------------------------------------
// the window, buttons only
// ---------------------------------------------------------------------------

function windowWith(engine = createEngine()) {
  const doc = createFakeDocument();
  const ui = mountUI({ doc, engine });
  const stage = () => doc.ids["stage-body"];
  const buttons = () => stage().findAll("act");
  const byLabel = (text) => buttons().find((b) => b.textContent.toLowerCase().includes(text.toLowerCase()));
  const objects = () => doc.ids["objects"].findAll("obj");
  return { doc, ui, engine, stage, byLabel, objects };
}

test("isTrustedClick accepts only events the browser marks as user input", () => {
  assert.equal(isTrustedClick({ isTrusted: true }), true);
  for (const e of [undefined, null, {}, { isTrusted: false }, { isTrusted: "true" }, { isTrusted: 1 }]) {
    assert.equal(isTrustedClick(e), false, JSON.stringify(e));
  }
});

test("a full playthrough with buttons alone: open, search, question, accuse, confirm, read", () => {
  const w = windowWith();
  assert.match(w.stage().textContent, /Lantern Room/);
  assert.match(w.stage().textContent, /Rentaro Kadokura/);
  assert.match(w.stage().textContent, /work[s]? with the buttons alone/);
  assert.equal(w.objects().length, 8);
  assert.ok(w.objects().every((b) => b.disabled), "nothing to touch during the briefing");
  assert.equal(w.doc.ids["suspects"].children.length, 3);

  w.byLabel("Open the investigation").click();
  assert.ok(w.objects().every((b) => !b.disabled));
  for (const b of w.objects()) b.click();
  assert.match(w.stage().textContent, /Notebook/);
  assert.ok(w.objects().every((b) => b.classList.contains("done")));

  w.byLabel("Put the question").click();
  assert.match(w.stage().textContent, /on victim/);

  w.byLabel("Put it on the table").click();
  assert.ok(w.stage().find("confirm"));
  assert.match(w.stage().textContent, /cannot confirm one/);
  w.byLabel("Take it back").click();
  assert.equal(w.stage().find("confirm"), null);

  const selects = w.stage().findTags("select");
  const [who, how, why] = selects.slice(-3);
  who.value = "kuroda";
  how.value = "no_entry_needed";
  why.value = "old_death";
  w.byLabel("Put it on the table").click();

  // a script's click is not the player's
  w.byLabel("Confirm the accusation").click();
  assert.equal(w.engine.get().phase, PHASES.INVESTIGATION);
  assert.match(w.doc.ids["gm-log"].textContent, /did not come from you/);

  w.byLabel("Confirm the accusation").click({ trusted: true });
  assert.match(w.stage().textContent, /The case is closed/);
  assert.match(w.stage().textContent, /aconite/, "the epilogue is released to the player");
  assert.doesNotMatch(w.stage().textContent, /itch\.io|AiQ Labs/);
});

test("a wrong accusation gives a hint and lets you go back; restart clears the night", () => {
  const w = windowWith();
  w.byLabel("Open the investigation").click();
  w.byLabel("Put it on the table").click(); // defaults: torii / forced_bolt / rejected_manuscript
  w.byLabel("Confirm the accusation").click({ trusted: true });
  assert.match(w.stage().textContent, /That was not it/);
  assert.doesNotMatch(w.stage().textContent, /aconite/i);
  w.byLabel("Go back to it").click();
  assert.ok(w.byLabel("Put the question"));
  w.byLabel("Put it on the table").click();
  w.byLabel("Confirm the accusation").click({ trusted: true });
  w.byLabel("Start the night over").click();
  assert.equal(w.engine.get().phase, PHASES.BRIEFING);
  assert.ok(w.byLabel("Open the investigation"));
});

test("questions run out and the button says so", () => {
  const w = windowWith();
  w.byLabel("Open the investigation").click();
  for (let i = 0; i < 8; i++) w.byLabel("Put the question").click();
  assert.match(w.stage().textContent, /stopped answering/);
  assert.equal(w.byLabel("Put the question").disabled, true);
});

// ---------------------------------------------------------------------------
// the GM panel
// ---------------------------------------------------------------------------

test("before the host answers the panel says it is connecting; without a host the GM is offline and play goes on", async () => {
  const w = windowWith();
  assert.match(w.doc.ids["gm-status-text"].textContent, /Connecting/);
  await attachHost({ anna: null, engine: w.engine, ui: w.ui });
  assert.match(w.doc.ids["gm-status-text"].textContent, /offline/);
  w.doc.ids["gm-input"].value = "look at the bottle";
  w.doc.ids["gm-send"].click();
  await new Promise((r) => setImmediate(r));
  assert.match(w.doc.ids["gm-log"].textContent, /look at the bottle/);
  assert.match(w.doc.ids["gm-log"].textContent, /offline here\. Every part of the case works with the buttons/);
  w.byLabel("Open the investigation").click();
  assert.equal(w.engine.get().phase, PHASES.INVESTIGATION);
});

test("connectAnna resolves to null when the SDK cannot load or never answers", async () => {
  assert.equal(await connectAnna(async () => { throw new Error("404"); }), null);
  const hang = { AnnaAppRuntime: { connect: () => new Promise(() => {}) } };
  assert.equal(await connectAnna(async () => hang, 20), null);
  const ok = { AnnaAppRuntime: { connect: async () => ({ llm: {} }) } };
  assert.deepEqual(await connectAnna(async () => ok, 1000), { llm: {} });
});

test("the GM drives the same engine: its finds show on the stage and its words in the notebook", async () => {
  const w = windowWith();
  const anna = fakeAnna();
  await attachHost({ anna, engine: w.engine, ui: w.ui });
  assert.match(w.doc.ids["gm-status-text"].textContent, /ready/);
  anna.script([
    JSON.stringify({ say: "Opening it.", action: { name: "begin_investigation" } }),
    JSON.stringify({ say: "", action: { name: "examine", args: { object_id: "bolt" } } }),
    JSON.stringify({ say: "The prints are his own." }),
  ]);
  const input = w.doc.ids["gm-input"];
  input.value = "Open up and look at the bolt";
  input.dispatch("keydown", { key: "Enter", isComposing: true }); // mid-IME: not sent
  assert.equal(anna.calls.length, 0);
  input.dispatch("keydown", { key: "Enter" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(input.value, "");
  assert.equal(anna.calls.length, 3);
  assert.match(w.stage().textContent, /The bolt — on the inside of the door/);
  const log = w.doc.ids["gm-log"].textContent;
  assert.match(log, /GM looked at: The bolt/);
  assert.match(log, /The prints are his own\./);
  assert.match(log, /Open up and look at the bolt/);
});

test("when the allowance runs out the panel says so and the buttons still work", async () => {
  const w = windowWith();
  const anna = fakeAnna();
  await attachHost({ anna, engine: w.engine, ui: w.ui });
  anna.script([hostError("quota_exceeded")]);
  await w.ui.askGM("open it");
  assert.match(w.doc.ids["gm-status-text"].textContent, /allowance used up/);
  assert.match(w.doc.ids["gm-log"].textContent, /keep playing with the buttons/i);
  w.byLabel("Open the investigation").click();
  w.objects()[0].click();
  assert.equal(w.engine.get().examined.length, 1);
});

// ---------------------------------------------------------------------------
// reflow: the case text is hard-wrapped; a narrow window must not break mid-sentence.
test("reflow joins mid-sentence breaks and keeps paragraphs and headline lines (all case strings)", async () => {
  const { reflow } = await import("../bundle/ui.js");
  const { CASE } = await import("../bundle/lantern-room.js");
  assert.equal(reflow("in brush ink,\nthe characters\n\nNext.\nAKEBOSHI WEEKLY"), "in brush ink, the characters\n\nNext.\nAKEBOSHI WEEKLY");
  const texts = [];
  (function walk(o) { if (typeof o === "string") texts.push(o); else if (o && typeof o === "object") Object.values(o).forEach(walk); })(CASE);
  assert.ok(texts.length > 50, "walked the real case file, not an empty one");
  let joined = 0;
  for (const t of texts) {
    const r = reflow(t);
    assert.equal((r.match(/\n\n/g) || []).length, (t.match(/\n\n/g) || []).length, "paragraph breaks kept");
    assert.doesNotMatch(r, /[^\n]\n[a-z]/, "no break left before a lower-case continuation");
    assert.equal(r.replace(/\s+/g, ""), t.replace(/\s+/g, ""), "only whitespace changes");
    joined += t.length - r.length === 0 ? (t.match(/[^\n]\n(?=[a-z])/g) || []).length : 1;
  }
  assert.ok(joined > 0, "something was actually joined");
});
