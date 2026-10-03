# Specification: Conductor Progress Mod

## Overview

Add a Claude Code UI mod to the Conductor plugin that shows the active track's
progress above the prompt, in the spirit of `zycck/claude-mods` `plan-progress`.
The mod reads Conductor's own state (`plan.md`, `tracks.md`) from disk, so the
bars cost no tokens, stay accurate for hand edits and other sessions, and need no
changes to how skills record progress. It also adds a footer button, slash
commands and short sounds. It ships inside the existing root plugin, and hosts
without mod support ignore it, so the skills keep working unchanged.

## Functional Requirements

1. **Module registration.** The root plugin declares the mod through
   `hooks/hooks.json` (`"modules": ["./register.ts"]`, exactly one path). The
   module exports `register(on)` and uses the `$` mods API to render the bars, the
   button, the commands and the sounds. It loads directly, with no build step.
2. **Track bars.** One row per active track (status `in_progress`; if none, the
   first `pending` track), at most 3 rows with a "+N more" indicator. Each row
   shows: state glyph and label, a short track title (the name before a colon),
   a progress bar, percent, the current phase (`phase n/N`), the task, and a
   close button. The columns line up from row to row, and the controls end the
   row at the right edge, clear of the band's own `[-]` marker.
3. **Phases and tasks.** The bar has one segment per phase, sized by its task
   count and filled as its tasks complete; a tip marks the task in progress. The
   task names the current task (`current_task`, else `next: ` and `next_task`);
   a track in `needs_input` says it is waiting for the user to verify the phase.
   Hovering a phase segment shows its title, completed/total counts and its
   checkpoint SHA when one is recorded, in place of the row's phase and task on
   the terminal (so the band never clips it) and as an Svg tooltip on the
   desktop. The state script reports per-phase counts, not a task list.
4. **Derived states.** `running`: a task is `[~]`. `needs_input`: the current task
   is a phase-verification task (Conductor is waiting for the user to confirm).
   `done`: all tasks are complete or the track status is completed (bar turns
   green). `idle`: tracks exist but no task is in progress.
5. **Live refresh.** The mod refreshes the bars when the files change (polling at
   a short interval while the session is open, and after tool calls), without
   Claude calling any tool and without blocking the UI. The band does not redraw
   on its own: a `$.clock.every` timer and the tool-call hook call
   `$.ui.invalidate('ui.render')`.
6. **Data source.** Progress comes from the Conductor state script's `locate`,
   `tracks` and `status` commands, run with `$.process.run` (no TypeScript parser
   port), so parsing rules (phases, sub-tasks,
   checkpoints, verification detection) live in one place. The Conductor directory
   is resolved with the same rules as the skills, including `CONDUCTOR_DIR`.
7. **Commands.** `/conductor-progress` shows or hides the bars.
   `/conductor-progress-sound` mutes or unmutes the sounds.
8. **Band button.** A "Conductor" `Button` with a hotkey in the `AbovePrompt` band
   does the same as `/conductor-progress` (a digit hotkey also fires from an empty
   prompt). The band is shared, so the mod keeps other mods' drawing by placing
   `await next(e)` inside its own tree. There is no footer render site.
9. **Sounds.** A short sound plays when a track enters `needs_input` and when it
   becomes `done`, never on the initial load of an already-finished track.
10. **Dismissal.** Closing a bar hides it for the current session; it returns if the
    track changes state afterwards.
11. **Opt-in and quiet by default.** Nothing renders when no initialized Conductor
    directory or no track exists. The show/hide and mute choices are remembered
    per user in `$.store`, never written to the repository.
12. **Plugin integration.** `plugin.json`, `marketplace.json`, `VERSION`,
    `lint_skills.py` and CI stay consistent: the linter validates that
    `hooks.json` lists exactly one module path that exists (and any `types` file).
    The manifest stays at the root `plugin.json`, where plain `claude plugin
    validate .` only checks the marketplace manifest. A small script therefore
    stages a temporary copy of the repo with `plugin.json` placed at
    `.claude-plugin/plugin.json` and runs `claude plugin validate` there; it fails
    unless the output lists the module's hooks and `$` calls. CI runs both, and
    `CONTRIBUTING.md` documents it.
13. **Tests.** Tests are `*.test.ts` files run by the official `claude plugin
    test` harness, in CI through `npx -y @anthropic-ai/claude-code plugin test`.
    They cover the plan-to-bar model (a pure file that never touches `$`): state
    derivation, percent, phase/task dots, the "+N more" cut-off, dismissal and
    sound triggers, plus commands, the button, drawing and fail-soft cases. A
    manual live checklist covers real rendering and audio.
14. **Docs.** The README gets a section on the mod (what it shows, commands, how it
    behaves in the desktop app and the terminal), states the minimum Claude Code
    version (2.1.287, when mods arrived) and the version it was tested with
    because mod events and methods can change between releases, says that
    Anthropic can switch mods off remotely (a rollout flag; the skills keep
    working), notes that skill loading on Claude Code older than 2.1.287 is
    unverified, and
    `CONTRIBUTING.md` documents the new test commands.

## Non-Functional Requirements

- **Zero token cost:** no tool is registered and nothing is added to the system
  prompt.
- **Fail soft:** if the state script is missing, Python is unavailable, or output
  is invalid, the mod shows nothing or a dismissible notice and never throws into
  the host. A load failure must not affect the skills.
- **Performance:** a refresh never blocks rendering; refresh work is throttled and
  skipped while the files are unchanged.
