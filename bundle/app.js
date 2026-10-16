/**
 * Sealed Case — Anna App entry point. The only file that touches the SDK.
 *
 * The window is drawn before the SDK connects, so the case is playable with
 * the buttons from the first paint even if the host never answers. The SDK is
 * loaded with a dynamic import for the same reason: if it fails to load, the
 * GM stays offline and nothing else breaks.
 *
 * What is taken from the host:
 *   - `anna.llm.complete`, for the GM (gm.js);
 *   - `anna.storage.get/set`, for ids-only progress (persist.js);
 *   - `entry_payload`, from which only a short `say` string is accepted.
 * What is deliberately not taken: `anna.runtimeState`, and the
 * `runtime_state_synced` event. Nothing here can confirm an accusation; that
 * is a trusted click in ui.js.
 */

import { createEngine } from "./engine.js";
import { createGM } from "./gm.js";
import { createPersistence, readEntrySay } from "./persist.js";
import { mountUI } from "./ui.js";

const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";
const CONNECT_TIMEOUT_MS = 10000;

/** Connect to the host, or resolve to null. Never throws. */
export async function connectAnna(load = (url) => import(url), timeoutMs = CONNECT_TIMEOUT_MS) {
  let timer;
  try {
    const { AnnaAppRuntime } = await load(SDK_URL);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    return await Promise.race([AnnaAppRuntime.connect(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire the GM, saved progress and the chat payload to a mounted window.
 * `anna` may be null (no host): the GM then reports itself offline.
 */
export async function attachHost({ anna, engine, ui }) {
  const gm = createGM({ anna, engine, onEvent: ui.onGMEvent });
  ui.setGM(gm);

  const persist = createPersistence({ anna, engine });
  if (ui.untouched()) await persist.restore();
  persist.start();

  // Chat -> window. A short `say` string is the only thing accepted.
  let last = { say: null, at: 0 };
  const fromChat = (payload, isInitial) => {
    const say = readEntrySay(payload);
    if (!say) return;
    if (isInitial && persist.isRemembered(say)) return; // already handled before a reload
    const now = Date.now();
    if (say === last.say && now - last.at < 3000) return; // the same delivery twice
    last = { say, at: now };
    persist.rememberEntry(say);
    ui.askGM(say, "chat");
  };
  // Diagnostics: shapes only (key names), never the text the player typed.
  const keys = (p) => (p && typeof p === "object" ? Object.keys(p).join(",") : typeof p);
  console.info(`[sealed-case] host ${anna ? "connected" : "absent"}; entryPayload keys=${keys(anna?.entryPayload)}; on=${typeof anna?.on}`);
  fromChat(anna?.entryPayload, true);
  if (anna && typeof anna.on === "function") {
    anna.on("entry_payload", (payload) => {
      console.info(`[sealed-case] entry_payload event keys=${keys(payload)}`);
      fromChat(payload, false);
    });
  }

  return { gm, persist };
}

// ---------------------------------------------------------------------------
// boot (in the browser only; the tests import the functions above)
// ---------------------------------------------------------------------------

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const engine = createEngine();
  const ui = mountUI({ doc: document, engine });
  const anna = await connectAnna();
  await attachHost({ anna, engine, ui });
}
