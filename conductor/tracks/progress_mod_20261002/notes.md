# Spike Notes: Claude Code Mod API

Verified 2026-10-02 against the official docs
(https://code.claude.com/docs/en/plugins/mods/reference.md and
.../mods/create.md) and the installed Claude Code 2.1.288. No third-party plugin
was installed or run. The `zycck/claude-mods` code was only read.

## Confirmed

- Mods are an official, documented feature, available from Claude Code **v2.1.287**.
  The docs warn that events and methods "can change between releases", so the
  README must state the tested version.
- A mod is a plugin with `hooks/hooks.json` holding `"modules": ["./register.ts"]`
  (exactly one path; `.js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx`, ES module). Claude
  Code loads `.ts`/`.tsx` directly: **no compile or build step**.
- The module exports `register(on, options)`. Hooks are
  `on(event, matcher?, async ($, e, next) => ...)`; the API is the `$` argument
  (`$.ui`, `$.command`, `$.process`, `$.fs`, `$.store`, `$.state`, `$.clock`,
  `$.audio`, ...), **not** an engine import. Only `atom/read/update/derive/memberOf`
  come from `claude-code`.
- `$.process.run` / `spawn` (30 s default timeout) can run `python3`;
  `$.fs.read/exists/stat` read files; `$.clock.every` runs timers.
  Assumption 3 holds, so no TypeScript parser port is needed.
- `$.store` is a machine-wide key-value store (4 MiB): fits per-user show/hide and
  mute. `$.state` is per-session reactive state and needs a `types` file.
- `$.audio.play` plays sounds. `$.command.register` + `command.run` hook add
  slash commands.
- UI: `ui.render` hook at the `AbovePrompt` site (`maxRows`, `bodyColumns`),
  elements `Box`, `Text`, `Button` (with `hotkey`), `Svg` (desktop only),
  `Raster` (terminal only). Redraws are throttled to 10/s (30/s terminal).
- Tests: `claude plugin test` runs `*.test.ts` files using
  `import { expect, test } from 'claude-code/testing'`, firing events with no
  session. `claude plugin validate <dir>` statically analyses the module and
  prints hooks, `$` calls, and state use.
- Static-analysis rules: write `$.ns.method(...)` in full, literal event names,
  no destructuring `$`, imports only from inside the plugin plus `claude-code`.

## Spec changes forced

1. **Footer button (req. 8):** the reference lists no footer render site. Use a
   `Button` (with a `hotkey`) in the `AbovePrompt` band instead. Re-check
   `SessionMode`/`PromptHint` in the interface guide before settling.
2. **Tests (req. 13, Assumption 2):** replace the custom stub engine and
   TypeScript compile with the official `claude plugin test` harness; CI runs it
   through `npx -y @anthropic-ai/claude-code plugin test`. No `typescript`
   dependency.
3. **Persistence (Assumption 5):** use `$.store`.
4. **Data access (Assumption 3):** `$.process.run` of the state script; drop the
   TypeScript parser fallback.
5. **API shape (Assumption 1, req. 1):** `register(on)` with `$`; `types` only if
   `$.state` is used. Rendering uses Svg on desktop and Raster on terminal, or
   shared `Box`/`Text` elements.
6. **Compatibility (new):** document Claude Code >= 2.1.287 and verify that a
   plugin with a `modules` hook still loads its skills on older versions.

## Open questions for later tasks

- Does `claude plugin validate .` on the repo root analyse the module (it only
  printed the marketplace result in the spike)? Try `claude plugin validate .`
  with the real module in Phase 1, task 2.
- Behaviour of the plugin on Claude Code < 2.1.287 (cannot be tested here).
