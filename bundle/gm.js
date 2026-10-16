/**
 * Sealed Case — the GM.
 *
 * The GM is the user's own model, reached through `anna.llm.complete`. That
 * call is stateless, so this file rebuilds the whole conversation every time,
 * and it builds it from three things only:
 *
 *   1. SYSTEM_PROMPT, a fixed string;
 *   2. what the player typed (or what the Anna chat passed in as `say`);
 *   3. the results of the actions below, run against the engine.
 *
 * None of those can carry the solution: the engine keeps it in a closure, and
 * the action table has no entry that reads it. There is no action that
 * confirms an accusation, none that reads the epilogue, and none that reopens
 * a case (whether a case can be reopened depends on the verdict). The GM can
 * stage an accusation; only a trusted click in ui.js can confirm one.
 *
 * The GM answers in JSON: {"say": "...", "action": {"name": "...", "args": {...}}}.
 * Anything else is treated as untrusted text. It is shown with textContent
 * only, and an action is run only if its name is open in the current phase.
 */

import { PHASES } from "./engine.js";

/** Interview topics the suspects will discuss. Public: the form offers them too. */
export const TOPICS = Object.freeze([
  "victim",
  "alibi",
  "bottle",
  "photograph",
  "clipping",
  "manuscript",
]);

/**
 * What the GM may do, phase by phase. This mirrors the WebMCP tool sets of the
 * browser version (webmcp.js), with two removals in the verdict phase:
 * `read_epilogue` (it returns the solution) and `reopen_case` (it succeeds or
 * fails depending on the verdict). Reopening is a button for the player.
 */
export const ACTIONS_BY_PHASE = Object.freeze({
  [PHASES.BRIEFING]: Object.freeze([
    "read_case_file",
    "list_suspects",
    "get_progress",
    "begin_investigation",
  ]),
  [PHASES.INVESTIGATION]: Object.freeze([
    "read_case_file",
    "list_suspects",
    "get_progress",
    "search_room",
    "examine",
    "interview",
    "review_notebook",
    "get_accusation_options",
    "propose_accusation",
    "withdraw_accusation",
  ]),
  [PHASES.VERDICT]: Object.freeze([
    "read_case_file",
    "list_suspects",
    "get_progress",
    "restart_case",
  ]),
});

export const LIMITS = Object.freeze({
  actionsPerTurn: 5, // a turn makes at most actionsPerTurn + 1 calls
  sayChars: 1500,
  argChars: 64,
  reasoningChars: 400,
  playerChars: 500,
  historyMessages: 40,
  maxTokens: 700,
  queue: 3,
});

export const SYSTEM_PROMPT = `You are the game master (GM) for Sealed Case, a one-player murder mystery that the player is playing in a window next to you. You run the table; the player solves the case.

You have not been told the solution, and nothing you will be shown contains it. You know only what the actions below return. So:
- Never guess or hint who did it, how, or why, and never say whether an accusation is right.
- Never invent evidence, testimony, people or places. Describe only what action results contain.
- When a suspect speaks, quote the "said" text exactly. Some suspects may be lying; you cannot tell which.
- Do what the player asks. Do not search, question or accuse beyond what they asked for.

Reply with exactly one JSON object and nothing else:
{"say": "what you tell the player", "action": {"name": "<action>", "args": {}}}
Leave "action" out when you are only talking. After an action you get its result and may reply again; you can take a few actions per turn.
"say" is shown to the player as plain text, so do not use markdown or HTML. Keep it short. Answer in the player's language.

Actions (each [table] message lists the ones open right now):
read_case_file {} - the case file.
list_suspects {} - the people still in the building, with their ids.
get_progress {} - phase, questions left, staged accusation.
begin_investigation {} - open the room and the questioning (briefing only).
search_room {} - what can be examined, with ids.
examine {"object_id": "<id>"} - look at one thing.
interview {"suspect_id": "<id>", "topic": "<topic>"} - one question. Topics: ${TOPICS.join(", ")}. Only eight questions in total, so ask only what the player asked for.
review_notebook {} - everything gathered so far.
get_accusation_options {} - the ids an accusation is built from.
propose_accusation {"culprit": "<id>", "method": "<id>", "motive": "<id>", "reasoning": "<one sentence>"} - put an accusation on the table for the player to look at. Only when the player asks for it.
withdraw_accusation {} - take a staged accusation back.
restart_case {} - start the night over. Only when the player asks for it.

There is no action that confirms an accusation. Only the player can confirm one, by clicking in the window.`;

