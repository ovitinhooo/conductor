// Scenarios for the sounds the progress mod plays (hooks/register.ts), run by
// `claude plugin test`. They are written first and fail until the module calls
// `$.audio.play`.
//
// THE INTERFACE THESE TESTS PIN DOWN
//   - A track entering `needs_input` plays the needs-input sound once, and a track
//     becoming `done` plays the done sound once, each with one `$.audio.play`.
//   - The clip is the plugin's own file, `{ asset: 'sounds/<name>.wav' }`: relative
//     to the plugin directory, no leading slash (the types of Claude Code 2.1.288,
//     `AudioClip`). The files are made by `scripts/make_sounds.py`.
//   - Nothing plays for the first snapshot (a track already waiting or already
//     finished when the session starts), for an unchanged state across ticks, for
//     transitions into `running` or `idle`, or while muted.
//   - Muting (the saved choice or `/conductor-progress-sound`) silences later
//     transitions without queuing them: unmuting never replays a missed one.
//   - A sound that cannot play never breaks the refresh loop or the next redraw.
import { expect, test } from 'claude-code/testing'
import * as fx from './fixtures.ts'
import {
  arrange,
  COMMAND_SOUND,
  draw,
  finished,
  needsInput,
  publish,
  REFRESH_MS,
  REPLIES,
  running,
  startSession,
  STORE_MUTED,
  textOf,
  worldOf,
} from './module-helpers.ts'

const ID = 'login_20260101'
const OTHER = 'search_20260102'

/** The clip each sound plays: a file of the plugin, addressed relative to its root. */
const NEEDS_INPUT_CLIP = { asset: 'sounds/needs_input.wav' }
const DONE_CLIP = { asset: 'sounds/done.wav' }

// `arrange` stubs `audio.play` already; this drops its handler so the scenario can
// register one that records the calls (the kit refuses two handlers for one call).
const without = (on: any, skipped: string) => (event: any, ...rest: any[]) =>
  event === skipped ? undefined : on(event, ...rest)

/** Registers an `audio.play` stub that records every clip played, in order. */
function recordPlays(on: any, reply: () => any = () => ({ value: undefined })): any[] {
  const plays: any[] = []
  on('audio.play', ($: any, e: any) => {
    plays.push(e.clip)
    return reply()
  })
  return plays
}

/** A track with tasks left and none in progress (between two tasks). */
function idleTrack(id = ID, title = 'Login flow') {
  return fx.statusObject(
    { id, description: title, status: 'in_progress' },
    [fx.phase(1, 'Phase 1: Setup', { completed: 2 }, 'abc1234'), fx.phase(2, 'Phase 2: Parser', { completed: 1, pending: 1 })],
    null,
    fx.taskView(4, 'Task: Wire the parser', 'pending', 'Phase 2: Parser', 2),
  )
}

// --- Playing on the two transitions ----------------------------------------------------

test('a track that starts needing input plays the needs-input sound once', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([NEEDS_INPUT_CLIP])
})

test('a track that becomes done plays the done sound once', async ($, on) => {
  const w = worldOf(needsInput(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([DONE_CLIP])
})

test('the whole story plays each sound once: running, needs input, done', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.advance(REFRESH_MS)
  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([NEEDS_INPUT_CLIP, DONE_CLIP])
})

test('the sound plays after a tool call as well as on the timer', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w, { onToolCall: () => publish(w, needsInput(ID)) })
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  // Past the refresh interval guard, but before the timer's next tick
  await h.clock.advance(REFRESH_MS - 500)
  await $.tool.call({ tool: 'Edit', file_path: 'conductor/tracks/' + ID + '/plan.md' })
  await h.clock.settle()

  expect(plays).toEqual([NEEDS_INPUT_CLIP])
})

test('two tracks that change together each play their own sound', async ($, on) => {
  const w = worldOf(running(ID), running(OTHER, 'Search', 'Index the files'))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, needsInput(ID), finished(OTHER, 'Search'))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays.length).toBe(2)
  expect(plays).toContainEqual(NEEDS_INPUT_CLIP)
  expect(plays).toContainEqual(DONE_CLIP)
})

