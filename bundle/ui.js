/**
 * Sealed Case — the window.
 *
 * Every part of the case can be played with the buttons here; the GM is an
 * extra pair of hands, not a requirement. Both drive the same engine.
 *
 * One action exists only here: confirming an accusation. Its handler checks
 * `event.isTrusted`, which a browser sets only for real user input, so a
 * script calling `.click()`, a GM reply, the chat payload or anything in
 * storage cannot confirm one. Everything that came from outside (GM replies,
 * reasoning on a staged accusation) is written with textContent only.
 */

import { PHASES } from "./engine.js";
import { TOPICS } from "./gm.js";

/** True only for input that came from the person at the screen. */
/**
 * The case text is hard-wrapped for a wide column. In a narrow Anna window those
 * breaks land mid-sentence, so join a single line break when the next line goes on
 * in lower case. Blank-line paragraph breaks and lines that start a new item
 * (a capital, a dash, a digit: headlines, ledger rows) are left alone.
 */
export function reflow(text) {
  return text.replace(/([^\n])\n(?=[a-z])/g, "$1 ");
}

export function isTrustedClick(event) {
  return Boolean(event && event.isTrusted === true);
}

const GM_STATUS = {
  connecting: "Connecting to the GM…",
  ready: "GM ready",
  busy: "GM is thinking…",
  "off:no-host": "GM offline · the buttons work",
  "off:quota": "GM resting · AI allowance used up",
  "off:unavailable": "GM unavailable · the buttons work",
  error: "GM had a problem · try again",
};

const LOG_LIMIT = 80;

/**
 * @param {{ doc: Document, engine: ReturnType<import("./engine.js").createEngine>, gm?: any }} deps
 */
