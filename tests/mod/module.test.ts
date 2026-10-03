// Scenarios for the progress bars module (hooks/register.ts), run by `claude
// plugin test`. They are written first and fail until the module implements the
// behavior: bars and refresh loop (plan task 9), commands, band button and
// persistence (task 10). Sounds are task 11 and are not tested here.
//
// THE INTERFACE THESE TESTS PIN DOWN
//
// Hooks the module uses
//   session.start   loads the saved choices with `$.store.get`, registers both
//                   commands with `$.command.register`, starts
//                   `$.clock.every(2000, ...)` and lets the session start with
//                   `next(e)`. The timer calls `refreshBars` and invalidates
//                   `ui.render` (`$.ui.invalidate('ui.render')`) only when the
//                   snapshot's `changed` is true.
//   ui.render       matcher `{ component: 'AbovePrompt' }`. Draws only there, and
//                   only through `$.ui.resolve(e)` elements. It always lets the
//                   engine draw too: with bars to show it embeds the result of
//                   `await next(e)` once inside its own `Box` tree; with nothing to
//                   show it returns `next(e)` untouched (no Box, no button). It
//                   also yields (returns `next(e)`) while `props.hasSurvey` is set.
//   tool.call       after the tool ran (`await next(e)`) it refreshes the bars, so
//                   plan edits show up before the next timer tick.
//   command.run     `{ command: 'conductor-progress' }` and
//                   `{ command: 'conductor-progress-sound' }`; each answers
//                   `{ text }` (see REPLIES in module-helpers.ts) and never calls next.
//
// What is drawn (find by key, or by Text content; no pixel-level checks)
//   - One row per shown track, a Box keyed `bar-<track id>`, with Text children
//     for the state glyph and label ("running", "needs input", "done", "idle"),
//     the track title, the percent ("50%") and the pill (current phase and task),
//     and a Button keyed `close-<track id>`. At most 3 rows, then a "+N more" Text.
//   - A Button keyed `toggle`, label "Conductor", `hotkey: '9'`, drawn whenever
//     Conductor is initialized and at least one track row exists, with the bars
//     shown or hidden. It does what /conductor-progress does.
//   - Nothing at all (the band is exactly Claude Code's drawing) when Conductor is
//     not initialized, when no track exists, or when the state script fails.
//   - The same tree shape is checked on 'terminal' and 'desktop'; the desktop may
//     draw the bar itself as an Svg as long as the Text and Buttons above exist.
//
// Persistence, with `$.store` (booleans; anything else counts as unset)
//   progress.visible   default true; set to false when the bars are hidden
//   progress.muted     default false; set to true when the sounds are muted
//   Both are written on every toggle and read once at session.start. Dismissals
//   (the close button) live only in memory and are never written.
//
// How the kit stubs answer (details in module-helpers.ts)
//   process.run   by `e.argv[2]`: `locate`, `tracks`, `status --track <id>`
//   session.root / session.cwd   the scripted project directory
//   store.*, command.register, ui.log, ui.toast, audio.play, session.start,
//   tool.call, ui.render, and `mock.clock`. `$.plugin.root` needs no stub.
import { expect, test } from 'claude-code/testing'
import {
  arrange,
  COMMAND_PROGRESS,
  COMMAND_SOUND,
  commandOf,
  draw,
  ENGINE_TEXT,
  ENGINE_TREE,
  finished,
  HOTKEY,
  KEYS,
  needsInput,
  publish,
  REFRESH_MS,
  REPLIES,
  running,
  startSession,
  STORE_MUTED,
  STORE_VISIBLE,
  SURFACES,
  textOf,
  worldOf,
} from './module-helpers.ts'
import type { Surface } from './module-helpers.ts'

const ID = 'login_20260101'
const OTHER = 'search_20260102'

// One test per surface, named after it
function eachSurface(name: string, body: ($: any, on: any, surface: Surface) => Promise<void>) {
  for (const surface of SURFACES) test(`${name} (${surface})`, ($: any, on: any) => body($, on, surface))
}

// --- Drawing ------------------------------------------------------------------------

