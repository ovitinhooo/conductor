# Implementation Plan: Conductor Progress Mod

## Phase 1: Spike and Scaffolding [checkpoint: d5f65c5]

- [x] Task: Verify the mod API against the installed Claude Code 314be78
    - [x] Load `zycck/claude-mods` `plan-progress` in a scratch session and confirm: `hooks.json` `modules`, the `claude-code` import (atoms, footer button, slash commands, sound playback, per-user storage), and desktop vs terminal behavior
    - [x] Confirm whether a module can spawn `python3` (Assumption 3) and note the fallback if not
    - [x] Record the findings, and any spec changes they force, in `conductor/tracks/progress_mod_20261002/notes.md`; run `conductor-revise` if the spec must change
- [x] Task: Check plugin validation with a minimal module 7469c3a
    - [x] Add `hooks/hooks.json` + a no-op `hooks/register.ts`; run `claude plugin validate .` and confirm it reports the module's hooks and `$` calls
    - [x] Load the repo with `claude --plugin-dir .` and confirm the skills still load and `/plugin` lists the mod
    - [x] Check the mods troubleshooting docs for Claude Code older than 2.1.287; if an older release can run in a throwaway directory, confirm the skills still load, otherwise record "unverified" in `notes.md`
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) d5f65c5

## Phase 2: Progress Model (pure logic) [checkpoint: 85a8cb3]

- [x] Task: Write failing tests for the plan-to-bar model 857e527
    - [x] Write them as `*.test.ts` files run by `claude plugin test`, against a pure `hooks/model.ts` that never touches `$` (the validator rejects `$` passed to imported functions)
    - [x] State derivation (running, needs_input via `is_phase_verification`, done, idle)
    - [x] Percent, phase capsules and task dots from `status` output
    - [x] Row selection: in_progress first, else first pending, max 3, "+N more"
    - [x] Dismissal rules and sound triggers (once per transition, never on initial load)
    - [x] Fail-soft input: missing fields, empty tracks, invalid JSON
- [x] Task: Implement the model to pass the tests f9f4f71
    - [x] Pure functions with no engine imports, per the style guides
    - [x] Cover edge cases from the tests; keep coverage above 80%
- [x] Task: Write failing tests, then implement, the state-script client 85a8cb3
    - [x] Top-level functions in `register.ts` resolve the plugin root and project root and call `locate`, `tracks`, `status` per `scripts/conductor_state.py` with `$.process.run`; tests stub `$.process`
    - [x] Throttle and skip refresh when output is unchanged; fail soft (show nothing) when Python or the script is missing
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) 85a8cb3

## Phase 3: Module Rendering, Controls and Sounds [checkpoint: 13c7be0]

- [x] Task: Write failing `claude plugin test` scenarios for the module 5932687
    - [x] Read the mods test docs first (stubbing `$.process`/`$.store`, testing drawings and timers)
    - [x] Scenarios: bars appear at `AbovePrompt`, update on file change, hide with `/conductor-progress`, mute with `/conductor-progress-sound`, band button, close button, no Conductor dir renders nothing
- [x] Task: Implement the bars and refresh loop 0619daf
    - [x] `ui.render` at `AbovePrompt`, keeping other mods' drawing with `await next(e)`; `Svg` on desktop, `Box`/`Text` on terminal
    - [x] Row layout: glyph, title, bar, percent, close; phase capsules, task dots, pill; phase-level hover (title, counts, checkpoint SHA) where the surface supports it
    - [x] `$.clock.every` timer and tool-call hook calling `$.ui.invalidate('ui.render')`; narrow-width degradation
    - [x] Colors meeting 4.5:1 contrast; glyph plus label for every state
- [x] Task: Implement commands, footer button and persistence 0700d68
    - [x] `/conductor-progress`, `/conductor-progress-sound` with `$.command.register`, and a "Conductor" `Button` with a hotkey in the band
    - [x] Persist show/hide and mute per user in `$.store`, loaded at `session.start`
- [x] Task: Add the sounds 13c7be0
    - [x] `scripts/make_sounds.py` generates two short original `.wav` files (needs input, done) into `sounds/`; test it produces valid audio
    - [x] Play them with `$.audio.play` on the specified transitions only
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md) 13c7be0

## Phase 4: Plugin, Lint and CI Integration

- [x] Task: Write failing lint tests for the new manifest files ac482b7
    - [x] `lint_skills.py` reports a `hooks.json` without exactly one existing module path, or a missing `types` file, and passes on the valid layout (extend `tests/test_lint_skills.py`)
- [x] Task: Implement the lint checks and wire the plugin bf0a7be
    - [x] Final `hooks/hooks.json` (plus `types/index.d.ts` and the `types` field only if `$.state` is used); keep `VERSION` in sync and `marketplace.json` free of `version`
- [x] Task: Write failing tests for the staged-copy validation script 7b2de21
    - [x] `tests/test_validate_mod.py`: staging copies the repo without `.git`, the generated `tsconfig.json` and `.claude-plugin/types`, places the root `plugin.json` at `.claude-plugin/plugin.json`, and leaves the original tree untouched
    - [x] The `claude` command is injectable so the test stubs it; a stubbed "Validation passed" with no `hooks:` line fails, and one that lists hooks passes
- [ ] Task: Implement `scripts/validate_mod.py`
    - [ ] Standard library only; runs `claude plugin validate` in the staged copy (`claude` locally, `npx -y @anthropic-ai/claude-code` in CI) and requires the module's `hooks:` line
- [ ] Task: Add the mod tests to CI
    - [ ] CI job in `.github/workflows/ci.yml` (Node 22, no `typescript`) running `npx -y @anthropic-ai/claude-code plugin test`, `plugin validate .` and `python3 scripts/validate_mod.py`
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 5: Documentation and Live Verification

- [ ] Task: Document the mod
    - [ ] README section: what the bars show, states, commands, desktop vs terminal, fail-soft behavior, opt-out
    - [ ] State the minimum Claude Code version (2.1.287), the tested version, that mod events and methods can change between releases, that Anthropic can switch mods off remotely (the skills keep working), and that older-than-2.1.287 skill loading is unverified
    - [ ] `CONTRIBUTING.md`: mod test and staged-validation commands; manual live checklist file under the mod's tests
- [ ] Task: Run the manual live checklist
    - [ ] In a real session with a throwaway track: bars update with no tool calls, needs-input and done sounds play once, commands and button work, restart keeps the settings, no-Conductor and no-Python cases stay quiet
- [ ] Task: Final checks
    - [ ] `python3 -m unittest discover -s tests`, `python3 scripts/lint_skills.py`, the mod tests, plugin validation and `python3 scripts/validate_mod.py` all pass
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
