// Extra edge-case tests for the plan-to-bar model: branches the contract tests
// (model-*.test.ts) do not reach. Kept in its own file so the contract files
// stay untouched. All functions come from hooks/model.ts and are pure.
import { expect, test } from 'claude-code/testing'
import { barFromEntry, buildBar, deriveState, detectSounds, dismiss, isDismissed, parseStatus, parseTracks, selectRows } from '../../hooks/model.ts'
import * as fx from './fixtures.ts'

const parse = (value: unknown) => parseStatus(fx.stdout(value))!
const base = { ok: true, track: { id: 'a', description: 'A', status: 'in_progress' } }
const degraded = (extra: object) => parseStatus(JSON.stringify({ ...base, ...extra }))!

test('parse functions survive a non-string argument', () => {
  expect(parseStatus(undefined as any)).toBeNull()
  expect(parseTracks(undefined as any)).toEqual([])
  expect(parseTracks(null as any)).toEqual([])
})

test('parseStatus numbers phases by position when the number is missing and skips non-objects', () => {
  const status = degraded({ phases: [null, { title: 'Second' }, 'x', { title: 'Third' }] })
  expect(status.phases.map((p) => p.number)).toEqual([2, 4])
})

test('parseStatus ignores wrongly typed fields', () => {
  const status = degraded({
    phases: 'nope',
    tasks: { total: 'many', completed: NaN },
    current_task: 'text',
    next_task: 7,
    complete: 'yes',
  })
  expect(status.phases).toEqual([])
  expect(status.tasks.total).toBe(0)
  expect(status.current_task).toBeNull()
  expect(status.next_task).toBeNull()
  expect(status.complete).toBe(false)
})

test('deriveState: the complete flag alone means done', () => {
  expect(deriveState(degraded({ complete: true }))).toBe('done')
})

test('deriveState: a task counted in progress without a current task view is running', () => {
  expect(deriveState(degraded({ tasks: { total: 3, completed: 0, in_progress: 1, pending: 2 } }))).toBe('running')
})

test('buildBar: no capsule is active on a done track even if a next task is named', () => {
  const bar = buildBar(parse(fx.registryCompleted))
  expect(bar.phases.map((p) => p.state)).toEqual(['pending'])
  expect(bar.pill).toBeNull()
})

test('buildBar: capsules match the active phase by title when the task has no phase number', () => {
  const bar = buildBar(degraded({
    phases: [fx.phase(1, 'Phase 1: A', { completed: 1 }), fx.phase(2, 'Phase 2: B', { in_progress: 1 })],
    tasks: { total: 2, completed: 1, in_progress: 1, pending: 0 },
    current_task: { text: 'Task: x', phase: 'Phase 2: B', status: 'in_progress' },
  }))
  expect(bar.phases.map((p) => p.state)).toEqual(['done', 'active'])
  expect(bar.dots[1].title).toBe('Task: x')
})

test('buildBar: only the current task phase titles its in-progress dot', () => {
  const bar = buildBar(parse(fx.statusObject(
    { id: 'two', description: 'Two', status: 'in_progress' },
    [fx.phase(1, 'Phase 1', { in_progress: 1 }), fx.phase(2, 'Phase 2', { in_progress: 1 })],
    fx.taskView(2, 'Task: B', 'in_progress', 'Phase 2', 2),
    null,
  )))
  expect(bar.dots.map((d) => d.title)).toEqual([null, 'Task: B'])
})

test('buildBar: the pill is only the task text when the phase title is missing', () => {
  const bar = buildBar(degraded({ current_task: { text: 'Task: lone', status: 'in_progress' } }))
  expect(bar.pill).toEqual({ kind: 'current', phase: '', task: 'lone', text: 'lone' })
})

test('barFromEntry: falls back to the id and a completed track with no progress is 100%', () => {
  const [entry] = parseTracks(JSON.stringify({ tracks: [{ id: 'x', status: 'completed' }] }))
  expect(barFromEntry(entry)).toMatchObject({ title: 'x', state: 'done', percent: 100 })
})

test('isDismissed ignores inherited property names', () => {
  const bar = { id: 'toString', state: 'idle', currentTask: null } as any
  expect(isDismissed({}, bar)).toBe(false)
  expect(isDismissed(dismiss({}, bar), bar)).toBe(true)
})

test('selectRows: a completed track not in finished stays hidden and a finished one is cut with the rest', () => {
  const bar = (id: string, status: string) => ({ id, status, state: 'idle', currentTask: null }) as any
  const bars = [bar('a', 'in_progress'), bar('b', 'in_progress'), bar('c', 'completed'), bar('d', 'completed')]
  const { rows, more } = selectRows(bars, { finished: ['d'] }, 2)
  expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  expect(more).toBe(1)
})

test('detectSounds: empty bars give empty results', () => {
  expect(detectSounds(null, [])).toEqual({ events: [], next: {} })
  expect(detectSounds({ a: 'running' }, [])).toEqual({ events: [], next: {} })
})
