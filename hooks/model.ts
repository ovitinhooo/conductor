// Conductor progress mod: the plan-to-bar model.
//
// Pure functions only. They take the parsed output of `scripts/conductor_state.py`
// and return plain data that the renderer in register.ts draws. Nothing here
// touches `$`, the engine, the clock or the disk, so every rule can be tested
// without a session. The parse functions never throw: the state script can be
// missing or print garbage, and the host must never see an exception.

// --- Types --------------------------------------------------------------------

export type TrackState = 'running' | 'needs_input' | 'done' | 'idle'
export type TaskStatus = 'completed' | 'in_progress' | 'pending'

/** Task counts as `_counts` prints them. */
export type Counts = {
  total: number
  completed: number
  in_progress: number
  pending: number
  percent: number
}

/** A `current_task` / `next_task` view as `_task_view` prints it. */
export type TaskView = {
  index: number
  text: string
  status: string
  sha: string | null
  phase: string
  phase_number: number | null
  is_phase_verification: boolean
  subtasks: unknown[]
}

/** One plan phase as `summarize_plan` prints it. */
export type PhaseInfo = Counts & {
  number: number
  title: string
  checkpoint: string | null
}

/** The parsed output of `status --track <id>`. */
export type TrackStatus = {
  track: { id: string, description: string, status: string }
  phases: PhaseInfo[]
  tasks: Counts
  current_task: TaskView | null
  next_task: TaskView | null
  complete: boolean
}

/** One registry row as `tracks` prints it. */
export type TrackEntry = {
  id: string
  description: string
  status: string
  path: string | null
  exists: boolean
  progress: Counts | null
}

export type Capsule = {
  number: number
  title: string
  completed: number
  total: number
  state: 'done' | 'active' | 'pending'
  checkpoint: string | null
}

export type Dot = {
  status: TaskStatus
  phase: number
  title: string | null
}

export type Pill = {
  kind: 'current' | 'next'
  phase: string
  task: string
  text: string
}

export type TrackBar = {
  id: string
  title: string
  status: string
  state: TrackState
  percent: number
  currentTask: string | null
  phases: Capsule[]
  dots: Dot[]
  pill: Pill | null
}

/** Track id -> signature of the bar when the user closed it. */
export type Dismissals = Record<string, string>
/** Track id -> state last seen. */
export type StateMap = Record<string, TrackState>
export type SoundEvent = { track: string, sound: 'needs_input' | 'done' }
export type RowContext = { dismissals?: Dismissals, finished?: string[] }

// --- Parsing helpers (loose input in, neutral values out) ------------------------

type Json = Record<string, unknown>

// Narrows an unknown value to a plain object (arrays and null are not objects here)
function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

