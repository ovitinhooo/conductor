// Contract tests for the plan-to-bar model: parsing, state derivation and the
// per-track bar (percent, phase capsules, task dots, pill).
//
// INTERFACE (all exported from hooks/model.ts, pure, never touching `$`):
//
//   type TrackState = 'running' | 'needs_input' | 'done' | 'idle'
//
//   parseStatus(stdout: string): TrackStatus | null
//     Parses the raw stdout of `conductor_state.py status --track <id>`.
//     Returns null for invalid JSON, `ok: false` or a missing track id. Never
//     throws. Missing or null fields become neutral values: phases [], zero
//     counts, current_task/next_task null.
//
//   deriveState(status: TrackStatus): TrackState
//     Precedence: done > needs_input > running > idle.
//       done        registry status is 'completed', or `complete` is true, or
//                   every task is completed (tasks.total > 0)
//       needs_input the current (in-progress) task has is_phase_verification
//       running     a task is in progress
//       idle        anything else (including a `pending` track)
//
//   buildBar(status: TrackStatus): TrackBar
//     TrackBar = {
//       id: string
//       title: string                 track description (the id when empty)
//       status: string                registry status ('in_progress', ...)
//       state: TrackState
//       percent: number               integer 0-100 = round(completed/total*100);
//                                     0 without tasks; 100 when state is 'done'
//       currentTask: string | null    current_task.text (not next_task), used
//                                     by the dismissal signature
//       phases: Capsule[]             one per phase, in plan order
//       dots: Dot[]                   one per top-level task, in plan order
//       pill: Pill | null
//     }
//     Capsule = { number, title, completed, total, state: 'done' | 'active' |
//                 'pending', checkpoint: string | null }
//       done    all tasks of the phase completed (total > 0)
//       active  the phase of current_task, else the phase of next_task
//       pending everything else
//     Dot = { status: 'completed' | 'in_progress' | 'pending', phase: number,
//             title: string | null }
//       The status script prints counts per phase, not a task list, so dots are
//       built per phase as completed, then in_progress, then pending. Only the
//       in-progress dot knows its title (current_task.text).
//     Pill = { kind: 'current' | 'next', phase: string, task: string,
//              text: string }
//       Names the current task, else the next task, else null (done). `phase`
//       is the phase title, `task` the task text without a leading "Task: ",
//       and `text` is `${phase} · ${task}`.
import { expect, test } from 'claude-code/testing'
import { buildBar, deriveState, parseStatus } from '../../hooks/model.ts'
import * as fx from './fixtures.ts'

const parse = (value: unknown) => parseStatus(fx.stdout(value))!

// --- parseStatus ------------------------------------------------------------

test('parseStatus reads the real status --track output', () => {
  const status = parse(fx.running)
  expect(status).not.toBeNull()
  expect(status.track.id).toBe(fx.TRACK_ID)
  expect(status.phases.length).toBe(5)
  expect(status.tasks.total).toBe(22)
  expect(status.current_task.text).toBe('Task: Write failing tests for the plan-to-bar model')
  expect(status.next_task.text).toBe('Task: Implement the model to pass the tests')
})

// --- deriveState ------------------------------------------------------------

test('deriveState: running while a task is in progress', () => {
  expect(deriveState(parse(fx.running))).toBe('running')
})

test('deriveState: needs_input when the in-progress task is a phase verification', () => {
  expect(deriveState(parse(fx.needsInput))).toBe('needs_input')
})

test('deriveState: done when every task is completed', () => {
  expect(deriveState(parse(fx.allDone))).toBe('done')
})

test('deriveState: done when the registry says completed, even with a task left', () => {
  expect(deriveState(parse(fx.registryCompleted))).toBe('done')
})

test('deriveState: idle between tasks (tracks exist, nothing in progress)', () => {
  expect(deriveState(parse(fx.idle))).toBe('idle')
})

test('deriveState: a pending track is idle', () => {
  expect(deriveState(parse(fx.pendingTrack))).toBe('idle')
})

test('deriveState: done wins over needs_input and running', () => {
  // A completed track whose plan still shows an in-progress verification task
  const confused = {
    ...fx.needsInput,
    track: { ...fx.needsInput.track, status: 'completed' },
  }
  expect(deriveState(parse(confused))).toBe('done')
})

test('deriveState: needs_input wins over running', () => {
  // A verification task is itself in progress, so both apply; waiting wins
  const status = parse(fx.needsInput)
  expect(status.tasks.in_progress).toBe(1)
  expect(deriveState(status)).toBe('needs_input')
})

test('deriveState: a pending verification task alone does not need input', () => {
  const pendingVerification = {
    ...fx.idle,
    next_task: fx.taskView(
      8, 'Task: Phase Verification & Checkpoint (Refer to workflow.md)', 'pending',
      'Phase 2: Progress Model (pure logic)', 2, { verification: true },
    ),
  }
  expect(deriveState(parse(pendingVerification))).toBe('idle')
})

test('deriveState: a track without any task is idle', () => {
  const empty = fx.statusObject(
    { id: 'empty', description: 'Empty', status: 'in_progress' }, [], null, null,
  )
  expect(deriveState(parse(empty))).toBe('idle')
})

// --- buildBar: identity, state, percent ------------------------------------

test('buildBar: carries id, title, registry status, state and current task', () => {
  const bar = buildBar(parse(fx.running))
  expect(bar).toMatchObject({
    id: fx.TRACK_ID,
    title: fx.TRACK_TITLE,
    status: 'in_progress',
    state: 'running',
    currentTask: 'Task: Write failing tests for the plan-to-bar model',
  })
})

test('buildBar: currentTask is null when no task is in progress', () => {
  expect(buildBar(parse(fx.idle)).currentTask).toBeNull()
  expect(buildBar(parse(fx.allDone)).currentTask).toBeNull()
})