/** Fixed notes the window may add to the GM's transcript. Never free text. */
const TABLE_NOTES = Object.freeze({
  confirmed:
    "The player clicked Confirm. The night is over. The result was shown to the player only; you are not told it.",
  restarted: "The player started the night over. Everything gathered so far has been cleared.",
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function progress(engine) {
  const s = engine.get();
  return {
    phase: s.phase,
    objects_not_yet_examined: s.objectsLeft,
    questions_left: s.interviewsLeft,
    accusation_staged: s.pending ? s.pending.readable : null,
    note: "You cannot confirm an accusation. Only the player can, by clicking Confirm in the window.",
  };
}

/** The whole vocabulary. Nothing here can confirm, reopen or read the ending. */
const HANDLERS = Object.freeze({
  read_case_file: (e) => e.caseFile(),
  list_suspects: (e) => e.suspects(),
  get_progress: (e) => progress(e),
  begin_investigation: (e) => e.beginInvestigation(),
  search_room: (e) => e.searchable(),
  examine: (e, a) => e.examine(str(a.object_id, LIMITS.argChars)),
  interview: (e, a) => {
    const topic = str(a.topic, LIMITS.argChars).trim();
    if (!topic) return { ok: false, error: "Say what to ask about.", topics: TOPICS };
    return e.interview(str(a.suspect_id, LIMITS.argChars), topic);
  },
  review_notebook: (e) => e.notebook(),
  get_accusation_options: (e) => e.accusationOptions(),
  propose_accusation: (e, a) =>
    e.proposeAccusation({
      culprit: str(a.culprit, LIMITS.argChars),
      method: str(a.method, LIMITS.argChars),
      motive: str(a.motive, LIMITS.argChars),
      reasoning: str(a.reasoning, LIMITS.reasoningChars),
    }),
  withdraw_accusation: (e) => e.withdrawAccusation(),
  restart_case: (e) => e.restart(),
});

export const ACTION_NAMES = Object.freeze(Object.keys(HANDLERS));

/** Run one action the GM asked for, if it is open right now. */
export function runAction(engine, action) {
  const phase = engine.get().phase;
  const allowed = ACTIONS_BY_PHASE[phase] || [];
  const name = action && typeof action.name === "string" ? action.name : "";
  if (/confirm|commit|verdict|finali[sz]e/i.test(name)) {
    return {
      ok: false,
      value: {
        ok: false,
        error:
          "Only the player can confirm an accusation, by clicking Confirm in the window. There is no action for it.",
      },
    };
  }
  if (!Object.hasOwn(HANDLERS, name)) {
    return { ok: false, value: { ok: false, error: `There is no action called "${name}".`, allowed } };
  }
  if (!allowed.includes(name)) {
    return { ok: false, value: { ok: false, error: `"${name}" is not open in the ${phase} phase.`, allowed } };
  }
  try {
    const value = HANDLERS[name](engine, action.args || {});
    return { ok: value?.ok !== false, value };
  } catch {
    return { ok: false, value: { ok: false, error: "That action failed." } };
  }
}

/** The state line appended to every message the table sends the GM. */
function tableLines(engine) {
  const s = engine.get();
  const staged = s.pending
    ? `${s.pending.readable.culprit} / ${s.pending.readable.method} / ${s.pending.readable.motive} (waiting for the player's click)`
    : "none";
  const lines = [
    `[table] phase: ${s.phase}; questions left: ${s.interviewsLeft}; examined: ${
      s.examined.join(", ") || "nothing yet"
    }; staged accusation: ${staged}`,
    `[table] actions open now: ${(ACTIONS_BY_PHASE[s.phase] || []).join(", ")}`,
  ];
  if (s.phase === PHASES.VERDICT) {
    lines.push("[table] The night is over. The result was shown to the player only; you are not told it.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// reading the GM's reply
// ---------------------------------------------------------------------------

function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function cleanArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const out = {};
  for (const [k, v] of Object.entries(args).slice(0, 8)) {
    if (typeof v === "string") out[k.slice(0, 40)] = v.slice(0, LIMITS.reasoningChars);
    else if (typeof v === "number" || typeof v === "boolean") out[k.slice(0, 40)] = v;
  }
  return out;
}

/** Salvage a "say" string from a reply that is almost JSON. */
function salvageSay(raw) {
  const m = raw.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    const s = tryJSON(`"${m[1]}"`);
    if (typeof s === "string") return s;
  }
  return raw.trim().startsWith("{") ? "" : raw;
}

/**
 * Parse one reply. Returns { ok, say, action } where `ok` is false when the
 * reply was not a single JSON object; `action` is null or { name, args }.
 */
export function parseReply(text) {
  const raw = String(text ?? "").trim();
  let obj = tryJSON(raw);
  if (obj === undefined) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) obj = tryJSON(fenced[1].trim());
  }
  if (obj === undefined) {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) obj = tryJSON(raw.slice(a, b + 1));
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, say: salvageSay(raw).slice(0, LIMITS.sayChars), action: null };
  }
  const say = typeof obj.say === "string" ? obj.say.slice(0, LIMITS.sayChars) : "";
  let action = null;
  const a = obj.action;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    action = { name: typeof a.name === "string" ? a.name.slice(0, LIMITS.argChars) : "", args: cleanArgs(a.args) };
  } else if (typeof a === "string" && a) {
    action = { name: a.slice(0, LIMITS.argChars), args: {} };
  }
  return { ok: true, say, action };
}

