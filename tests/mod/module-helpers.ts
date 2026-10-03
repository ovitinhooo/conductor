// Helpers for the module scenarios in module.test.ts (not a test file itself).
//
// The scenarios run the real module through the `claude plugin test` kit: they
// fire events (`$.session.start`, `$.command.run`, `$.tool.call`), draw the
// band with `$.ui.mount`, and stub every call the module makes on Claude Code's
// behalf. This file holds the stubs, the scripted Conductor world they answer
// from, and the track fixtures.
//
// What the kit gives a hook that runs through it (verified on Claude Code
// 2.1.288, see conductor/tracks/progress_mod_20261002/notes.md):
//   - `$.plugin.root` is the real plugin directory (the repo root here) and
//     `$.plugin.name` is the folder name; no stub is needed or possible.
//   - `$.session.root()` and `$.session.cwd()` reject with `no implementation
//     for session.root` unless a stub answers them, so `arrange` stubs both with
//     the scripted project directory.
//   - `$.process.run(argv, init)` is answered by a `process.run` stub that reads
//     `e.argv`; the scripted world replies by state-script command word.
//   - A stub for `ui.invalidate` replaces the kit's own handler, which is the one
//     that redraws a mounted drawing. Scenarios therefore leave it alone, except
//     the one that counts invalidations on purpose (`recordInvalidate`).
import { mock } from 'claude-code/testing'
import * as fx from './fixtures.ts'
import { commandOf, entryOf, flagValue, locateOutput, ok, PROJECT, statusReply } from './client-helpers.ts'
import type { Call, Reply, World } from './client-helpers.ts'

export { commandOf, PROJECT }
export type { Call, Reply, World }

// --- The module's interface, as the scenarios pin it down -------------------------

/** `$.clock.every` period of the refresh timer set up at session.start. */
export const REFRESH_MS = 2000

/** Slash commands registered with `$.command.register` at session.start. */
export const COMMAND_PROGRESS = 'conductor-progress'
export const COMMAND_SOUND = 'conductor-progress-sound'

/** `$.store` keys: booleans, default shown (`true`) and not muted (`false`). */
export const STORE_VISIBLE = 'progress.visible'
export const STORE_MUTED = 'progress.muted'

/** Element keys the module gives the controls it draws in the band. */
export const KEYS = {
  /** The "Conductor" toggle Button. Hotkey '9' (see HOTKEY). */
  toggle: 'toggle',
  /** The Box holding one track's row. */
  bar: (id: string) => 'bar-' + id,
  /** The Button that closes (dismisses) one track's bar. */
  close: (id: string) => 'close-' + id,
}

/**
 * The toggle's digit hotkey: a digit also fires from an empty prompt (reference,
 * "Elements"). 9 stays clear of 1-3, which tab bars and the surveys' option
 * keys use most.
 */
export const HOTKEY = '9'

/** The replies `command.run` returns as `{ text }`. */
export const REPLIES = {
  hidden: 'Conductor progress bars hidden',
  shown: 'Conductor progress bars shown',
  muted: 'Conductor progress sound muted',
  unmuted: 'Conductor progress sound unmuted',
}

/** Text of the tree the `ui.render` stub returns: what Claude Code itself would draw. */
export const ENGINE_TEXT = 'drawn by Claude Code'
export const ENGINE_TREE = { type: 'Text', props: {}, children: [ENGINE_TEXT] }

export const SURFACES = ['terminal', 'desktop'] as const
export type Surface = (typeof SURFACES)[number]

// --- Track fixtures ----------------------------------------------------------------

const SETUP = 'Phase 1: Setup'
const PARSER = 'Phase 2: Parser'
const VERIFY = 'Task: Phase Verification & Checkpoint (Refer to workflow.md)'

/** Status document of a track whose task `task` is running: 2 of 4 tasks done (50%). */
export function running(id = 'login_20260101', title = 'Login flow', task = 'Write the parser') {
  return fx.statusObject(
    { id, description: title, status: 'in_progress' },
    [fx.phase(1, SETUP, { completed: 2 }, 'abc1234'), fx.phase(2, PARSER, { in_progress: 1, pending: 1 })],
    fx.taskView(3, 'Task: ' + task, 'in_progress', PARSER, 2),
    fx.taskView(4, 'Task: Wire the parser', 'pending', PARSER, 2),
  )
}

/** The same track waiting for the user: its in-progress task is the phase verification. */
export function needsInput(id = 'login_20260101', title = 'Login flow') {
  return fx.statusObject(
    { id, description: title, status: 'in_progress' },
    [fx.phase(1, SETUP, { completed: 2 }, 'abc1234'), fx.phase(2, PARSER, { completed: 1, in_progress: 1 })],
    fx.taskView(4, VERIFY, 'in_progress', PARSER, 2, { verification: true }),
    null,
  )
}

/** Every task done, the registry still says in_progress: the bar turns done. */
export function finished(id = 'login_20260101', title = 'Login flow') {
  return fx.statusObject(
    { id, description: title, status: 'in_progress' },
    [fx.phase(1, SETUP, { completed: 2 }, 'abc1234'), fx.phase(2, PARSER, { completed: 2 }, 'def5678')],
    null,
    null,
  )
}

// --- The scripted Conductor world --------------------------------------------------

