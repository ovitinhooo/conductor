// Contract tests for the bar model: fail-soft input. The state script can be
// missing, print garbage, or report an error, and the host must never see a
// throw. Neutral results are an empty list or null, never an exception.
//
// INTERFACE (exported from hooks/model.ts, pure, never touching `$`):
//
//   parseTracks(stdout: string): TrackEntry[]
//     Parses the raw stdout of `conductor_state.py tracks` (or of `status`
//     without --track, which carries the same `tracks` array). Returns [] for
//     invalid JSON, `ok: false`, a missing or non-array `tracks`, or an empty
//     list. Items that are not objects or have no string `id` are skipped.
//     A TrackEntry is { id, description, status, path, exists, progress }
//     with progress = { total, completed, in_progress, pending, percent } or
//     null. Missing fields become '' / false / null (status ''), so one broken
//     row never hides the others.
//
//   parseStatus(stdout: string): TrackStatus | null     (see model-bar.test.ts)
//   buildBar(status): TrackBar                          (see model-bar.test.ts)
//   selectRows([]) / detectSounds(null, []) work on empty input.
import { expect, test } from 'claude-code/testing'
import { buildBar, deriveState, parseStatus, parseTracks, selectRows } from '../../hooks/model.ts'
import * as fx from './fixtures.ts'

const progress = { total: 4, completed: 1, in_progress: 1, pending: 2, percent: 25 }

// --- parseTracks ------------------------------------------------------------

test('parseTracks reads the tracks output', () => {
  const entries = parseTracks(fx.stdout(fx.tracksObject([
    fx.trackEntry('a', 'in_progress', progress, { description: 'Track A' }),
    fx.trackEntry('b', 'pending', null, { description: 'Track B', exists: false }),
  ])))
  expect(entries.length).toBe(2)
  expect(entries[0]).toEqual({
    id: 'a',
    description: 'Track A',
    status: 'in_progress',
    path: 'conductor/tracks/a',
    exists: true,
    progress,
  })
  expect(entries[1]).toMatchObject({ id: 'b', status: 'pending', exists: false, progress: null })
})

test('parseTracks also reads the overview printed by status without --track', () => {
  const entries = parseTracks(fx.stdout(fx.overviewObject([
    fx.trackEntry('a', 'in_progress', progress),
    fx.trackEntry('b', 'completed', progress),
  ])))
  expect(entries.map((e) => e.id)).toEqual(['a', 'b'])
})

test('parseTracks returns [] for an empty registry', () => {
  expect(parseTracks(fx.stdout(fx.tracksObject([])))).toEqual([])
})

test('parseTracks returns [] for invalid or empty output', () => {
  for (const raw of ['', '   ', 'not json', '{', 'null', '[]', '42', '"text"', 'Traceback (most recent call last):']) {
    expect(parseTracks(raw)).toEqual([])
  }
})

test('parseTracks returns [] for ok: false and for missing keys', () => {
  expect(parseTracks(JSON.stringify({ ok: false, error: 'boom' }))).toEqual([])
  expect(parseTracks(JSON.stringify({ ok: true }))).toEqual([])
  expect(parseTracks(JSON.stringify({ ok: true, tracks: null }))).toEqual([])
  expect(parseTracks(JSON.stringify({ ok: true, tracks: 'a' }))).toEqual([])
  expect(parseTracks(JSON.stringify({ tracks: [{ id: 'a' }] })).length).toBe(1)
})

test('parseTracks skips broken rows and keeps the good ones', () => {
  const raw = JSON.stringify({
    ok: true,
    tracks: [null, 'x', 7, {}, { id: 3 }, { id: 'good', description: 'Good', status: 'in_progress' }],
  })
  const entries = parseTracks(raw)
  expect(entries.map((e) => e.id)).toEqual(['good'])
})

test('parseTracks fills missing fields with neutral values', () => {
  const [entry] = parseTracks(JSON.stringify({ ok: true, tracks: [{ id: 'a' }] }))
  expect(entry).toEqual({
    id: 'a',
    description: '',
    status: '',
    path: null,
    exists: false,
    progress: null,
  })
})