eachSurface('bars appear at AbovePrompt for the in-progress track', async ($, on, surface) => {
  const w = worldOf(running(ID, 'Login flow', 'Write the parser'))
  const h = arrange(on, w)
  await startSession($, surface)

  const ui = await draw($, surface)

  // The row, its close button and the band toggle are keyed
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect((await ui.find({ key: KEYS.close(ID) }))?.type).toBe('Button')
  expect((await ui.find({ key: KEYS.toggle }))?.type).toBe('Button')
  // Glyph plus label, title, percent and the pill with the current task
  expect(await textOf(ui, /running/i)).toBeDefined()
  expect(await textOf(ui, /Login flow/)).toBeDefined()
  expect(await textOf(ui, /\b50%/)).toBeDefined()
  expect(await textOf(ui, /Write the parser/)).toBeDefined()
  // The progress came from the state script, with no tool call in between
  expect(h.runs.map(commandOf)).toContain('tracks')
  expect(h.runs.map(commandOf)).toContain('status')
})

eachSurface('the tree holds the engine ref from next(e) once when bars are drawn', async ($, on, surface) => {
  arrange(on, worldOf(running(ID)))
  await startSession($, surface)

  const ui = await draw($, surface)

  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: ENGINE_TEXT })).toHaveLength(1)
})

eachSurface('bars still draw while Claude is working', async ($, on, surface) => {
  arrange(on, worldOf(running(ID)))
  await startSession($, surface)

  const ui = await draw($, surface, { isWorking: true })

  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
})

test('the module yields the band to a survey', async ($, on) => {
  arrange(on, worldOf(running(ID)))
  await startSession($)

  // Without a survey the bars draw ...
  const plain = await draw($)
  expect(await plain.find({ key: KEYS.bar(ID) })).toBeDefined()
  await plain.unmount()

  // ... and while a survey holds the band the module returns Claude Code's drawing alone
  const ui = await draw($, 'terminal', { hasSurvey: true })
  expect(await ui.drawn()).toEqual(ENGINE_TREE)
})

test('at most three rows draw, then a "+N more" indicator', async ($, on) => {
  const ids = ['a_20260101', 'b_20260101', 'c_20260101', 'd_20260101']
  arrange(on, worldOf(...ids.map((id) => running(id, 'Track ' + id))))
  await startSession($)

  const ui = await draw($)

  for (const id of ids.slice(0, 3)) expect(await ui.find({ key: KEYS.bar(id) })).toBeDefined()
  expect(await ui.find({ key: KEYS.bar(ids[3]!) })).toBeUndefined()
  expect(await textOf(ui, /\+1 more/)).toBeDefined()
})

// --- Nothing to show ------------------------------------------------------------------

eachSurface('no Conductor directory renders nothing and logs no errors', async ($, on, surface) => {
  const w = worldOf(running(ID))
  w.initialized = false
  const h = arrange(on, w)
  await startSession($, surface)

  const ui = await draw($, surface)

  // The module looked (`locate`), found no Conductor, and left the band to Claude Code
  expect(h.runs.map(commandOf)).toContain('locate')
  expect(h.runs.map(commandOf)).not.toContain('tracks')
  expect(await ui.drawn()).toEqual(ENGINE_TREE)
  expect(await ui.find({ key: KEYS.toggle })).toBeUndefined()
  expect(h.toasts).toEqual([])
  expect(h.logs.filter((line) => /error|fail/i.test(line))).toEqual([])
})

test('a registry with no track renders nothing, not even the toggle', async ($, on) => {
  const h = arrange(on, worldOf())
  await startSession($)

  const ui = await draw($)

  expect(h.runs.map(commandOf)).toContain('tracks')
  expect(await ui.drawn()).toEqual(ENGINE_TREE)
})

test('a failing state script renders nothing and never throws into the host', async ($, on) => {
  const w = worldOf(running(ID))
  w.locate = { reject: 'spawn python3 ENOENT' }
  const h = arrange(on, w)
  await startSession($)

  const ui = await draw($)
  await h.clock.advance(REFRESH_MS)

  expect(h.runs.map(commandOf)).toContain('locate')
  expect(await ui.drawn()).toEqual(ENGINE_TREE)
})

// --- Live refresh ----------------------------------------------------------------------