// --- Silence ----------------------------------------------------------------------------

test('a track already waiting at session start plays nothing', async ($, on) => {
  const w = worldOf(needsInput(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)

  await startSession($)
  await draw($)
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([])
})

test('a track already finished at session start plays nothing', async ($, on) => {
  const w = worldOf(finished(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)

  await startSession($)
  await draw($)
  await h.clock.advance(REFRESH_MS * 2)
  await h.clock.settle()

  expect(plays).toEqual([])
})

test('a state that stays the same across several ticks plays nothing more', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)
  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays.length).toBe(1)

  await h.clock.advance(REFRESH_MS * 4)
  await h.clock.settle()

  expect(plays.length).toBe(1)
})

test('moving to running or idle plays nothing', async ($, on) => {
  const w = worldOf(needsInput(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  // The user confirmed: the next task starts, then the track pauses between tasks
  publish(w, running(ID))
  await h.clock.advance(REFRESH_MS)
  publish(w, idleTrack(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([])
})

test('a track that is new to the registry plays nothing, even if it is already waiting', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, running(ID), needsInput(OTHER, 'Search'))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([])
})

// --- Muting --------------------------------------------------------------------------------

test('a muted choice saved by an earlier session silences the transitions', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w, { store: { [STORE_MUTED]: true } })
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([])
})

test('/conductor-progress-sound mutes mid-session, and unmuting re-enables later transitions', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on)
  await startSession($)
  await draw($)

  const muted = await $.command.run({ command: COMMAND_SOUND, args: '' })
  expect(muted.text).toBe(REPLIES.muted)
  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays).toEqual([])

  // Unmuting does not replay what was missed; the next transition plays
  const unmuted = await $.command.run({ command: COMMAND_SOUND, args: '' })
  expect(unmuted.text).toBe(REPLIES.unmuted)
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays).toEqual([])

  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays).toEqual([DONE_CLIP])
})

test('a sound muted for one transition still lets the bar turn done', async ($, on) => {
  const w = worldOf(needsInput(ID))
  const h = arrange(without(on, 'audio.play'), w, { store: { [STORE_MUTED]: true } })
  const plays = recordPlays(on)
  await startSession($)
  const ui = await draw($)

  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()

  expect(plays).toEqual([])
  expect(await textOf(ui, /done/i)).toBeDefined()
})

// --- A sound that cannot play ----------------------------------------------------------------

test('a failing audio.play never breaks the refresh loop or the next redraw', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w)
  const plays = recordPlays(on, () => ({ deny: 'no audio player' }))
  await startSession($)
  const ui = await draw($)

  publish(w, needsInput(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays).toEqual([NEEDS_INPUT_CLIP])
  expect(await textOf(ui, /needs input/i)).toBeDefined()

  // The loop is alive: the next change is still read and drawn, and its sound tried
  publish(w, finished(ID))
  await h.clock.advance(REFRESH_MS)
  await h.clock.settle()
  expect(plays).toEqual([NEEDS_INPUT_CLIP, DONE_CLIP])
  expect(await textOf(ui, /done/i)).toBeDefined()
  expect(h.toasts).toEqual([])
})

test('a failing audio.play does not stop a tool call from refreshing the bars', async ($, on) => {
  const w = worldOf(running(ID))
  const h = arrange(without(on, 'audio.play'), w, { onToolCall: () => publish(w, needsInput(ID)) })
  recordPlays(on, () => ({ deny: 'no audio player' }))
  await startSession($)
  const ui = await draw($)

  await h.clock.advance(REFRESH_MS - 500)
  const result = await $.tool.call({ tool: 'Edit', file_path: 'conductor/tracks/' + ID + '/plan.md' })
  await h.clock.settle()

  expect(result).toBeDefined()
  expect(await textOf(ui, /needs input/i)).toBeDefined()
})