test('buildBar: percent rounds completed/total to an integer', () => {
  expect(buildBar(parse(fx.running)).percent).toBe(14) // 3 of 22 = 13.6
  expect(buildBar(parse(fx.oneOfThree)).percent).toBe(33) // 33.3
  expect(buildBar(parse(fx.twoOfThree)).percent).toBe(67) // 66.7
})

test('buildBar: percent is 100 when done, even if the registry says completed early', () => {
  expect(buildBar(parse(fx.allDone)).percent).toBe(100)
  expect(buildBar(parse(fx.registryCompleted)).percent).toBe(100)
})

test('buildBar: percent is 0 when nothing is complete or there are no tasks', () => {
  expect(buildBar(parse(fx.pendingTrack)).percent).toBe(0)
  const empty = fx.statusObject(
    { id: 'empty', description: 'Empty', status: 'in_progress' }, [], null, null,
  )
  expect(buildBar(parse(empty)).percent).toBe(0)
})

// --- buildBar: phase capsules ----------------------------------------------

test('buildBar: one capsule per phase with counts, state and checkpoint', () => {
  const { phases } = buildBar(parse(fx.running))
  expect(phases.length).toBe(5)
  expect(phases[0]).toEqual({
    number: 1,
    title: 'Phase 1: Spike and Scaffolding',
    completed: 3,
    total: 3,
    state: 'done',
    checkpoint: 'd5f65c5',
  })
  expect(phases[1]).toEqual({
    number: 2,
    title: 'Phase 2: Progress Model (pure logic)',
    completed: 0,
    total: 4,
    state: 'active',
    checkpoint: null,
  })
  expect(phases.map((p) => p.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending'])
})

test('buildBar: the active capsule follows the next task when none is in progress', () => {
  const { phases } = buildBar(parse(fx.idle))
  expect(phases.map((p) => p.state)).toEqual(['done', 'active'])
})

test('buildBar: no capsule is active on a finished track', () => {
  const { phases } = buildBar(parse(fx.allDone))
  expect(phases.map((p) => p.state)).toEqual(['done', 'done'])
  expect(phases[1].checkpoint).toBe('a1b2c3d')
})

test('buildBar: the active capsule is the first phase of a track that has not started', () => {
  const { phases } = buildBar(parse(fx.pendingTrack))
  expect(phases.map((p) => p.state)).toEqual(['active'])
})

// --- buildBar: task dots ----------------------------------------------------

test('buildBar: one dot per task, filled in plan order', () => {
  const { dots } = buildBar(parse(fx.running))
  expect(dots.length).toBe(22)
  expect(dots.slice(0, 3).map((d) => d.status)).toEqual(['completed', 'completed', 'completed'])
  expect(dots[3].status).toBe('in_progress')
  expect(dots.slice(4).every((d) => d.status === 'pending')).toBe(true)
  expect(dots.filter((d) => d.status === 'completed').length).toBe(3)
})

test('buildBar: dots record their phase number', () => {
  const { dots } = buildBar(parse(fx.running))
  expect(dots.slice(0, 3).map((d) => d.phase)).toEqual([1, 1, 1])
  expect(dots.slice(3, 7).map((d) => d.phase)).toEqual([2, 2, 2, 2])
  expect(dots[dots.length - 1].phase).toBe(5)
})

test('buildBar: dots inside a phase list completed, in-progress, then pending', () => {
  const { dots } = buildBar(parse(fx.needsInput))
  // Phase 2 has 3 completed + 1 in progress; phase 3 has 5 pending
  expect(dots.filter((d) => d.phase === 2).map((d) => d.status)).toEqual([
    'completed', 'completed', 'completed', 'in_progress',
  ])
})

test('buildBar: the in-progress dot carries the current task title', () => {
  const { dots } = buildBar(parse(fx.running))
  expect(dots[3].title).toBe('Task: Write failing tests for the plan-to-bar model')
})

test('buildBar: every dot is completed on a finished track', () => {
  const { dots } = buildBar(parse(fx.allDone))
  expect(dots.length).toBe(7)
  expect(dots.every((d) => d.status === 'completed')).toBe(true)
})

// --- buildBar: pill ---------------------------------------------------------

test('buildBar: the pill names the current phase and task', () => {
  expect(buildBar(parse(fx.running)).pill).toEqual({
    kind: 'current',
    phase: 'Phase 2: Progress Model (pure logic)',
    task: 'Write failing tests for the plan-to-bar model',
    text: 'Phase 2: Progress Model (pure logic) · Write failing tests for the plan-to-bar model',
  })
})

test('buildBar: the pill names the phase verification task while waiting', () => {
  const { pill } = buildBar(parse(fx.needsInput))
  expect(pill.kind).toBe('current')
  expect(pill.task).toBe('Phase Verification & Checkpoint (Refer to workflow.md)')
})

test('buildBar: the pill falls back to the next task when nothing is in progress', () => {
  expect(buildBar(parse(fx.idle)).pill).toMatchObject({
    kind: 'next',
    phase: 'Phase 2: Progress Model (pure logic)',
    task: 'Write failing tests for the state-script client',
  })
  expect(buildBar(parse(fx.pendingTrack)).pill).toMatchObject({
    kind: 'next',
    task: 'Create the skeleton',
  })
})

test('buildBar: the pill is null on a finished track', () => {
  expect(buildBar(parse(fx.allDone)).pill).toBeNull()
})

test('buildBar: the pill is null when there is neither a current nor a next task', () => {
  const empty = fx.statusObject(
    { id: 'empty', description: 'Empty', status: 'in_progress' }, [], null, null,
  )
  expect(buildBar(parse(empty)).pill).toBeNull()
})
