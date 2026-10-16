# Sealed Case — an Anna App

**A one-player murder mystery for a coffee break.** It is 02:40 in a private bar above a
second-hand bookshop in Jimbocho, and the man at the counter is dead behind a door bolted
from the inside. Search the room, question the three people still in the building, then name
who did it, how, and why.

Your GM is the AI you already use in Anna. It can search the room, question the suspects and
put an accusation on the table when you ask. **It is not told the answer**, so it learns what
you learn, and **it cannot make the accusation**: only your click can. You can also play the
whole case with the buttons and never talk to the GM at all.

The scenario is original and entirely fictional.

## Privacy

Sealed Case collects nothing about you. Your progress (which clues you have found, which
questions you have asked, an accusation you have put on the table) is saved to your own
Anna storage as short IDs so you can pick up where you left off. Nothing is sent anywhere
else: the window talks only to Anna. What you type to the GM goes to your Anna AI as part of
the game, and uses your own Anna allowance.

## Support

Questions or problems: open an issue at https://github.com/ai-q-labs/sealed-case-anna/issues

---

## For developers

UI-bundle-only App (manifest `schema: 3`). No Executa, no Skill. `ui.host_api` asks for
`llm: ["complete"]` and `storage: ["get", "set", "delete"]` only. Zero dependencies.

| File | |
|---|---|
| `manifest.json` | From the design. The numeric app id is 573 (Developer Console, created 2026-10-16) |
| `app.json` | Listing fields (`slug`, `name`, `category`, `tagline`). **Key names unverified**: the docs name the columns, not the file's schema |
| `bundle/app.js` | The only file that loads the SDK (dynamic `import()` of `/static/anna-apps/_sdk/latest/index.js`) and wires everything |
| `bundle/gm.js` | The GM loop on `anna.llm.complete` |
| `bundle/persist.js` | Ids-only progress in `anna.storage`; the `entry_payload` filter |
| `bundle/ui.js` | The window. Confirm is the only `isTrusted`-gated control |
| `bundle/engine.js`, `bundle/lantern-room.js` (flat: the Console uploader keeps no folders) | Copied from `sealed-case-mcp` (Akeboshi version); only comments changed |
| `support/harness.mjs` | Fake DOM, fake Anna runtime, scripted GM. Outside `test/` so `node --test` does not run it as a test |

### The two properties, and where they are tested

**(a) The GM never receives the solution.** `llm.complete` is stateless, so `gm.js` rebuilds
the whole request each call from a fixed system prompt, the player's words, and the results of
actions run against the engine. The engine keeps the solution in a closure; the GM's action
table has no handler that reads it (`read_epilogue` and `reopen_case` are gone; reopening is a
button). After a verdict the GM is told only that the player confirmed; it is not told the
result. `test/gm.test.mjs` captures every `llm.complete` argument across a scripted playthrough
in which the GM tries every action in every phase, sends broken JSON and tries to confirm, while
the human confirms a correct accusation mid-run. It checks them two ways: a grep for
solution-only text, and a byte-for-byte comparison with the same run against a case whose
culprit, method and motive differ. A planted-leak test shows both checks catch what they should.

**(b) Only a person's click confirms an accusation.** There is no confirm action. The Confirm
button's handler requires `event.isTrusted === true`. The window never reads `anna.runtimeState`
or `runtime_state_synced`; from `entry_payload` it takes only a `say` string of up to 500
characters; GM text is written with `textContent`; a verdict is never restored from storage (a
confirmed accusation comes back staged and must be clicked again). `test/persist.test.mjs`
throws forged storage, `runtimeState`, `entry_payload` and GM replies at a mounted window.

**What is not claimed.** The case file ships inside the bundle and is publicly fetchable, as the
original open-source game always was. The claim is that the *GM* is never given the answer,
not that nobody can read it. One more limit: if the player reopens a case after a wrong
verdict, the GM can infer that the last accusation was wrong (the phase goes back to the
investigation). It still never learns which part, the hint or the answer.

### Tests

```bash
npm test        # node --test; no install step
```

The UI tests run against a fake DOM, not a browser. Not covered: real layout (320 px), the
real CSP, the real SDK and host, real `isTrusted` values, keyboard and screen readers.

### Open questions

- Does the validator accept `schema: 3` with `required_executas: []` and this `storage` block?
- `app.json` key names, and whether the Console reads that file at all.
- Response envelope of `llm.complete` and `storage.get`: the docs show both a bare result and
  `{ok, result}`; both are handled. Error codes: both `quota_exceeded` and `APP_QUOTA_EXCEEDED`
  are treated as "allowance used up".
- The exact names of the shell's `--anna-safe-area-*` variables (the CSS also uses `env()`).
- Whether `anna.entryPayload` still holds the last `say` after a reload (handled: a hash of the
  last handled `say` is saved so it is not replayed).
- GM cost per player message: up to 6 calls, history capped at 40 messages (`LIMITS` in
  `gm.js`).
