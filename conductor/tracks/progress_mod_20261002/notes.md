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

## Task 2 findings

Verified 2026-10-02 with Claude Code 2.1.288 and the scaffold `hooks/hooks.json`
(`{"description": ..., "modules": ["./register.ts"]}`) plus a no-op
`hooks/register.ts` (one `session.start` hook that calls `$.ui.log(..., { to:
'debug' })` and `next(e)`).

### `claude plugin validate`

- `claude plugin validate .` on the repo root still prints only
  `Validating marketplace manifest: .../.claude-plugin/marketplace.json` and
  `Validation passed`. **It does not analyse the module**, because the marketplace
  manifest wins when both exist.
- `claude plugin validate plugin.json` (the root manifest) passes with only an
  `author` warning and no module analysis. `validate hooks/hooks.json` is wrong
  (treated as a plugin manifest: `name` missing, `modules` unknown).
- The module is analysed only when the validated directory has
  `.claude-plugin/plugin.json`. A throwaway copy of the repo layout with the
  manifest copied there prints:

  ```text
  Validating hooks: .../hooks/hooks.json
    ./register.ts hooks: session.start
    ./register.ts calls: $.ui.log
  Validation passed with warnings
  ```

  (`--json` carries the same two lines under `contents[].notes`).
- **Consequence for spec req. 12 and the acceptance criteria:** `claude plugin
  validate .` cannot list the module's hooks and `$` calls with the current layout
  (root `plugin.json`). Options for a later task: validate a staged copy that has
  `.claude-plugin/plugin.json` (script or CI step), or move the manifest to
  `.claude-plugin/plugin.json` (needs `plugin.json` consumers, `lint_skills.py` and
  release-please updated). Decision left to the orchestrator.

### Loading the repo with `--plugin-dir`

- `claude -p ... --plugin-dir <repo>` from a throwaway cwd treats the repo as one
  plugin (`agents` at its top marks it), reads `hooks/hooks.json`, and loads
  7 skills and 1 agent; the model listed all 7 `conductor:*` skills. The root
  `plugin.json` is enough for loading.
- The first run refused the module: `hooks module conductor@inline not loaded:
  hooks modules are turned off for installed plugins in this process: the rollout
  switch was saved off by an earlier session and is not refreshed yet`. This is the
  remote rollout flag (`tengu_plugin_hooks_modules`) read from a stale disk cache;
  the skills still loaded. A second run loaded the module: `hooks module
  conductor@inline loaded (worker, environment 1, tier user); events:
  session.start`, `plugin.register: conductor ... admitted`, and the debug line
  `[conductor] $.ui.log (to debug): conductor progress mod loaded`. The README
  should mention that a mod can be switched off remotely by Anthropic and that the
  skills keep working then.
- Loading writes generated files into the repo: `.claude-plugin/types/`
  (self-ignored by its own `.gitignore`) and a root `tsconfig.json` extending it.
  The root `tsconfig.json` is now in `.gitignore`.
- Not checked: the interactive `/plugin` "mods active" line (needs a TUI); the
  debug-log lines above are the evidence that the mod is registered.
- `claude plugin test` in a directory without a module prints `no hooks module to
  load`, which confirms the harness is available (tests start in a later phase).

### Claude Code older than 2.1.287

- Troubleshooting docs: a version older than 2.1.287 "predates mods being on by
  default"; they give no statement about a plugin whose `hooks.json` has `modules`.
- 2.1.286 was installed with `npm install --prefix <scratch>` and run with
  `CLAUDE_CONFIG_DIR` pointing at a throwaway directory (`~/.claude` untouched).
  `claude -p` stops at `Not logged in` before plugins load, and no credentials were
  copied, so **skill loading on older versions is unverified**. `claude plugin
  validate` in 2.1.286 already analyses the module and prints the same two lines,
  so that release does know the `modules` key; versions before it were not tried
  (2.0.0 does not start on the installed Node).
