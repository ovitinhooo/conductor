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
   `hooks/hooks.json` (`modules`) and registers one module that renders the bars,
   the footer button, the commands and the sounds.
2. **Track bars.** One row per active track (status `in_progress`; if none, the
   first `pending` track), at most 3 rows with a "+N more" indicator. Each row
   shows: state glyph, track title, progress bar, percent, and a close button.
3. **Phases and tasks.** Phases render as capsules and tasks as dots, filled as
   tasks complete. A pill on the bar names the current phase and task
   (`current_task`, else `next_task`). Hovering a phase or dot shows its title and,
   for completed items, the recorded short SHA or checkpoint.
4. **Derived states.** `running`: a task is `[~]`. `needs_input`: the current task
   is a phase-verification task (Conductor is waiting for the user to confirm).
   `done`: all tasks are complete or the track status is completed (bar turns
   green). `idle`: tracks exist but no task is in progress.
5. **Live refresh.** The mod refreshes the bars when the files change (polling at
   a short interval while the session is open, and after tool calls), without
   Claude calling any tool and without blocking the UI.
6. **Data source.** Progress comes from the Conductor state script's `locate`,
   `tracks` and `status` commands, so parsing rules (phases, sub-tasks,
   checkpoints, verification detection) live in one place. The Conductor directory
   is resolved with the same rules as the skills, including `CONDUCTOR_DIR`.
7. **Commands.** `/conductor-progress` shows or hides the bars.
   `/conductor-progress-sound` mutes or unmutes the sounds.
8. **Footer button.** A "Conductor" button in the footer does the same as
   `/conductor-progress` and is shown while the mod is loaded.
9. **Sounds.** A short sound plays when a track enters `needs_input` and when it
   becomes `done`, never on the initial load of an already-finished track.
10. **Dismissal.** Closing a bar hides it for the current session; it returns if the
    track changes state afterwards.
11. **Opt-in and quiet by default.** Nothing renders when no initialized Conductor
    directory or no track exists. The show/hide and mute choices are remembered
    per user, never written to the repository.
12. **Plugin integration.** `plugin.json`, `marketplace.json`, `VERSION`,
    `lint_skills.py` and CI stay consistent: the linter validates that
    `hooks.json` modules and any `types` file exist, and `claude plugin validate`
    still passes.
13. **Tests.** The module is compiled and driven against a stub engine in CI
    (Node 22, already used by the plugin-validation job). Unit tests cover the
    plan-to-bar model: state derivation, percent, phase/task dots, the "+N more"
    cut-off, dismissal and sound triggers. A manual live checklist covers
    rendering and audio.
14. **Docs.** The README gets a section on the mod (what it shows, commands, how it
    behaves in the desktop app and the terminal), and `CONTRIBUTING.md` documents
    the new test commands.

## Non-Functional Requirements

- **Zero token cost:** no tool is registered and nothing is added to the system
  prompt.
- **Fail soft:** if the state script is missing, Python is unavailable, or output
  is invalid, the mod shows nothing or a dismissible notice and never throws into
  the host. A load failure must not affect the skills.
- **Performance:** a refresh never blocks rendering; refresh work is throttled and
  skipped while the files are unchanged.
- **Accessibility:** state colors keep at least 4.5:1 contrast for the text on
  them, and state is never conveyed by color alone (glyph plus label).
- **Compatibility:** works in the desktop app and the terminal; narrow widths
  degrade (drop the pill, then the dots) instead of overflowing.
- **No new runtime dependencies** for Python users; the mod is the only
  JavaScript/TypeScript in the repository, and Node is needed only for its tests.
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
  mod's stub-engine tests and `claude plugin validate .` all pass in CI.

## Out of Scope

- Subagent rows, per-step timing and hover timestamps (plan.md records no
  times).
- An error state (cannot be derived from plan.md) and a mod tool that skills call.
- A `workflow.md` setting for the bars, and any change to the skills' protocols.
- Showing progress recorded only on other track branches or worktrees (v1 reads
  the current checkout; `status --branches` stays CLI-only).
- Editing plans from the UI.
- Antigravity UI support.

## References

- `scripts/conductor_state.py`: `locate`, `tracks`, `status` output (phases,
  counts, `current_task`, `next_task`, `is_phase_verification`) and the
  plan.md/tracks.md formats.
- `plugin.json`, `.claude-plugin/marketplace.json`, `scripts/lint_skills.py`,
  `.github/workflows/ci.yml`: manifest, linter and CI constraints.
- Inspiration only (not a binding contract): `zycck/claude-mods`
  `plugins/plan-progress` (MIT).

## Related Past Work

None yet (this is the project's first track).

## Assumptions

1. **Mod API.** I inspected a single third-party example, not official docs. I
   assume the same API: `hooks.json` `modules`, a `claude-code` module with atoms
   and footer/command registration, and optional `types`. It looks new, so the
   first task is a spike that confirms it against the installed Claude Code, and
   the plan adapts if it differs.
2. **Language and build.** The module is TypeScript (`.tsx`) like the example,
   compiled by the host or by the test harness; `typescript` is installed only in
   the CI test job.
3. **Data access.** The mod may spawn `python3 scripts/conductor_state.py` from the
   plugin root against the project root; if the engine disallows subprocesses, it
   falls back to reading files and a small TypeScript port of the parser with a
   parity test.
4. **Refresh interval.** About 2 seconds, plus after tool calls; tunable in code,
   not user-facing.
5. **Persistence.** Show/hide and mute are stored through the engine's per-user
   storage if it offers one, otherwise per session.
6. **Sounds.** Two short original `.wav` files generated by a script in the repo
   (no third-party audio copied).
7. **Attribution.** All mod code is written fresh; if any code is adapted from
   `plan-progress`, its MIT notice is kept.
8. **Display.** At most 3 bars, ordered by status then registry order; a finished
   bar stays until closed.
9. **Release.** A single `feat` commit flows through release-please; no manual
   version bump.
