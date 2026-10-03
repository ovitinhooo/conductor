// Contract tests for the bar model: which rows to show, and dismissal.
//
// INTERFACE (all exported from hooks/model.ts, pure, never touching `$`):
//
//   barFromEntry(entry: TrackEntry): TrackBar
//     Fallback bar for a registry row that has no status output (no plan, or
//     the per-track call failed). `entry` is one item of the `tracks` output.
//     Same shape as buildBar, but built from `entry.progress` alone:
//     phases [], dots [], pill null, currentTask null, percent from
//     progress.completed/total (0 when progress is null), and state `done` for
//     a `completed` track, `running` when progress.in_progress > 0, else `idle`.
//     needs_input cannot be derived without the plan.
//
//   selectRows(bars: TrackBar[], ctx?: RowContext, max?: number):
//     { rows: TrackBar[], more: number }
//     RowContext = { dismissals?: Dismissals, finished?: string[] }
//       finished   ids of tracks that turned `done` during this session
//     `bars` are in registry order. Candidate rows, in this order:
//       1. every track whose registry status is 'in_progress'
//       2. when there is none, only the FIRST 'pending' track
//       3. every 'completed' track listed in ctx.finished (a bar that just
//          finished this session; others stay hidden)
//     Dismissed candidates are dropped (a dismissed pending track hides, it is
//     not replaced by the next pending one). Then the list is cut to `max`
//     (default 3) and `more` counts the candidates cut off.
//
//   Dismissals = Record<string, string>   track id -> signature at dismissal
//   barSignature(bar): string             state + current task, e.g.
//                                         'running|Task: X'. Changes when the
//                                         state or the current task changes,
//                                         not when only the percent does.
//   dismiss(dismissals, bar): Dismissals  returns a new object, never mutates
//   isDismissed(dismissals, bar): boolean true while the bar's signature still
//                                         equals the stored one
import { expect, test } from 'claude-code/testing'
import {
  barFromEntry, barSignature, dismiss, isDismissed, selectRows,
} from '../../hooks/model.ts'
import * as fx from './fixtures.ts'

// A minimal bar: selectRows reads id and status, dismissal reads id, state
// and currentTask. Everything else is irrelevant to these tests.
const bar = (id: string, status: string, state = 'idle', currentTask: string | null = null) =>
  ({ id, title: id, status, state, currentTask, percent: 0, phases: [], dots: [], pill: null }) as any

const ids = (rows: any[]) => rows.map((r) => r.id)

// --- selectRows -------------------------------------------------------------

test('selectRows: in-progress tracks come first, in registry order', () => {
  const bars = [bar('a', 'pending'), bar('b', 'in_progress'), bar('c', 'in_progress')]
  const { rows, more } = selectRows(bars)
  expect(ids(rows)).toEqual(['b', 'c'])
  expect(more).toBe(0)
})

test('selectRows: without an in-progress track only the first pending one shows', () => {
  const bars = [bar('done', 'completed'), bar('p1', 'pending'), bar('p2', 'pending')]
  const { rows, more } = selectRows(bars)
  expect(ids(rows)).toEqual(['p1'])
  expect(more).toBe(0)
})

test('selectRows: pending tracks are ignored while one is in progress', () => {
  const bars = [bar('p1', 'pending'), bar('run', 'in_progress')]
  expect(ids(selectRows(bars).rows)).toEqual(['run'])
})

test('selectRows: at most 3 rows, the rest counted as +N more', () => {
  const bars = ['a', 'b', 'c', 'd', 'e'].map((id) => bar(id, 'in_progress'))
  const { rows, more } = selectRows(bars)
  expect(ids(rows)).toEqual(['a', 'b', 'c'])
  expect(more).toBe(2)
})

test('selectRows: exactly 3 candidates leave no +N more', () => {
  const bars = ['a', 'b', 'c'].map((id) => bar(id, 'in_progress'))
  expect(selectRows(bars).more).toBe(0)
})

test('selectRows: the cut-off is configurable', () => {
  const bars = ['a', 'b', 'c'].map((id) => bar(id, 'in_progress'))
  const { rows, more } = selectRows(bars, {}, 1)
  expect(ids(rows)).toEqual(['a'])
  expect(more).toBe(2)
})

test('selectRows: completed tracks stay hidden unless they just finished', () => {
  const bars = [bar('old', 'completed'), bar('run', 'in_progress')]
  expect(ids(selectRows(bars).rows)).toEqual(['run'])
  expect(ids(selectRows(bars, { finished: [] }).rows)).toEqual(['run'])
})

test('selectRows: a track that finished this session shows after the active ones', () => {
  const bars = [bar('new', 'completed', 'done'), bar('run', 'in_progress')]
  expect(ids(selectRows(bars, { finished: ['new'] }).rows)).toEqual(['run', 'new'])
})

test('selectRows: a finished track shows alone when nothing else is active', () => {
  const bars = [bar('new', 'completed', 'done')]
  expect(ids(selectRows(bars, { finished: ['new'] }).rows)).toEqual(['new'])
})

test('selectRows: a finished track and the next pending one both show', () => {
  const bars = [bar('new', 'completed', 'done'), bar('next', 'pending')]
  expect(ids(selectRows(bars, { finished: ['new'] }).rows)).toEqual(['next', 'new'])
})