test('parseTracks treats a null progress and a track without a plan as no progress', () => {
  const [entry] = parseTracks(JSON.stringify({
    ok: true,
    tracks: [{ id: 'a', description: 'A', status: 'pending', path: 'x', exists: true, progress: null }],
  }))
  expect(entry.progress).toBeNull()
})

// --- parseStatus ------------------------------------------------------------

test('parseStatus returns null for invalid or empty output', () => {
  for (const raw of ['', ' ', 'not json', '{', 'null', '[]', '1', 'Traceback (most recent call last):']) {
    expect(parseStatus(raw)).toBeNull()
  }
})

test('parseStatus returns null for the error output of an unknown track', () => {
  const raw = JSON.stringify({ ok: false, error: "No track matches 'nope'. Candidates: []" })
  expect(parseStatus(raw)).toBeNull()
})

test('parseStatus returns null when the track block is missing', () => {
  expect(parseStatus(JSON.stringify({ ok: true }))).toBeNull()
  expect(parseStatus(JSON.stringify({ ok: true, track: null }))).toBeNull()
  expect(parseStatus(JSON.stringify({ ok: true, track: {} }))).toBeNull()
  expect(parseStatus(JSON.stringify({ ok: true, track: { id: 5 } }))).toBeNull()
})

test('parseStatus defaults missing plan fields to neutral values', () => {
  const status = parseStatus(JSON.stringify({ ok: true, track: { id: 'a', description: 'A', status: 'in_progress' } }))!
  expect(status.phases).toEqual([])
  expect(status.tasks).toMatchObject({ total: 0, completed: 0, in_progress: 0, pending: 0 })
  expect(status.current_task).toBeNull()
  expect(status.next_task).toBeNull()
})

test('parseStatus treats null fields like missing ones', () => {
  const status = parseStatus(JSON.stringify({
    ok: true,
    track: { id: 'a', description: null, status: null },
    phases: null,
    tasks: null,
    current_task: null,
    next_task: null,
    complete: null,
  }))!
  expect(status.phases).toEqual([])
  expect(status.tasks.total).toBe(0)
})

// --- buildBar / deriveState on degraded input -------------------------------

const degraded = (extra: object) =>
  parseStatus(JSON.stringify({ ok: true, track: { id: 'a', description: 'A', status: 'in_progress' }, ...extra }))!

test('buildBar never throws on a track with no plan data', () => {
  const bar = buildBar(degraded({}))
  expect(bar).toMatchObject({ id: 'a', title: 'A', state: 'idle', percent: 0, phases: [], dots: [], pill: null, currentTask: null })
})

test('buildBar falls back to the id when the description is missing', () => {
  const status = parseStatus(JSON.stringify({ ok: true, track: { id: 'a_id', status: 'in_progress' } }))!
  expect(buildBar(status).title).toBe('a_id')
})

test('buildBar survives a phase with missing counts and a task view with missing fields', () => {
  const bar = buildBar(degraded({
    phases: [{ number: 1, title: 'Phase 1' }, { title: 'No number' }, null],
    tasks: { total: 2, completed: 1 },
    current_task: { text: 'Task: odd' },
  }))
  expect(bar.phases.length).toBeGreaterThanOrEqual(1)
  expect(bar.phases[0]).toMatchObject({ number: 1, title: 'Phase 1', completed: 0, total: 0, checkpoint: null })
  expect(bar.percent).toBe(50)
  expect(bar.currentTask).toBe('Task: odd')
  expect(['running', 'idle']).toContain(bar.state)
})

test('deriveState treats a current task without is_phase_verification as plain running', () => {
  const status = degraded({
    tasks: { total: 2, completed: 0, in_progress: 1, pending: 1 },
    current_task: { text: 'Task: odd', status: 'in_progress' },
  })
  expect(deriveState(status)).toBe('running')
})

test('a real status output with an empty plan degrades to an empty idle bar', () => {
  const empty = fx.statusObject({ id: 'empty', description: 'Empty', status: 'pending' }, [], null, null)
  expect(buildBar(parseStatus(fx.stdout(empty))!)).toMatchObject({
    state: 'idle', percent: 0, phases: [], dots: [], pill: null,
  })
})

test('empty inputs flow through row selection', () => {
  expect(selectRows(parseTracks('garbage').map(() => ({}) as any))).toEqual({ rows: [], more: 0 })
})