export function mountUI({ doc, engine, gm = null }) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = (tag === "p" || tag === "blockquote") ? reflow(String(text)) : text;
    return n;
  };

  let gmRef = gm;
  /** The staged accusation last scrolled into view (see confirmCard). */
  let lastShownStage = null;
  /** Last thing that happened, shown in the middle column. */
  let focus = null;

  // -------------------------------------------------------------------------
  // left rail
  // -------------------------------------------------------------------------

  function renderRoom(s) {
    const open = s.phase === PHASES.INVESTIGATION;
    $("room-hint").textContent = open
      ? "Tap anything to look at it."
      : s.phase === PHASES.BRIEFING
        ? "Not open yet. Read the case file first."
        : "The night is over.";

    const list = $("objects");
    list.replaceChildren();
    for (const o of engine.searchable()) {
      const li = el("li");
      const b = el("button", "obj" + (o.examined ? " done" : ""));
      b.type = "button";
      b.append(doc.createTextNode(o.label));
      b.append(el("span", "where", o.where));
      b.disabled = !open;
      b.addEventListener("click", () => doExamine(o.id));
      li.append(b);
      list.append(li);
    }
  }

  function renderSuspects() {
    const list = $("suspects");
    list.replaceChildren();
    for (const s of engine.suspects()) {
      const li = el("li");
      li.append(el("span", "name", s.name));
      li.append(el("span", "role", `${s.role} · ${s.age}`));
      li.append(el("span", "moves", s.known_movements));
      list.append(li);
    }
  }

  // -------------------------------------------------------------------------
  // actions from the buttons
  // -------------------------------------------------------------------------

  function doExamine(id) {
    const r = engine.examine(id);
    if (r.ok) focus = { kind: "found", label: r.label, where: r.where, text: r.found };
    render();
  }

  function doInterview(suspectId, topic) {
    const r = engine.interview(suspectId, topic);
    focus = r.ok ? { kind: "said", who: r.suspect, topic: r.topic, text: r.said } : { kind: "note", text: r.error };
    render();
  }

  // -------------------------------------------------------------------------
  // centre stage
  // -------------------------------------------------------------------------

  function renderStage(s) {
    const body = $("stage-body");
    body.replaceChildren();
    if (s.phase === PHASES.BRIEFING) return renderBriefing(body);
    if (s.phase === PHASES.INVESTIGATION) return renderInvestigation(body, s);
    return renderVerdict(body, s);
  }

  function renderBriefing(body) {
    const f = engine.caseFile();
    body.append(el("p", "kicker", "Case file"));
    body.append(el("h2", null, f.title));
    body.append(el("p", "prose lede", f.briefing));
    body.append(el("hr", "divider"));
    body.append(el("p", null, `Victim: ${f.victim.name}, ${f.victim.age}. ${f.victim.role}. ${f.victim.note}`));
    body.append(
      el(
        "p",
        "howto",
        "Look around the room, question the three of them, then name who, how and why. " +
          "Ask the GM for a hand if you like. Every part of the case also works with the buttons alone.",
      ),
    );

    const controls = el("div", "controls");
    const go = el("button", "act primary", "Open the investigation");
    go.type = "button";
    go.addEventListener("click", () => {
      engine.beginInvestigation();
      focus = null;
      render();
    });
    controls.append(go);
    body.append(controls);
    body.append(el("p", "fiction", "Every person, publisher and place in this story is invented."));
  }

  function renderInvestigation(body, s) {
    body.append(el("p", "kicker", `${engine.caseFile().title} · ${s.objectsLeft} things not yet looked at`));
    body.append(el("h2", null, "What do you make of it?"));

    if (focus?.kind === "found") {
      const d = el("div", "find");
      d.append(el("p", "find-label", `${focus.label} — ${focus.where}`));
      d.append(el("p", "prose", focus.text));
      body.append(d);
    } else if (focus?.kind === "said") {
      const d = el("div", "said");
      d.append(el("p", "who", `${focus.who} · on ${focus.topic}`));
      d.append(el("blockquote", null, focus.text));
      body.append(d);
    } else if (focus?.kind === "note") {
      body.append(el("p", "prose", focus.text));
    } else {
      body.append(
        el(
          "p",
          "prose lede",
          "The bolt is closed. The glass is half full. Three people are downstairs waiting for you to ask them something.\n\nLook at the room, or put a question to one of them.",
        ),
      );
    }

    body.append(askForm(s));

    const nb = engine.notebook();
    if (nb.evidence.length || nb.testimony.length) {
      body.append(el("hr", "divider"));
      body.append(el("p", "kicker", "Notebook"));
      for (const line of nb.evidence) body.append(el("p", null, `— ${line}`));
      for (const line of nb.testimony) body.append(el("p", null, `— ${line}`));
    }

    if (s.pending) body.append(confirmCard(s.pending));
    else body.append(accuseForm());
  }

  function select(label, entries) {
    const d = el("div");
    const id = `sel-${label.toLowerCase()}`;
    const l = el("label", null, label);
    l.htmlFor = id;
    const sel = el("select");
    sel.id = id;
    for (const e of entries) {
      const o = el("option", null, e.label);
      o.value = e.id;
      sel.append(o);
    }
    d.append(l, sel);
    return { wrap: d, sel };
  }

  function askForm(s) {
    const holder = el("div");
    const grid = el("div", "ask");
    const who = select("Ask", engine.suspects().map((x) => ({ id: x.id, label: x.name })));
    const what = select("About", TOPICS.map((t) => ({ id: t, label: t })));
    const act = el("div");
    const b = el("button", "act", "Put the question");
    b.type = "button";
    b.disabled = s.interviewsLeft <= 0;
    b.addEventListener("click", () => doInterview(who.sel.value, what.sel.value));
    act.append(b);
    grid.append(who.wrap, what.wrap, act);
    holder.append(grid);
    const left = s.interviewsLeft;
    holder.append(
      el(
        "p",
        "budget" + (left <= 2 ? " low" : ""),
        left > 0 ? `${left} question${left === 1 ? "" : "s"} left before they stop answering.` : "They have stopped answering.",
      ),
    );
    return holder;
  }

  function accuseForm() {
    const wrap = el("div");
    wrap.append(el("hr", "divider"));
    wrap.append(el("p", "kicker", "Name it"));
    const opts = engine.accusationOptions();
    const grid = el("div", "ask");
    const c = select("Who", opts.culprit);
    const m = select("How", opts.method);
    const w = select("Why", opts.motive);
    const act = el("div");
    const b = el("button", "act", "Put it on the table");
    b.type = "button";
    b.addEventListener("click", () => {
      engine.proposeAccusation({ culprit: c.sel.value, method: m.sel.value, motive: w.sel.value });
      render();
    });
    act.append(b);
    grid.append(c.wrap, m.wrap, w.wrap, act);
    wrap.append(grid);
    return wrap;
  }

  /** The only place an accusation can be confirmed. */
  function onConfirm(event) {
    if (!isTrustedClick(event)) {
      logLine("note", "Nothing was confirmed: that click did not come from you.");
      return;
    }
    const r = engine.confirmAccusation();
    if (r.ok) {
      focus = null;
      gmRef?.note("confirmed");
    }
    render();
  }

  function confirmCard(p) {
    const card = el("div", "confirm");
    card.append(el("p", "kicker", "On the table"));
    const dl = el("dl");
    dl.append(el("dt", null, "Who"), el("dd", null, p.readable.culprit));
    dl.append(el("dt", null, "How"), el("dd", null, p.readable.method));
    dl.append(el("dt", null, "Why"), el("dd", null, p.readable.motive));
    card.append(dl);
    if (p.reasoning) card.append(el("p", "why", p.reasoning));
    card.append(
      el(
        "p",
        "gate",
        "Nothing is decided until you confirm. The GM can put an accusation on the table, but it cannot confirm one.",
      ),
    );
    const controls = el("div", "controls");
    const yes = el("button", "act primary", "Confirm the accusation");
    yes.type = "button";
    yes.addEventListener("click", onConfirm);
    const no = el("button", "act quiet", "Take it back");
    no.type = "button";
    no.addEventListener("click", () => {
      engine.withdrawAccusation();
      render();
    });
    controls.append(yes, no);
    card.append(controls);
    // A newly staged accusation is often below the fold in a small window: bring it into
    // view once (not on every re-render of the same accusation).
    const key = [p.readable.culprit, p.readable.method, p.readable.motive].join("|");
    if (key !== lastShownStage) {
      lastShownStage = key;
      if (typeof card.scrollIntoView === "function") {
        setTimeout(() => card.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
      }
    }
    return card;
  }

  function renderVerdict(body, s) {
    const v = s.verdict;
    body.append(el("p", "kicker", "06:00 — the police are on the stairs"));
    body.append(el("span", "verdict-mark " + (v.correct ? "right" : "wrong"), v.correct ? "The case is closed" : "That was not it"));
    body.append(el("h2", null, v.correct ? "You had it" : "Not quite"));

    const parts = el("ul", "parts");
    const row = (k, label, value) => {
      const li = el("li", v.parts[k] ? "yes" : "no");
      li.append(el("b", null, `${label}: `));
      li.append(doc.createTextNode(value));
      parts.append(li);
    };
    row("culprit", "Who", v.accused.culprit);
    row("method", "How", v.accused.method);
    row("motive", "Why", v.accused.motive);
    body.append(parts);

    if (v.correct) {
      body.append(el("hr", "divider"));
      body.append(el("p", "kicker", "What happened"));
      body.append(el("p", "prose", v.epilogue));
    } else {
      body.append(el("p", "prose lede", v.hint));
    }

    const controls = el("div", "controls");
    if (!v.correct) {
      const again = el("button", "act primary", "Go back to it");
      again.type = "button";
      again.addEventListener("click", () => {
        engine.reopen();
        focus = null;
        render();
      });
      controls.append(again);
    }
    const restart = el("button", "act quiet", "Start the night over");
    restart.type = "button";
    restart.addEventListener("click", () => {
      engine.restart();
      focus = null;
      gmRef?.note("restarted");
      render();
    });
    controls.append(restart);
    body.append(controls);
  }

  // -------------------------------------------------------------------------
  // the GM's notebook (right rail)
  // -------------------------------------------------------------------------

  let logStarted = false;
  function logLine(kind, text) {
    const list = $("gm-log");
    if (!logStarted) {
      list.replaceChildren(); // drop the "Nothing yet." placeholder
      logStarted = true;
    }
    const li = el("li", `gm-${kind}`, text);
    list.prepend(li);
    while (list.children.length > LOG_LIMIT) list.lastChild.remove();
  }

  function setStatus(status, reason) {
    const key = status === "off" ? `off:${reason || "no-host"}` : status;
    const pill = $("gm-status");
    pill.className = `status ${status === "ready" ? "live" : status === "busy" || status === "connecting" ? "busy" : "absent"}`;
    $("gm-status-text").textContent = GM_STATUS[key] || GM_STATUS.error;
  }

  const objectLabel = (id) => engine.searchable().find((o) => o.id === id)?.label ?? id;
  const suspectName = (id) => engine.suspects().find((x) => x.id === id)?.name ?? id;

  function describeAction(name, args, ok) {
    if (!ok) return `tried “${name}”, which it cannot do`;
    switch (name) {
      case "examine":
        return `looked at: ${objectLabel(args.object_id)}`;
      case "interview":
        return `asked ${suspectName(args.suspect_id)} about ${args.topic}`;
      case "propose_accusation":
        return "put an accusation on the table for you";
      case "withdraw_accusation":
        return "took the accusation back";
      case "begin_investigation":
        return "opened the investigation";
      case "restart_case":
        return "started the night over";
      default:
        return `checked: ${name.replaceAll("_", " ")}`;
    }
  }

  function onGMEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "status") {
      setStatus(ev.status, ev.reason);
      if (ev.status === "off" && ev.reason === "quota") {
        logLine("note", "Your AI allowance is used up for now. Keep playing with the buttons; nothing is lost.");
      } else if (ev.status === "off" && ev.reason === "no-host") {
        logLine("note", "The GM is offline here. Every part of the case works with the buttons.");
      } else if (ev.status === "off" && ev.reason === "unavailable") {
        logLine("note", "The GM is not available. Keep playing with the buttons; nothing is lost.");
      } else if (ev.status === "error") {
        logLine("note", "The GM could not answer just now. Try again, or keep playing with the buttons.");
      }
      return;
    }
    if (ev.type === "say") return logLine("say", String(ev.text ?? ""));
    if (ev.type === "note") return logLine("note", String(ev.text ?? ""));
    if (ev.type === "action") {
      const name = String(ev.name ?? "");
      const args = ev.args && typeof ev.args === "object" ? ev.args : {};
      logLine("act", `GM ${describeAction(name, args, Boolean(ev.ok))}`);
      const r = ev.result;
      if (ev.ok && name === "examine" && r?.ok) focus = { kind: "found", label: r.label, where: r.where, text: r.found };
      if (ev.ok && name === "interview" && r?.ok) focus = { kind: "said", who: r.suspect, topic: r.topic, text: r.said };
      render();
    }
  }

  /** Send one line to the GM. `source` is "window" or "chat". */
  async function askGM(text, source = "window") {
    const t = String(text ?? "").trim().slice(0, 500);
    if (!t) return { ok: false, reason: "empty" };
    logLine("you", source === "chat" ? `From the chat: ${t}` : t);
    if (!gmRef) {
      logLine("note", "The GM is not connected. Every part of the case works with the buttons.");
      return { ok: false, reason: "no-gm" };
    }
    return gmRef.ask(t, source);
  }

  function wireGMInput() {
    const input = $("gm-input");
    const send = $("gm-send");
    const go = () => {
      const t = input.value;
      input.value = "";
      askGM(t, "window");
    };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault?.();
        go();
      }
    });
  }

  // -------------------------------------------------------------------------

  function render(s = engine.get()) {
    renderStage(s);
    renderRoom(s);
  }

  renderSuspects();
  wireGMInput();
  if (gmRef) setStatus(gmRef.status, gmRef.reason);
  else setStatus("connecting");
  engine.subscribe(render);

  return {
    render,
    onGMEvent,
    askGM,
    setGM(g) {
      gmRef = g;
      setStatus(g.status, g.reason);
    },
    /** True while nothing has been done yet, so saved progress may be restored. */
    untouched() {
      const s = engine.get();
      return s.phase === PHASES.BRIEFING && s.examined.length === 0 && s.interviews.length === 0;
    },
  };
}
