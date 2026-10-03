# Implementation Plan: Conductor Progress Mod

## Phase 1: Spike and Scaffolding

- [x] Task: Verify the mod API against the installed Claude Code 314be78
    - [x] Load `zycck/claude-mods` `plan-progress` in a scratch session and confirm: `hooks.json` `modules`, the `claude-code` import (atoms, footer button, slash commands, sound playback, per-user storage), and desktop vs terminal behavior
    - [x] Confirm whether a module can spawn `python3` (Assumption 3) and note the fallback if not
    - [x] Record the findings, and any spec changes they force, in `conductor/tracks/progress_mod_20261002/notes.md`; run `conductor-revise` if the spec must change
- [ ] Task: Check plugin validation with a minimal module
    - [ ] Add a no-op `hooks/hooks.json` + module and run `npx -y @anthropic-ai/claude-code plugin validate .`; confirm it passes (or document the required shape)
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Progress Model (pure logic)

- [ ] Task: Write failing tests for the plan-to-bar model
    - [ ] State derivation (running, needs_input via `is_phase_verification`, done, idle)
    - [ ] Percent, phase capsules and task dots from `status` output
    - [ ] Row selection: in_progress first, else first pending, max 3, "+N more"
    - [ ] Dismissal rules and sound triggers (once per transition, never on initial load)
    - [ ] Fail-soft input: missing fields, empty tracks, invalid JSON
- [ ] Task: Implement the model to pass the tests
    - [ ] Pure functions with no engine imports, per the style guides
    - [ ] Cover edge cases from the tests; keep coverage above 80%
- [ ] Task: Write failing tests, then implement, the state-script client
    - [ ] Resolve the plugin root and project root; call `locate`, `tracks`, `status` per `scripts/conductor_state.py`
    - [ ] Throttle and skip refresh when output is unchanged; fall back silently when Python or the script is missing
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Module Rendering, Controls and Sounds

- [ ] Task: Build the stub-engine test harness
    - [ ] Compile the module and drive its hooks against a stub engine (modeled on `plan-progress` tests, written fresh)
    - [ ] Write failing scenarios: bars appear, update on file change, hide with `/conductor-progress`, mute with `/conductor-progress-sound`, close button, no Conductor dir renders nothing
- [ ] Task: Implement the bars and refresh loop
    - [ ] Row layout: glyph, title, bar, percent, close; phase capsules, task dots, pill, hover titles and SHAs
    - [ ] Polling and after-tool-call refresh; narrow-width degradation
    - [ ] Colors meeting 4.5:1 contrast; glyph plus label for every state
- [ ] Task: Implement commands, footer button and persistence
    - [ ] `/conductor-progress`, `/conductor-progress-sound`, footer "Conductor" button
    - [ ] Persist show/hide and mute per user (per session if the engine offers no storage)
- [ ] Task: Add the sounds
    - [ ] `scripts/make_sounds.py` generates two short original `.wav` files (needs input, done) into `sounds/`; test it produces valid audio
    - [ ] Play them on the specified transitions only
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 4: Plugin, Lint and CI Integration

- [ ] Task: Write failing lint tests for the new manifest files
    - [ ] `lint_skills.py` reports a missing `hooks.json` module path or `types` file, and passes on the valid layout (extend `tests/test_lint_skills.py`)
- [ ] Task: Implement the lint checks and wire the plugin
    - [ ] Final `hooks/hooks.json`, `types/index.d.ts`, `plugin.json` fields; keep `VERSION` in sync and `marketplace.json` free of `version`
- [ ] Task: Add the mod tests to CI
    - [ ] Node job in `.github/workflows/ci.yml` (Node 22, `typescript`) running the stub-engine tests; `claude plugin validate .` still passes
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 5: Documentation and Live Verification

- [ ] Task: Document the mod
    - [ ] README section: what the bars show, states, commands, desktop vs terminal, fail-soft behavior, opt-out
    - [ ] `CONTRIBUTING.md`: mod test commands; manual live checklist file under the mod's tests
- [ ] Task: Run the manual live checklist
    - [ ] In a real session with a throwaway track: bars update with no tool calls, needs-input and done sounds play once, commands and button work, restart keeps the settings, no-Conductor and no-Python cases stay quiet
- [ ] Task: Final checks
    - [ ] `python3 -m unittest discover -s tests`, `python3 scripts/lint_skills.py`, the mod tests and plugin validation all pass
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
