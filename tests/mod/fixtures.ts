// Shared fixtures for the plan-to-bar model tests (not a test file itself).
//
// The shapes copy the real JSON printed by `scripts/conductor_state.py`:
//   - `status --track <id>`: { ok, track, phases[], tasks, current_task,
//     next_task, complete }   (cmd_status + summarize_plan)
//   - `tracks` / `status`:   { ok, registry, tracks[], counts, active_track,
//     active_plan? }         (cmd_tracks + cmd_status)
// Counts (`total/completed/in_progress/pending/percent`) follow `_counts` and
// task views follow `_task_view`. The first scenario below is real output
// captured from this project's own track while task 4 was in progress.

type Counts = { completed?: number, in_progress?: number, pending?: number }

// A plan phase as `summarize_plan` prints it
export function phase(number: number, title: string, counts: Counts, checkpoint: string | null = null) {
  const completed = counts.completed ?? 0
  const in_progress = counts.in_progress ?? 0
  const pending = counts.pending ?? 0
  const total = completed + in_progress + pending
  return {
    number,
    title,
    checkpoint,
    total,
    completed,
    in_progress,
    pending,
    percent: total ? Math.round(1000 * completed / total) / 10 : 0.0,
  }
}

// A current_task / next_task view as `_task_view` prints it
export function taskView(
  index: number,
  text: string,
  status: 'in_progress' | 'pending' | 'completed',
  phaseTitle: string,
  phaseNumber: number,
  extra: { sha?: string | null, verification?: boolean, subtasks?: any[] } = {},
) {
  return {
    index,
    text,
    status,
    sha: extra.sha ?? null,
    phase: phaseTitle,
    phase_number: phaseNumber,
    is_phase_verification: extra.verification ?? false,
    subtasks: extra.subtasks ?? [],
  }
}

// Sums phase counts into the plan-wide `tasks` block
function sumTasks(phases: any[]) {
  const total = phases.reduce((n, p) => n + p.total, 0)
  const completed = phases.reduce((n, p) => n + p.completed, 0)
  return {
    total,
    completed,
    in_progress: phases.reduce((n, p) => n + p.in_progress, 0),
    pending: phases.reduce((n, p) => n + p.pending, 0),
    percent: total ? Math.round(1000 * completed / total) / 10 : 0.0,
  }
}

// The parsed object `status --track <id>` prints
export function statusObject(
  track: { id: string, description: string, status: string },
  phases: any[],
  current: any,
  next: any,
) {
  const tasks = sumTasks(phases)
  return {
    ok: true,
    track,
    phases,
    tasks,
    current_task: current,
    next_task: next,
    complete: tasks.total > 0 && tasks.completed === tasks.total,
  }
}

// The raw stdout string of the state script
export const stdout = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

const P1 = 'Phase 1: Spike and Scaffolding'
const P2 = 'Phase 2: Progress Model (pure logic)'
const P3 = 'Phase 3: Module Rendering, Controls and Sounds'
const P4 = 'Phase 4: Plugin, Lint and CI Integration'
const P5 = 'Phase 5: Documentation and Live Verification'

export const TRACK_ID = 'progress_mod_20261002'
export const TRACK_TITLE =
  'Conductor progress mod: live track progress bars, footer button, commands and sounds in the Claude Code UI'

// Real capture: 22 tasks, 3 done, task 4 in progress (running)
export const running = statusObject(
  { id: TRACK_ID, description: TRACK_TITLE, status: 'in_progress' },
  [
    phase(1, P1, { completed: 3 }, 'd5f65c5'),
    phase(2, P2, { in_progress: 1, pending: 3 }),
    phase(3, P3, { pending: 5 }),
    phase(4, P4, { pending: 6 }),
    phase(5, P5, { pending: 4 }),
  ],
  taskView(4, 'Task: Write failing tests for the plan-to-bar model', 'in_progress', P2, 2, {
    subtasks: [
      { text: 'State derivation', status: 'pending' },
      { text: 'Fail-soft input', status: 'pending' },
    ],
  }),
  taskView(5, 'Task: Implement the model to pass the tests', 'pending', P2, 2),
)

