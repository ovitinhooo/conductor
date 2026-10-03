# Implementation Plan: Conductor Progress Mod

## Phase 1: Spike and Scaffolding

- [x] Task: Verify the mod API against the installed Claude Code 314be78
    - [x] Load `zycck/claude-mods` `plan-progress` in a scratch session and confirm: `hooks.json` `modules`, the `claude-code` import (atoms, footer button, slash commands, sound playback, per-user storage), and desktop vs terminal behavior
    - [x] Confirm whether a module can spawn `python3` (Assumption 3) and note the fallback if not
    - [x] Record the findings, and any spec changes they force, in `conductor/tracks/progress_mod_20261002/notes.md`; run `conductor-revise` if the spec must change
- [x] Task: Check plugin validation with a minimal module 7469c3a
    - [x] Add `hooks/hooks.json` + a no-op `hooks/register.ts`; run `claude plugin validate .` and confirm it reports the module's hooks and `$` calls
    - [x] Load the repo with `claude --plugin-dir .` and confirm the skills still load and `/plugin` lists the mod
    - [x] Check the mods troubleshooting docs for Claude Code older than 2.1.287; if an older release can run in a throwaway directory, confirm the skills still load, otherwise record "unverified" in `notes.md`
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Progress Model (pure logic)

- [ ] Task: Write failing tests for the plan-to-bar model
    - [ ] Write them as `*.test.ts` files run by `claude plugin test`, against a pure `hooks/model.ts` that never touches `$` (the validator rejects `$` passed to imported functions)
    - [ ] State derivation (running, needs_input via `is_phase_verification`, done, idle)
    - [ ] Percent, phase capsules and task dots from `status` output
    - [ ] Row selection: in_progress first, else first pending, max 3, "+N more"
    - [ ] Dismissal rules and sound triggers (once per transition, never on initial load)
    - [ ] Fail-soft input: missing fields, empty tracks, invalid JSON
- [ ] Task: Implement the model to pass the tests
    - [ ] Pure functions with no engine imports, per the style guides
    - [ ] Cover edge cases from the tests; keep coverage above 80%
- [ ] Task: Write failing tests, then implement, the state-script client
    - [ ] Top-level functions in `register.ts` resolve the plugin root and project root and call `locate`, `tracks`, `status` per `scripts/conductor_state.py` with `$.process.run`; tests stub `$.process`
    - [ ] Throttle and skip refresh when output is unchanged; fail soft (show nothing) when Python or the script is missing
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Module Rendering, Controls and Sounds

- [ ] Task: Write failing `claude plugin test` scenarios for the module
    - [ ] Read the mods test docs first (stubbing `$.process`/`$.store`, testing drawings and timers)
    - [ ] Scenarios: bars appear at `AbovePrompt`, update on file change, hide with `/conductor-progress`, mute with `/conductor-progress-sound`, band button, close button, no Conductor dir renders nothing
- [ ] Task: Implement the bars and refresh loop
    - [ ] `ui.render` at `AbovePrompt`, keeping other mods' drawing with `await next(e)`; `Svg` on desktop, `Box`/`Text` on terminal
    - [ ] Row layout: glyph, title, bar, percent, close; phase capsules, task dots, pill, hover titles and SHAs where the surface supports them
    - [ ] `$.clock.every` timer and tool-call hook calling `$.ui.invalidate('ui.render')`; narrow-width degradation
    - [ ] Colors meeting 4.5:1 contrast; glyph plus label for every state
- [ ] Task: Implement commands, footer button and persistence
    - [ ] `/conductor-progress`, `/conductor-progress-sound` with `$.command.register`, and a "Conductor" `Button` with a hotkey in the band
    - [ ] Persist show/hide and mute per user in `$.store`, loaded at `session.start`
- [ ] Task: Add the sounds
    - [ ] `scripts/make_sounds.py` generates two short original `.wav` files (needs input, done) into `sounds/`; test it produces valid audio
    - [ ] Play them with `$.audio.play` on the specified transitions only
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 4: Plugin, Lint and CI Integration

- [ ] Task: Write failing lint tests for the new manifest files
    - [ ] `lint_skills.py` reports a `hooks.json` without exactly one existing module path, or a missing `types` file, and passes on the valid layout (extend `tests/test_lint_skills.py`)
- [ ] Task: Implement the lint checks and wire the plugin
    - [ ] Final `hooks/hooks.json` (plus `types/index.d.ts` and the `types` field only if `$.state` is used); keep `VERSION` in sync and `marketplace.json` free of `version`
- [ ] Task: Add the mod tests to CI
    - [ ] CI job in `.github/workflows/ci.yml` (Node 22, no `typescript`) running `npx -y @anthropic-ai/claude-code plugin test` and `plugin validate .`
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 5: Documentation and Live Verification

- [ ] Task: Document the mod
    - [ ] README section: what the bars show, states, commands, desktop vs terminal, fail-soft behavior, opt-out
    - [ ] State the minimum Claude Code version (2.1.287), the tested version, and that mod events and methods can change between releases
    - [ ] `CONTRIBUTING.md`: mod test commands; manual live checklist file under the mod's tests
- [ ] Task: Run the manual live checklist
    - [ ] In a real session with a throwaway track: bars update with no tool calls, needs-input and done sounds play once, commands and button work, restart keeps the settings, no-Conductor and no-Python cases stay quiet
- [ ] Task: Final checks
    - [ ] `python3 -m unittest discover -s tests`, `python3 scripts/lint_skills.py`, the mod tests and plugin validation all pass
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