// Parses a JSON object, or returns null for garbage and for `ok: false`
function parseOk(stdout: string): Json | null {
  if (typeof stdout !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  const object = asObject(value)
  return object && object.ok !== false ? object : null
}

function toCounts(value: unknown): Counts {
  const c = asObject(value) ?? {}
  return {
    total: num(c.total),
    completed: num(c.completed),
    in_progress: num(c.in_progress),
    pending: num(c.pending),
    percent: num(c.percent),
  }
}

function toPhase(value: unknown, index: number): PhaseInfo | null {
  const p = asObject(value)
  if (!p) return null
  return {
    ...toCounts(p),
    number: num(p.number, index + 1),
    title: str(p.title),
    checkpoint: typeof p.checkpoint === 'string' ? p.checkpoint : null,
  }
}

function toTask(value: unknown): TaskView | null {
  const t = asObject(value)
  if (!t) return null
  return {
    index: num(t.index),
    text: str(t.text),
    status: str(t.status),
    sha: typeof t.sha === 'string' ? t.sha : null,
    phase: str(t.phase),
    phase_number: typeof t.phase_number === 'number' ? t.phase_number : null,
    is_phase_verification: t.is_phase_verification === true,
    subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
  }
}

function toEntry(value: unknown): TrackEntry | null {
  const t = asObject(value)
  if (!t || typeof t.id !== 'string') return null
  return {
    id: t.id,
    description: str(t.description),
    status: str(t.status),
    path: typeof t.path === 'string' ? t.path : null,
    exists: t.exists === true,
    progress: asObject(t.progress) ? toCounts(t.progress) : null,
  }
}

// --- Parsing ------------------------------------------------------------------

/**
 * Parses the stdout of `conductor_state.py tracks` (or of `status` without
 * `--track`). Returns [] on any problem; broken rows are skipped one by one.
 */
export function parseTracks(stdout: string): TrackEntry[] {
  const root = parseOk(stdout)
  if (!root || !Array.isArray(root.tracks)) return []
  const entries: TrackEntry[] = []
  for (const row of root.tracks) {
    const entry = toEntry(row)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Parses the stdout of `conductor_state.py status --track <id>`. Returns null
 * for invalid JSON, `ok: false` or a missing track id; missing or null plan
 * fields become neutral values (no phases, zero counts, no tasks).
 */
export function parseStatus(stdout: string): TrackStatus | null {
  const root = parseOk(stdout)
  const track = root ? asObject(root.track) : null
  if (!root || !track || typeof track.id !== 'string') return null
  const phases: PhaseInfo[] = []
  if (Array.isArray(root.phases)) {
    root.phases.forEach((raw, index) => {
      const phase = toPhase(raw, index)
      if (phase) phases.push(phase)
    })
  }
  return {
    track: { id: track.id, description: str(track.description), status: str(track.status) },
    phases,
    tasks: toCounts(root.tasks),
    current_task: toTask(root.current_task),
    next_task: toTask(root.next_task),
    complete: root.complete === true,
  }
}

// --- State and bar ------------------------------------------------------------

/**
 * Derives the track state. Precedence: done, needs_input, running, idle. A
 * pending verification task alone does not need input: only an in-progress one.
 */
export function deriveState(status: TrackStatus): TrackState {
  const { track, tasks, current_task } = status
  const allDone = tasks.total > 0 && tasks.completed === tasks.total
  if (track.status === 'completed' || status.complete || allDone) return 'done'
  if (current_task?.is_phase_verification) return 'needs_input'
  if (current_task || tasks.in_progress > 0) return 'running'
  return 'idle'
}

// completed / total as an integer percentage (0 without tasks)
function percentOf(completed: number, total: number): number {
  return total > 0 ? Math.round((100 * completed) / total) : 0
}

// True when the task view belongs to the given phase (by number, else by title)
function inPhase(task: TaskView | null, phase: PhaseInfo): boolean {
  if (!task) return false
  return task.phase_number !== null ? task.phase_number === phase.number : task.phase === phase.title
}

// One capsule per phase: done, else active (current task's phase, falling back
// to the next task's), else pending. A finished track has no active capsule.
function buildCapsules(status: TrackStatus, state: TrackState): Capsule[] {
  const { phases, current_task, next_task } = status
  const marker = current_task ?? next_task
  return phases.map((phase) => {
    const finished = phase.total > 0 && phase.completed === phase.total
    const active = state !== 'done' && inPhase(marker, phase)
    return {
      number: phase.number,
      title: phase.title,
      completed: phase.completed,
      total: phase.total,
      state: finished ? 'done' : active ? 'active' : 'pending',
      checkpoint: phase.checkpoint,
    }
  })
}

// The script prints counts per phase, not a task list, so each phase yields its
// dots as completed, in progress, then pending. Only the in-progress dot of the
// current task's phase knows its title.
function buildDots(status: TrackStatus): Dot[] {
  const dots: Dot[] = []
  let titled = false
  for (const phase of status.phases) {
    for (let i = 0; i < phase.completed; i++) {
      dots.push({ status: 'completed', phase: phase.number, title: null })
    }
    for (let i = 0; i < phase.in_progress; i++) {
      const title = !titled && inPhase(status.current_task, phase) ? status.current_task!.text : null
      titled = titled || title !== null
      dots.push({ status: 'in_progress', phase: phase.number, title })
    }
    for (let i = 0; i < phase.pending; i++) {
      dots.push({ status: 'pending', phase: phase.number, title: null })
    }
  }
  return dots
}

// Names the current task, else the next task, else nothing
function buildPill(status: TrackStatus, state: TrackState): Pill | null {
  if (state === 'done') return null
  const kind = status.current_task ? 'current' : 'next'
  const view = status.current_task ?? status.next_task
  if (!view) return null
  const task = view.text.replace(/^Task:\s*/, '')
  return { kind, phase: view.phase, task, text: view.phase ? `${view.phase} · ${task}` : task }
}

/** Builds the full bar (percent, capsules, dots, pill) from a track's status. */
export function buildBar(status: TrackStatus): TrackBar {
  const state = deriveState(status)
  return {
    id: status.track.id,
    title: status.track.description || status.track.id,
    status: status.track.status,
    state,
    percent: state === 'done' ? 100 : percentOf(status.tasks.completed, status.tasks.total),
    currentTask: status.current_task ? status.current_task.text : null,
    phases: buildCapsules(status, state),
    dots: buildDots(status),
    pill: buildPill(status, state),
  }
}

/**
 * Fallback bar for a registry row without status output (no plan, or the
 * per-track call failed). needs_input cannot be derived without the plan.
 */
export function barFromEntry(entry: TrackEntry): TrackBar {
  const progress = entry.progress
  const state: TrackState =
    entry.status === 'completed' ? 'done' : progress && progress.in_progress > 0 ? 'running' : 'idle'
  return {
    id: entry.id,
    title: entry.description || entry.id,
    status: entry.status,
    state,
    percent: state === 'done' ? 100 : progress ? percentOf(progress.completed, progress.total) : 0,
    currentTask: null,
    phases: [],
    dots: [],
    pill: null,
  }
}

// --- Dismissal and row selection --------------------------------------------------

/** State plus current task: changes when either does, not when only the percent does. */
export function barSignature(bar: TrackBar): string {
  return `${bar.state}|${bar.currentTask ?? ''}`
}

/** Returns a new map with the bar's current signature recorded; never mutates. */
export function dismiss(dismissals: Dismissals, bar: TrackBar): Dismissals {
  return { ...dismissals, [bar.id]: barSignature(bar) }
}

/** True while the bar's signature still equals the one stored at dismissal. */
export function isDismissed(dismissals: Dismissals, bar: TrackBar): boolean {
  return Object.prototype.hasOwnProperty.call(dismissals, bar.id) && dismissals[bar.id] === barSignature(bar)
}

/**
 * Chooses the rows to show, in registry order: every in-progress track, else
 * only the first pending one, then the tracks that finished this session.
 * Dismissed candidates are dropped, the rest is cut to `max` and `more` counts
 * what was cut.
 */
export function selectRows(
  bars: TrackBar[],
  ctx: RowContext = {},
  max = 3,
): { rows: TrackBar[], more: number } {
  const dismissals = ctx.dismissals ?? {}
  const finished = ctx.finished ?? []
  const active = bars.filter((b) => b.status === 'in_progress')
  const pending = active.length === 0 ? bars.filter((b) => b.status === 'pending').slice(0, 1) : []
  const justFinished = bars.filter((b) => b.status === 'completed' && finished.includes(b.id))
  const candidates = [...active, ...pending, ...justFinished].filter((b) => !isDismissed(dismissals, b))
  return { rows: candidates.slice(0, max), more: Math.max(0, candidates.length - max) }
}

// --- Sounds -------------------------------------------------------------------

/**
 * Compares the new bars with the states last seen. A sound fires when a known
 * track moves INTO needs_input or done. The first snapshot (`previous` null)
 * and tracks seen for the first time stay silent; `muted` silences the events
 * but still advances `next`, so unmuting never replays old transitions.
 */
export function detectSounds(
  previous: StateMap | null,
  bars: TrackBar[],
  muted = false,
): { events: SoundEvent[], next: StateMap } {
  const events: SoundEvent[] = []
  const next: StateMap = {}
  for (const bar of bars) {
    next[bar.id] = bar.state
    const known = previous !== null && Object.prototype.hasOwnProperty.call(previous, bar.id)
    if (muted || !known || previous![bar.id] === bar.state) continue
    if (bar.state === 'needs_input' || bar.state === 'done') {
      events.push({ track: bar.id, sound: bar.state })
    }
  }
  return { events, next }
}