/** Pull the text out of an llm.complete answer, whichever envelope it comes in. */
function replyText(res) {
  if (res && typeof res === "object" && res.ok === false) {
    const err = new Error(res.error?.message || "host error");
    err.code = res.error?.code;
    throw err;
  }
  const r = res && typeof res === "object" && res.ok === true && "result" in res ? res.result : res;
  const c = r?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  if (c && typeof c.text === "string") return c.text;
  const err = new Error("The GM's reply was empty.");
  err.code = "bad_response";
  throw err;
}

/** "quota" | "unavailable" | "error" */
export function errorKind(err) {
  const s = `${err?.code ?? ""} ${err?.error?.code ?? ""} ${err?.data?.code ?? ""} ${err?.message ?? ""}`;
  if (/quota/i.test(s)) return "quota";
  if (/permission_denied|not_granted|not_implemented|unsupported/i.test(s)) return "unavailable";
  return "error";
}

// ---------------------------------------------------------------------------
// the GM
// ---------------------------------------------------------------------------

/**
 * @param {{ anna?: any, engine: ReturnType<import("./engine.js").createEngine>,
 *           onEvent?: (ev: {type: string}) => void }} deps
 * Events: {type:"status", status, reason} {type:"say", text}
 *         {type:"action", name, args, ok, result} {type:"note", text}
 */
