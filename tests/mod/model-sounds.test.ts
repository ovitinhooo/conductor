// Contract tests for the bar model: sound triggers.
//
// INTERFACE (exported from hooks/model.ts, pure, never touching `$`):
//
//   detectSounds(previous: StateMap | null, bars: TrackBar[], muted?: boolean):
//     { events: SoundEvent[], next: StateMap }
//     StateMap   = Record<string, TrackState>   track id -> state last seen
//     SoundEvent = { track: string, sound: 'needs_input' | 'done' }
//
//   The caller keeps `next` and passes it back as `previous` on the following
//   snapshot, so each transition is reported exactly once:
//     - `previous` null is the first snapshot (initial load): no events, even
//       for a track that is already needs_input or done
//     - a track unseen in a later snapshot counts as a first sight: no event
//     - an event is emitted when a track moves INTO needs_input or INTO done
//       from any other state, one event per track and snapshot, in bar order
//     - staying in the same state, or moving to running/idle, emits nothing
//     - `muted` true emits nothing, but `next` still advances, so unmuting
//       later does not replay old transitions
import { expect, test } from 'claude-code/testing'
import { detectSounds } from '../../hooks/model.ts'

// detectSounds reads only id and state
const bar = (id: string, state: string) => ({ id, state }) as any

test('the first snapshot emits no events, even for finished or waiting tracks', () => {
  const { events, next } = detectSounds(null, [bar('a', 'done'), bar('b', 'needs_input'), bar('c', 'running')])
  expect(events).toEqual([])
  expect(next).toEqual({ a: 'done', b: 'needs_input', c: 'running' })
})

test('running -> needs_input emits one needs_input event', () => {
  const { events } = detectSounds({ a: 'running' }, [bar('a', 'needs_input')])
  expect(events).toEqual([{ track: 'a', sound: 'needs_input' }])
})

test('running -> done emits one done event', () => {
  const { events } = detectSounds({ a: 'running' }, [bar('a', 'done')])
  expect(events).toEqual([{ track: 'a', sound: 'done' }])
})

test('needs_input -> done emits a done event', () => {
  const { events } = detectSounds({ a: 'needs_input' }, [bar('a', 'done')])
  expect(events).toEqual([{ track: 'a', sound: 'done' }])
})

test('idle -> needs_input and idle -> done also emit', () => {
  expect(detectSounds({ a: 'idle' }, [bar('a', 'needs_input')]).events).toEqual([
    { track: 'a', sound: 'needs_input' },
  ])
  expect(detectSounds({ a: 'idle' }, [bar('a', 'done')]).events).toEqual([{ track: 'a', sound: 'done' }])
})

test('a reopened finished track that waits for input again emits needs_input', () => {
  const { events } = detectSounds({ a: 'done' }, [bar('a', 'needs_input')])
  expect(events).toEqual([{ track: 'a', sound: 'needs_input' }])
})

test('staying in the same state emits nothing', () => {
  for (const state of ['running', 'needs_input', 'done', 'idle']) {
    expect(detectSounds({ a: state as any }, [bar('a', state)]).events).toEqual([])
  }
})

test('leaving needs_input for running or idle emits nothing', () => {
  expect(detectSounds({ a: 'needs_input' }, [bar('a', 'running')]).events).toEqual([])
  expect(detectSounds({ a: 'needs_input' }, [bar('a', 'idle')]).events).toEqual([])
})

test('moving to running or idle emits nothing', () => {
  expect(detectSounds({ a: 'idle' }, [bar('a', 'running')]).events).toEqual([])
  expect(detectSounds({ a: 'running' }, [bar('a', 'idle')]).events).toEqual([])
  expect(detectSounds({ a: 'done' }, [bar('a', 'running')]).events).toEqual([])
})

test('a transition is reported once: feeding next back in stays quiet', () => {
  const first = detectSounds({ a: 'running' }, [bar('a', 'needs_input')])
  expect(first.events.length).toBe(1)
  const second = detectSounds(first.next, [bar('a', 'needs_input')])
  expect(second.events).toEqual([])
  const third = detectSounds(second.next, [bar('a', 'needs_input')])
  expect(third.events).toEqual([])
})

test('the whole life cycle sounds exactly twice', () => {
  let state = detectSounds(null, [bar('a', 'idle')])
  const heard: string[] = []
  for (const s of ['running', 'running', 'needs_input', 'needs_input', 'running', 'done', 'done']) {
    state = detectSounds(state.next, [bar('a', s)])
    heard.push(...state.events.map((e) => e.sound))
  }
  // running -> needs_input, then running -> done
  expect(heard).toEqual(['needs_input', 'done'])
})

test('a track first seen after the initial snapshot emits nothing', () => {
  const { events, next } = detectSounds({ a: 'running' }, [bar('a', 'running'), bar('b', 'done')])
  expect(events).toEqual([])
  expect(next).toEqual({ a: 'running', b: 'done' })
})

test('several tracks transitioning together emit one event each, in bar order', () => {
  const { events } = detectSounds(
    { a: 'running', b: 'running', c: 'running' },
    [bar('a', 'done'), bar('b', 'running'), bar('c', 'needs_input')],
  )
  expect(events).toEqual([
    { track: 'a', sound: 'done' },
    { track: 'c', sound: 'needs_input' },
  ])
})

test('muted emits nothing but still advances the state', () => {
  const muted = detectSounds({ a: 'running' }, [bar('a', 'needs_input')], true)
  expect(muted.events).toEqual([])
  expect(muted.next).toEqual({ a: 'needs_input' })
  // Unmuting later does not replay the transition that happened while muted
  expect(detectSounds(muted.next, [bar('a', 'needs_input')], false).events).toEqual([])
})

test('a null previous snapshot while muted is still silent and records the state', () => {
  const { events, next } = detectSounds(null, [bar('a', 'done')], true)
  expect(events).toEqual([])
  expect(next).toEqual({ a: 'done' })
})

test('detectSounds does not mutate the previous snapshot', () => {
  const previous = { a: 'running' as const }
  detectSounds(previous, [bar('a', 'done')])
  expect(previous).toEqual({ a: 'running' })
})

test('tracks that disappear from the bars drop out of the next snapshot', () => {
  const { next } = detectSounds({ a: 'running', gone: 'done' }, [bar('a', 'running')])
  expect(next).toEqual({ a: 'running' })
})