eachSurface('the bars follow plan changes on the refresh timer', async ($, on, surface) => {
  const w = worldOf(running(ID))
  const h = arrange(on, w)
  await startSession($, surface)
  const ui = await draw($, surface)
  expect(await textOf(ui, /running/i)).toBeDefined()

  // The plan reaches the phase verification task: Conductor waits for the user
  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  expect(await textOf(ui, /needs input/i)).toBeDefined()
  expect(await textOf(ui, /running/i)).toBeUndefined()

  // The user confirms and the last task is done: the bar turns done at 100%
  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  expect(await textOf(ui, /done/i)).toBeDefined()
  expect(await textOf(ui, /\b100%/)).toBeDefined()
  expect(await textOf(ui, /needs input/i)).toBeUndefined()
})

test('a timer tick invalidates ui.render only when the files changed', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(on, w, { recordInvalidate: true })
  await startSession($)
  await draw($)
  await h.clock.settle()
  const baseline = h.invalidations.length

  // Three ticks over unchanged files redraw nothing
  await h.clock.advance(REFRESH_MS * 3)
  expect(h.invalidations.length).toBe(baseline)

  // A changed plan redraws on the next tick
  publish(w, running(ID, 'Login flow', 'Wire the parser'))
  await h.clock.advance(REFRESH_MS)
  expect(h.invalidations.length).toBeGreaterThan(baseline)
  expect(h.invalidations.every((e) => e.event === 'ui.render')).toBe(true)
})

test('a tool call refreshes the bars before the next tick', async ($, on) => {
  const w = worldOf(running(ID))
  // Claude "edits plan.md" through a tool: the plan moves on while the tool runs
  const h = arrange(on, w, { onToolCall: () => publish(w, needsInput(ID)) })
  await startSession($)
  const ui = await draw($)
  expect(await textOf(ui, /running/i)).toBeDefined()

  // Past the refresh interval guard, but before the timer's next tick
  await h.clock.advance(REFRESH_MS - 500)
  await $.tool.call({ tool: 'Edit', file_path: 'conductor/tracks/' + ID + '/plan.md' })
  await h.clock.settle()

  expect(await textOf(ui, /needs input/i)).toBeDefined()
})

// --- Closing a bar -------------------------------------------------------------------------

eachSurface('the close button hides a bar until its track changes', async ($, on, surface) => {
  const w = worldOf(running(ID, 'Login flow', 'Write the parser'), running(OTHER, 'Search', 'Index the files'))
  const h = arrange(on, w)
  await startSession($, surface)
  const ui = await draw($, surface)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()

  await ui.press({ key: KEYS.close(ID) })

  // Only the closed bar goes, and nothing is written to the store: it lasts for the session
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()
  expect(await ui.find({ key: KEYS.bar(OTHER) })).toBeDefined()
  expect(h.writes).toEqual([])

  // The same state on the next tick keeps it closed
  await h.clock.advance(REFRESH_MS)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()

  // The track moves to another task: the bar returns
  publish(w, running(ID, 'Login flow', 'Wire the parser'), running(OTHER, 'Search', 'Index the files'))
  await h.clock.advance(REFRESH_MS)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(await textOf(ui, /Wire the parser/)).toBeDefined()
})

// --- Commands and the band button -------------------------------------------------------------

test('session.start registers both commands', async ($, on) => {
  const h = arrange(on, worldOf(running(ID)))

  await startSession($)

  const names = h.registered.map((e) => e.name)
  expect(names).toContain(COMMAND_PROGRESS)
  expect(names).toContain(COMMAND_SOUND)
  for (const e of h.registered) expect(typeof e.description === 'string' && e.description !== '').toBe(true)
})

eachSurface('/conductor-progress hides the bars and brings them back', async ($, on, surface) => {
  const h = arrange(on, worldOf(running(ID)))
  await startSession($, surface)
  const ui = await draw($, surface)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()

  const hidden = await $.command.run({ command: COMMAND_PROGRESS, args: '' })

  // Bars gone; the small toggle stays so they can be brought back, and the engine's drawing stays
  expect(hidden.text).toBe(REPLIES.hidden)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()
  expect((await ui.find({ key: KEYS.toggle }))?.type).toBe('Button')
  expect(await textOf(ui, ENGINE_TEXT)).toBeDefined()
  expect(h.store.get(STORE_VISIBLE)).toBe(false)

  const shown = await $.command.run({ command: COMMAND_PROGRESS, args: '' })

  expect(shown.text).toBe(REPLIES.shown)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(h.store.get(STORE_VISIBLE)).toBe(true)
})