export function createGM({ anna = null, engine, onEvent = () => {} } = {}) {
  const hasLLM = Boolean(anna && anna.llm && typeof anna.llm.complete === "function");
  let history = []; // { role: "user"|"assistant", text }
  let status = hasLLM ? "ready" : "off";
  let reason = hasLLM ? null : "no-host";
  let queue = Promise.resolve();
  let waiting = 0;

  const emit = (ev) => {
    try {
      onEvent(ev);
    } catch {
      // the window's display problems are not the GM's
    }
  };
  const setStatus = (s, r = null) => {
    status = s;
    reason = r;
    emit({ type: "status", status: s, reason: r });
  };
  const push = (role, text) => history.push({ role, text });

  /** The full request for one call. Consecutive same-role messages are merged. */
  function request() {
    let msgs = history.slice(-LIMITS.historyMessages);
    while (msgs.length && msgs[0].role !== "user") msgs = msgs.slice(1);
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.text += `\n\n${m.text}`;
      else merged.push({ role: m.role, text: m.text });
    }
    return {
      systemPrompt: SYSTEM_PROMPT,
      messages: merged.map((m) => ({ role: m.role, content: { type: "text", text: m.text } })),
      maxTokens: LIMITS.maxTokens,
      temperature: 0.4,
    };
  }

  async function turn(playerText, source) {
    const text = String(playerText ?? "").slice(0, LIMITS.playerChars).trim();
    if (!text) return { ok: false, reason: "empty" };
    if (!hasLLM) {
      setStatus("off", "no-host");
      return { ok: false, reason: "no-host" };
    }
    const who = source === "chat" ? "[player, via the Anna chat]" : "[player]";
    push("user", `${who} ${text}\n${tableLines(engine)}`);
    setStatus("busy");

    let actions = 0;
    let askedToReformat = false;
    for (let step = 0; step <= LIMITS.actionsPerTurn; step++) {
      let raw;
      try {
        raw = replyText(await anna.llm.complete(request()));
      } catch (err) {
        const kind = errorKind(err);
        setStatus(kind === "error" ? "error" : "off", kind);
        return { ok: false, reason: kind, actions };
      }
      const parsed = parseReply(raw);
      const atCap = step === LIMITS.actionsPerTurn;

      if (!parsed.ok) {
        push("assistant", raw.slice(0, LIMITS.sayChars));
        if (parsed.say) emit({ type: "say", text: parsed.say });
        if (!atCap && !askedToReformat) {
          askedToReformat = true;
          push("user", `[table] Your last reply was not a single JSON object. Reply again with exactly one JSON object.\n${tableLines(engine)}`);
          continue;
        }
        emit({ type: "note", text: "The GM's reply was not in the expected form, so nothing was done." });
        break;
      }

      const action = atCap ? null : parsed.action;
      push("assistant", JSON.stringify(action ? { say: parsed.say, action } : { say: parsed.say }));
      if (parsed.say) emit({ type: "say", text: parsed.say });
      if (!action) {
        if (atCap && parsed.action) emit({ type: "note", text: "The GM reached its limit for this turn." });
        break;
      }

      const r = runAction(engine, action);
      actions += 1;
      emit({ type: "action", name: action.name, args: action.args, ok: r.ok, result: r.value });
      const last = step + 1 === LIMITS.actionsPerTurn;
      push(
        "user",
        `[result of ${action.name}] ${JSON.stringify(r.value)}\n${tableLines(engine)}${
          last ? '\n[table] That was your last action this turn. Reply with "say" only.' : ""
        }`,
      );
    }
    setStatus("ready");
    return { ok: true, actions };
  }

  return {
    get status() {
      return status;
    },
    get reason() {
      return reason;
    },
    /** Hand the GM one line from the player. Turns run one at a time. */
    ask(text, source = "window") {
      if (waiting >= LIMITS.queue) return Promise.resolve({ ok: false, reason: "busy" });
      waiting += 1;
      const p = queue.then(() => turn(text, source)).finally(() => {
        waiting -= 1;
      });
      queue = p.catch(() => {});
      return p;
    },
    /** Tell the GM about a click, using one of the fixed notes only. */
    note(kind) {
      if (Object.hasOwn(TABLE_NOTES, kind)) push("user", `[table] ${TABLE_NOTES[kind]}`);
    },
  };
}