test('selectRows: dismissed bars are dropped and do not count as more', () => {
  const bars = ['a', 'b', 'c', 'd'].map((id) => bar(id, 'in_progress', 'running', 'Task: ' + id))
  const dismissals = dismiss({}, bars[0])
  const { rows, more } = selectRows(bars, { dismissals })
  expect(ids(rows)).toEqual(['b', 'c', 'd'])
  expect(more).toBe(0)
})

test('selectRows: a dismissed pending track hides instead of promoting the next pending one', () => {
  const bars = [bar('p1', 'pending'), bar('p2', 'pending')]
  const dismissals = dismiss({}, bars[0])
  expect(selectRows(bars, { dismissals }).rows).toEqual([])
})

test('selectRows: a dismissed finished track stays hidden', () => {
  const bars = [bar('new', 'completed', 'done')]
  const dismissals = dismiss({}, bars[0])
  expect(selectRows(bars, { finished: ['new'], dismissals }).rows).toEqual([])
})

test('selectRows: no tracks, no rows', () => {
  expect(selectRows([])).toEqual({ rows: [], more: 0 })
})

// --- dismissal --------------------------------------------------------------

test('dismiss hides the bar while nothing changes', () => {
  const b = bar('a', 'in_progress', 'running', 'Task: one')
  const dismissals = dismiss({}, b)
  expect(isDismissed(dismissals, b)).toBe(true)
})

test('an undismissed bar is not dismissed', () => {
  expect(isDismissed({}, bar('a', 'in_progress', 'running', 'Task: one'))).toBe(false)
})

test('dismissing one track leaves the others visible', () => {
  const a = bar('a', 'in_progress', 'running', 'Task: one')
  const b = bar('b', 'in_progress', 'running', 'Task: one')
  const dismissals = dismiss({}, a)
  expect(isDismissed(dismissals, b)).toBe(false)
})

test('a dismissed bar returns when its state changes', () => {
  const running = bar('a', 'in_progress', 'running', 'Task: one')
  const dismissals = dismiss({}, running)
  const waiting = bar('a', 'in_progress', 'needs_input', 'Task: one')
  const finished = bar('a', 'completed', 'done', null)
  expect(isDismissed(dismissals, waiting)).toBe(false)
  expect(isDismissed(dismissals, finished)).toBe(false)
})

test('a dismissed bar returns when its current task changes', () => {
  const dismissals = dismiss({}, bar('a', 'in_progress', 'running', 'Task: one'))
  expect(isDismissed(dismissals, bar('a', 'in_progress', 'running', 'Task: two'))).toBe(false)
})

test('a dismissed bar stays hidden when only its percent changes', () => {
  const before = { ...bar('a', 'in_progress', 'running', 'Task: one'), percent: 10 }
  const after = { ...before, percent: 12 }
  expect(isDismissed(dismiss({}, before), after)).toBe(true)
})

test('a dismissed bar that comes back and is closed again stays closed', () => {
  const first = bar('a', 'in_progress', 'running', 'Task: one')
  const second = bar('a', 'in_progress', 'running', 'Task: two')
  const dismissals = dismiss(dismiss({}, first), second)
  expect(isDismissed(dismissals, second)).toBe(true)
  expect(isDismissed(dismissals, first)).toBe(false)
})

test('dismiss returns a new object and never mutates its input', () => {
  const before = {}
  const after = dismiss(before, bar('a', 'in_progress', 'running', 'Task: one'))
  expect(before).toEqual({})
  expect(Object.keys(after)).toEqual(['a'])
})

test('barSignature differs by state and by current task only', () => {
  const base = bar('a', 'in_progress', 'running', 'Task: one')
  expect(barSignature(base)).toBe(barSignature({ ...base, percent: 50 }))
  expect(barSignature(base)).not.toBe(barSignature(bar('a', 'in_progress', 'needs_input', 'Task: one')))
  expect(barSignature(base)).not.toBe(barSignature(bar('a', 'in_progress', 'running', 'Task: two')))
  expect(barSignature(base)).toMatch(/Task: one/)
})

// --- barFromEntry (track without a plan or without status output) -----------

test('barFromEntry: builds a bar from the tracks overview alone', () => {
  const entry = fx.trackEntry('t1', 'in_progress', { total: 4, completed: 1, in_progress: 1, pending: 2, percent: 25 }, {
    description: 'Track one',
  })
  expect(barFromEntry(entry)).toMatchObject({
    id: 't1',
    title: 'Track one',
    status: 'in_progress',
    state: 'running',
    percent: 25,
    currentTask: null,
    phases: [],
    dots: [],
    pill: null,
  })
})

test('barFromEntry: idle when no task is in progress, done when completed', () => {
  const idle = fx.trackEntry('t1', 'pending', { total: 2, completed: 0, in_progress: 0, pending: 2, percent: 0 })
  const done = fx.trackEntry('t2', 'completed', { total: 2, completed: 2, in_progress: 0, pending: 0, percent: 100 })
  expect(barFromEntry(idle).state).toBe('idle')
  expect(barFromEntry(done)).toMatchObject({ state: 'done', percent: 100 })
})

test('barFromEntry: a track with no plan gets an empty idle bar', () => {
  const entry = fx.trackEntry('t1', 'in_progress', null, { exists: false })
  expect(barFromEntry(entry)).toMatchObject({ id: 't1', state: 'idle', percent: 0, phases: [], dots: [], pill: null })
})