// Waiting for the user: the in-progress task is the phase verification task
export const needsInput = statusObject(
  { id: TRACK_ID, description: TRACK_TITLE, status: 'in_progress' },
  [
    phase(1, P1, { completed: 3 }, 'd5f65c5'),
    phase(2, P2, { completed: 3, in_progress: 1 }),
    phase(3, P3, { pending: 5 }),
  ],
  taskView(8, 'Task: Phase Verification & Checkpoint (Refer to workflow.md)', 'in_progress', P2, 2, {
    verification: true,
  }),
  taskView(9, 'Task: Write failing `claude plugin test` scenarios for the module', 'pending', P3, 3),
)

// Everything complete, still listed `in_progress` in the registry (status not flipped yet)
export const allDone = statusObject(
  { id: TRACK_ID, description: TRACK_TITLE, status: 'in_progress' },
  [
    phase(1, P1, { completed: 3 }, 'd5f65c5'),
    phase(2, P2, { completed: 4 }, 'a1b2c3d'),
  ],
  null,
  null,
)

// Tasks exist and none is in progress (between two tasks)
export const idle = statusObject(
  { id: TRACK_ID, description: TRACK_TITLE, status: 'in_progress' },
  [
    phase(1, P1, { completed: 3 }, 'd5f65c5'),
    phase(2, P2, { completed: 2, pending: 2 }),
  ],
  null,
  taskView(6, 'Task: Write failing tests for the state-script client', 'pending', P2, 2),
)

// A track that was registered but never started: status `pending`
export const pendingTrack = statusObject(
  { id: 'next_feature_20261003', description: 'Next feature', status: 'pending' },
  [phase(1, 'Phase 1: Setup', { pending: 3 })],
  null,
  taskView(1, 'Task: Create the skeleton', 'pending', 'Phase 1: Setup', 1),
)

// Registry says `completed` while a task is still unticked in plan.md
export const registryCompleted = statusObject(
  { id: 'old_feature_20260901', description: 'Old feature', status: 'completed' },
  [phase(1, 'Phase 1: Setup', { completed: 2, pending: 1 }, 'beefcaf')],
  null,
  taskView(3, 'Task: Forgotten leftover', 'pending', 'Phase 1: Setup', 1),
)

// Three tasks, one done (33.3%) and two done (66.7%): rounding checks
export const oneOfThree = statusObject(
  { id: 'thirds', description: 'Thirds', status: 'in_progress' },
  [phase(1, 'Phase 1: Only', { completed: 1, in_progress: 1, pending: 1 })],
  taskView(2, 'Task: Second', 'in_progress', 'Phase 1: Only', 1),
  taskView(3, 'Task: Third', 'pending', 'Phase 1: Only', 1),
)
export const twoOfThree = statusObject(
  { id: 'thirds', description: 'Thirds', status: 'in_progress' },
  [phase(1, 'Phase 1: Only', { completed: 2, pending: 1 })],
  null,
  taskView(3, 'Task: Third', 'pending', 'Phase 1: Only', 1),
)

// One registry row as `tracks` prints it (progress is null when there is no plan)
export function trackEntry(
  id: string,
  status: string,
  progress: { total: number, completed: number, in_progress: number, pending: number, percent: number } | null,
  extra: { exists?: boolean, description?: string } = {},
) {
  return {
    id,
    description: extra.description ?? 'Track ' + id,
    status,
    path: 'conductor/tracks/' + id,
    exists: extra.exists ?? progress !== null,
    progress,
  }
}

// The parsed object `tracks` prints
export function tracksObject(tracks: any[]) {
  return { ok: true, registry: 'conductor/tracks.md', tracks }
}

// The parsed object `status` (no --track) prints; active_plan is omitted on purpose
export function overviewObject(tracks: any[]) {
  const statuses = tracks.map((t) => t.status)
  const count = (s: string) => statuses.filter((x) => x === s).length
  const active = tracks.find((t) => t.status === 'in_progress') ?? tracks.find((t) => t.status === 'pending') ?? null
  return {
    ok: true,
    registry: 'conductor/tracks.md',
    tracks,
    counts: {
      total: tracks.length,
      completed: count('completed'),
      in_progress: count('in_progress'),
      pending: count('pending'),
    },
    active_track: active,
  }
}