/** A world holding these tracks (registry rows and status documents), initialized. */
export function worldOf(...statuses: any[]): World {
  const status: Record<string, Reply> = {}
  for (const s of statuses) status[s.track.id] = statusReply(s)
  return { initialized: true, tracks: ok(fx.tracksObject(statuses.map(entryOf))), status }
}

/** Replaces the tracks of a world, as a hand edit of plan.md and tracks.md would. */
export function publish(w: World, ...statuses: any[]): void {
  const next = worldOf(...statuses)
  w.tracks = next.tracks
  w.status = next.status
}

function answer(w: World, argv: string[]): Reply {
  const call = { argv, init: undefined }
  const command = commandOf(call)
  if (command === 'locate') return w.locate ?? { stdout: locateOutput(w.initialized) }
  if (command === 'tracks') return w.tracks
  if (command === 'status') {
    const id = flagValue(call, '--track')
    return (id !== undefined && w.status[id]) || { exitCode: 1, stderr: 'unknown track' }
  }
  return { exitCode: 2, stderr: 'unexpected command' }
}

// --- Stubs --------------------------------------------------------------------------

export type Arrangement = {
  /** The mock clock; `advance(REFRESH_MS)` runs the refresh timer once. */
  clock: ReturnType<typeof mock.clock>
  /** What `$.store` holds right now. */
  store: Map<string, unknown>
  /** Every `$.store.set`, in order. */
  writes: { key: string, value: unknown }[]
  /** Every `$.command.register` argument. */
  registered: any[]
  /** Every `$.process.run` the module made, in order. */
  runs: Call[]
  /** Text of every `$.ui.log` and `$.ui.toast` call. */
  logs: string[]
  toasts: string[]
  /** Every `$.ui.invalidate` event, when `recordInvalidate` was asked for. */
  invalidations: any[]
}

export type ArrangeOptions = {
  /** What `$.store` holds before the module loads (a value saved by an earlier run). */
  store?: Record<string, unknown>
  /** Runs inside the `tool.call` stub: the tool "doing its work" (editing plan.md). */
  onToolCall?: () => void
  /** Stubs `ui.invalidate` to count calls. This stops mounted drawings following them. */
  recordInvalidate?: boolean
}

/**
 * Registers every stub the module needs, over a scripted world, and returns what
 * they recorded. Call it before the first call on `$` (the kit refuses a later
 * `on`). `on` is the test's registrar; both it and `$` are loosely typed, as in
 * register.ts.
 */
export function arrange(on: any, w: World, options: ArrangeOptions = {}): Arrangement {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const a: Arrangement = { clock, store, writes: [], registered: [], runs: [], logs: [], toasts: [], invalidations: [] }

  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    a.writes.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => ({ value: store.delete(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))

  on('process.run', ($: any, e: any) => {
    a.runs.push({ argv: [...e.argv], init: e.init })
    const reply: any = answer(w, e.argv)
    if ('reject' in reply) return { deny: reply.reject }
    return { value: { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' } }
  })
  on('session.root', () => ({ value: PROJECT }))
  on('session.cwd', () => ({ value: PROJECT }))

  on('command.register', ($: any, e: any) => {
    a.registered.push(e)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    a.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    a.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => ({ value: undefined }))
  if (options.recordInvalidate === true) {
    on('ui.invalidate', ($: any, e: any) => {
      a.invalidations.push(e)
      return { value: undefined }
    })
  }

  on('session.start', () => ({ cwd: PROJECT }))
  on('tool.call', () => {
    options.onToolCall?.()
    return { result: 'ok' }
  })
  // Stands for what Claude Code draws at the band: the engine ref the module must keep
  on('ui.render', () => ENGINE_TREE)
  return a
}

// --- Driving the module ---------------------------------------------------------------

/** Fires session.start, which loads saved choices, registers commands, starts the timer. */
export async function startSession($: any, surface: Surface = 'terminal'): Promise<void> {
  await $.session.start({ surface, isInteractive: true, cwd: PROJECT })
}

/**
 * The plugin name the kit knows the module by: `$.plugin.name`, which is the
 * plugin folder's name (the manifest sits at the repo root, not under
 * `.claude-plugin/`, so no manifest name applies). `press` only reaches buttons
 * mounted under that name. The test files live in `<plugin>/tests/mod`.
 */
export function pluginName(): string {
  const dir: string = (import.meta as any).dir ?? ''
  const parts = dir.split('/').filter((part) => part !== '')
  return parts.length >= 3 ? parts[parts.length - 3]! : 'conductor'
}

/** What Claude Code passes the band, apart from the props a test changes. */
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

/** Draws the `AbovePrompt` band on a surface and returns the mounted drawing. */
export async function draw($: any, surface: Surface = 'terminal', props: Record<string, unknown> = {}) {
  return $.ui.mount({
    plugin: pluginName(),
    component: 'AbovePrompt',
    surface,
    requestId: 'band',
    viewport: { columns: 100, rows: 30 },
    props: { ...BAND_PROPS, ...props },
  })
}

/** First Text of the drawing whose shown text matches. */
export const textOf = (ui: any, text: RegExp | string) => ui.find({ type: 'Text', text })

/** Ids of the bars the drawing holds, among the given candidates. */
export async function barsIn(ui: any, ids: string[]): Promise<string[]> {
  const found: string[] = []
  for (const id of ids) if ((await ui.find({ key: KEYS.bar(id) })) !== undefined) found.push(id)
  return found
}