test('/conductor-progress-sound mutes and unmutes and saves the choice', async ($, on) => {
  const h = arrange(on, worldOf(running(ID)))
  await startSession($)
  const ui = await draw($)

  const muted = await $.command.run({ command: COMMAND_SOUND, args: '' })

  expect(muted.text).toBe(REPLIES.muted)
  expect(h.store.get(STORE_MUTED)).toBe(true)
  // Muting changes no drawing: the bars stay
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()

  const unmuted = await $.command.run({ command: COMMAND_SOUND, args: '' })

  expect(unmuted.text).toBe(REPLIES.unmuted)
  expect(h.store.get(STORE_MUTED)).toBe(false)
})

eachSurface('the band button toggles the bars like the command', async ($, on, surface) => {
  const h = arrange(on, worldOf(running(ID)))
  await startSession($, surface)
  const ui = await draw($, surface)

  // A digit hotkey, so it fires from an empty prompt, and the "Conductor" label
  const toggle = await ui.find({ key: KEYS.toggle })
  expect(toggle?.props.hotkey).toBe(HOTKEY)
  expect(String(toggle?.props.label)).toMatch(/Conductor/)

  await ui.press({ key: KEYS.toggle })
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()
  expect(await ui.find({ key: KEYS.toggle })).toBeDefined()
  expect(h.store.get(STORE_VISIBLE)).toBe(false)

  await ui.press({ key: KEYS.toggle })
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(h.store.get(STORE_VISIBLE)).toBe(true)
})

// --- Persistence ---------------------------------------------------------------------------------

test('a hidden choice saved by an earlier run is honored after a reload', async ($, on) => {
  // The module is freshly loaded here, and the store already holds what a run saved
  const h = arrange(on, worldOf(running(ID)), { store: { [STORE_VISIBLE]: false } })
  await startSession($)

  const ui = await draw($)

  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()
  expect((await ui.find({ key: KEYS.toggle }))?.type).toBe('Button')
  // The command continues from the saved choice: it shows the bars
  const shown = await $.command.run({ command: COMMAND_PROGRESS, args: '' })
  expect(shown.text).toBe(REPLIES.shown)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(h.store.get(STORE_VISIBLE)).toBe(true)
})

test('a muted choice saved by an earlier run is honored after a reload', async ($, on) => {
  const h = arrange(on, worldOf(running(ID)), { store: { [STORE_MUTED]: true } })
  await startSession($)

  // The next toggle unmutes, because the module loaded `muted: true` at session.start
  const answer = await $.command.run({ command: COMMAND_SOUND, args: '' })

  expect(answer.text).toBe(REPLIES.unmuted)
  expect(h.store.get(STORE_MUTED)).toBe(false)
})

test('a garbled saved value falls back to the defaults', async ($, on) => {
  arrange(on, worldOf(running(ID)), { store: { [STORE_VISIBLE]: 'nope', [STORE_MUTED]: 7 } })
  await startSession($)

  const ui = await draw($)
  const answer = await $.command.run({ command: COMMAND_SOUND, args: '' })

  // Bars shown (default), and the sound was not muted before this toggle
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(answer.text).toBe(REPLIES.muted)
})

test('toggling writes only the two store keys and starts only read-only processes', async ($, on) => {
  const h = arrange(on, worldOf(running(ID)))
  await startSession($)
  await $.command.run({ command: COMMAND_PROGRESS, args: '' })
  await $.command.run({ command: COMMAND_SOUND, args: '' })

  // Per-user choices live in $.store, never in the repository: no process but the
  // state script's read-only commands runs
  for (const call of h.runs) expect(['locate', 'tracks', 'status']).toContain(commandOf(call))
  expect(h.writes.map((write) => write.key).sort()).toEqual([STORE_MUTED, STORE_VISIBLE])
})