- **Accessibility:** terminal colors are theme keys (`success`, `warning`,
  `suggestion`, `inactive`, `subtle`), so they follow the user's light, dark or
  colorblind theme; the desktop Svg carries a light and a dark palette whose
  fills keep at least 3:1 against the page and the empty track. State is never
  conveyed by color alone (glyph plus label, and the percent).
- **Compatibility:** works in the desktop app (bars drawn as `Svg`) and the
  terminal (`Box`/`Text`); narrow widths degrade (drop the phase tag, shrink the
  bar, drop the task, then move the toggle to a footer row) instead of
  overflowing. On Claude Code older than 2.1.287 the skills must keep
  working. This could not be verified (2.1.286 needs a login before plugins
  load), so it is documented as unverified. If the rollout flag is off, the mod
  does not load and the skills are unaffected.
- **No new runtime dependencies** for Python users; the mod is the only
  TypeScript in the repository, needs no build step or `typescript` package, and
  Node is needed only to run `claude plugin test` in CI.
- **Style:** follows the Python and general style guides for any scripts, and the
  conventional-commit and release-please flow for versioning.

## Acceptance Criteria

- With an in-progress track, the bars appear above the prompt and update as tasks
  are marked `[~]` and `[x]`, with no Claude tool call in between.
- Reaching a phase-verification task switches the bar to `needs_input` and plays
  the sound once; confirming it and finishing the track turns the bar green and
  plays the done sound once.
- `/conductor-progress`, `/conductor-progress-sound` and the footer button behave
  as specified and the choice survives a restart.
- In a project with no Conductor directory the mod renders nothing and logs no
  errors.
- Removing Python or breaking the state script output leaves Claude Code usable
  and the skills unaffected.
- `python3 -m unittest discover -s tests`, `python3 scripts/lint_skills.py`, the
  mod's `claude plugin test` suite, `claude plugin validate .` and the staged-copy
  validation (which lists the module's hooks and calls) all pass in CI.

## Out of Scope

- Subagent rows, per-step timing and hover timestamps (plan.md records no
  times).
- An error state (cannot be derived from plan.md) and a mod tool that skills call.
- A `workflow.md` setting for the bars, and any change to the skills' protocols.
- Showing progress recorded only on other track branches or worktrees (v1 reads
  the current checkout; `status --branches` stays CLI-only).
- Editing plans from the UI.
- Antigravity UI support.
- A `SessionMode` footer item and panes (v1 draws only in the band above the
  prompt).
- Moving the manifest to `.claude-plugin/plugin.json`.
- Per-task hover titles and SHAs (would need a `status --tasks` option in
  `conductor_state.py`).

## References

- `scripts/conductor_state.py`: `locate`, `tracks`, `status` output (phases,
  counts, `current_task`, `next_task`, `is_phase_verification`) and the
  plan.md/tracks.md formats.
- `plugin.json`, `.claude-plugin/marketplace.json`, `scripts/lint_skills.py`,
  `.github/workflows/ci.yml`: manifest, linter and CI constraints.
- Claude Code mods docs (https://code.claude.com/docs/en/plugins/mods/):
  reference, create, interface and test. The types Claude Code writes for the
  installed version win over any page when they disagree.
- `conductor/tracks/progress_mod_20261002/notes.md`: verified API findings.
- Inspiration only (not a binding contract): `zycck/claude-mods`
  `plugins/plan-progress` (MIT).

## Related Past Work

None yet (this is the project's first track).

## Assumptions

1. **Refresh interval.** About 2 seconds through `$.clock.every`, plus after tool
   calls; tunable in code, not user-facing.
2. **Sounds.** Two short original `.wav` files generated by a script in the repo
   (no third-party audio copied), played with `$.audio.play`.
3. **Attribution.** All mod code is written fresh; if any code is adapted from
   `plan-progress`, its MIT notice is kept.
4. **Display.** At most 3 bars, ordered by status then registry order; a finished
   bar stays until closed.
5. **Release.** A single `feat` commit flows through release-please; no manual
   version bump.

Resolved by the API spike (see `notes.md`): the mod API shape and its minimum
version, TypeScript loading without a build, `$.process.run` for the state
script, and `$.store` for per-user persistence.

## Revision History

- 2026-10-02: Align the spec with the verified Claude Code mod API: band button
  instead of a footer button, `claude plugin test` instead of a custom stub
  engine, `$.store` persistence, `$.process.run` data access, `register(on)` with
  `$`, a `$.clock.every` redraw timer, and a minimum-version requirement (API
  spike findings in `notes.md`).
- 2026-10-02: Validate the mod module through a staged copy with the manifest at
  `.claude-plugin/plugin.json`, because plain `claude plugin validate .` never
  analyses it with the manifest at the repo root; document the remote rollout
  switch and the unverified older-version behavior; fix a stale "stub-engine"
  acceptance criterion (Task 2 findings in `notes.md`).
- 2026-10-03: UI refresh after a live review in the terminal: a segmented bar
  per phase replaces the bar, capsules and dots; theme-key colors replace fixed
  hex chips; aligned columns, short titles, an explicit needs-input line and the
  toggle on the first row (footer row only when needed); a right gutter fixes the
  close button being clipped by the band's `[-]` marker.
- 2026-10-03: Hover details are phase-level only (title, counts, checkpoint SHA);
  dots show status only, because `status` has no per-task list and the model tests
  already build dots from per-phase counts (decision after task 4).
