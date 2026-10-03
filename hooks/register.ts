// Conductor progress mod: module entry point and the state-script client.
//
// Claude Code calls `register` once when the plugin loads. This file also holds
// the client that reads track progress: it runs `scripts/conductor_state.py`
// through `$.process.run` and hands plain data to the pure model in model.ts.
// It also draws the bars at `AbovePrompt` and keeps them fresh with a timer and
// after tool calls. It also serves `/conductor-progress` and
// `/conductor-progress-sound`, the band toggle button, and the choices saved per
// user in `$.store`, and plays a sound when a track needs input or finishes.
//
// Rules of the mods validator that shape this file: `$` is passed only to
// functions declared at the top level of this file, never destructured or
// stored, and every call is written in full (`$.process.run(...)`).
import { buildBand, planBand, rowCapacity } from './layout.ts'
import {
  barFromEntry,
  buildBar,
  detectSounds,
  dismiss,
  parseStatus,
  parseTracks,
  selectRows,
  type Dismissals,
  type StateMap,
  type TrackBar,
} from './model.ts'

// --- Tunables ------------------------------------------------------------------

/** A state-script call is killed after this long (the host default is 30 s). */
export const RUN_TIMEOUT_MS = 5000
/** Refreshes closer together than this run nothing (spec: refresh about every 2 s). */
export const MIN_REFRESH_INTERVAL_MS = 1000
/** A negative `locate` is asked again after this many refreshes (about a minute at 2 s). */
export const RECHECK_EVERY = 30
/** Tracks that get a `status --track` call per refresh (the bars shown at most). */
export const MAX_DETAILED = 3
/** The refresh timer's period (`$.clock.every`); the interval guard above also applies. */
export const REFRESH_MS = 2000
/** The most bar rows drawn (spec: at most 3, then "+N more"). */
export const MAX_ROWS = 3
/** One refresh never starts more processes than this: locate, tracks and the status calls. */
export const MAX_PROCESSES = 5

const SCRIPT = '/scripts/conductor_state.py'

// --- Types ---------------------------------------------------------------------

/** What a refresh hands to the renderer: plain data only. */
export type Snapshot = { bars: TrackBar[], changed: boolean }
export type RefreshOptions = {
  /** The caller's clock reading in ms; the client never reads a clock itself. */
  now: number
  /** Ids of tracks that finished this session and should still get a bar. */
  finished?: string[]
  /** Ignore the interval guard (a manual refresh, the first draw). */
  force?: boolean
}

// What the client remembers between refreshes. `raw` holds the stdout of the
// last refresh by command, which is how an unchanged refresh is recognised.
type ClientState = {
  root: string | null
  initialized: boolean | null
  skipped: number
  lastAt: number | null
  raw: Record<string, string>
  bars: TrackBar[]
  inFlight: Promise<Snapshot> | null
}

const fresh = (): ClientState => ({
  root: null,
  initialized: null,
  skipped: 0,
  lastAt: null,
  raw: {},
  bars: [],
  inFlight: null,
})

let client: ClientState = fresh()

/** Forgets every cached output and the interval (tests start from a clean client). */
export function resetClient(): void {
  client = fresh()
}

// --- Interval guard ---------------------------------------------------------------

/**
 * True when a refresh may run: none ran yet, the clock moved backwards, or at
 * least `minIntervalMs` passed. Pure: both times come from the caller.
 */
export function shouldRefresh(
  lastAt: number | null,
  now: number,
  minIntervalMs: number = MIN_REFRESH_INTERVAL_MS,
): boolean {
  return lastAt === null || now < lastAt || now - lastAt >= minIntervalMs
}

// --- Running the state script ----------------------------------------------------------

// The project root: where the session started (or was moved), else its working directory
async function projectRoot($: any): Promise<string | null> {
  try {
    const root = await $.session.root()
    if (typeof root === 'string' && root !== '') return root
  } catch {
    // fall through to the working directory
  }
  try {
    const cwd = await $.session.cwd()
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  } catch {
    return null
  }
}

/**
 * Runs `python3 <plugin root>/scripts/conductor_state.py <command> --root
 * <project> <extra...>` and returns its stdout. Returns null for a non-zero
 * exit, a call that cannot start (Python missing), a missing plugin root or
 * anything else: the mod then shows nothing and never throws into the host.
 * `root` skips the lookup when the caller already has it.
 */
export async function runState($: any, args: string[], root?: string): Promise<string | null> {
  try {
    const pluginRoot = $.plugin.root
    if (typeof pluginRoot !== 'string' || pluginRoot === '') return null
    const project = root ?? (await projectRoot($))
    if (project === null) return null
    const [command, ...extra] = args
    const argv = ['python3', pluginRoot + SCRIPT, command, '--root', project, ...extra]
    const result = await $.process.run(argv, { cwd: project, timeoutMs: RUN_TIMEOUT_MS })
    return result.exitCode === 0 && typeof result.stdout === 'string' ? result.stdout : null
  } catch {
    return null
  }
}

// `locate` reports `initialized: true` once the Conductor directory is set up
function isInitialized(stdout: string | null): boolean {
  if (stdout === null) return false
  try {
    return JSON.parse(stdout)?.initialized === true
  } catch {
    return false
  }
}

// --- Refreshing the bars --------------------------------------------------------------

const unchanged = (): Snapshot => ({ bars: client.bars, changed: false })

// An empty snapshot; `changed` only when something was drawn before
function emptySnapshot(): Snapshot {
  const changed = client.bars.length > 0
  client.raw = {}
  client.bars = []
  return { bars: [], changed }
}

// True when both maps hold the same keys with the same text
function sameRaw(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

// Decides whether Conductor is set up for this project, asking `locate` only
// when needed: a positive answer lasts for the session (until the root moves),
// a negative one is asked again every RECHECK_EVERY refreshes.
async function conductorReady($: any, root: string): Promise<{ ready: boolean, spawned: number }> {
  if (client.initialized === true) return { ready: true, spawned: 0 }
  if (client.initialized === false && client.skipped + 1 < RECHECK_EVERY) {
    client.skipped += 1
    return { ready: false, spawned: 0 }
  }
  const initialized = isInitialized(await runState($, ['locate'], root))
  client.initialized = initialized
  client.skipped = 0
  return { ready: initialized, spawned: 1 }
}

async function runRefresh($: any, finished: string[]): Promise<Snapshot> {
  const root = await projectRoot($)
  if (root === null) return emptySnapshot()
  if (client.root !== root) {
    // A different project: nothing cached about the old one applies, but the
    // interval and the refresh in progress stay
    Object.assign(client, fresh(), { root, lastAt: client.lastAt, inFlight: client.inFlight })
  }

  const located = await conductorReady($, root)
  if (!located.ready) return emptySnapshot()

  const tracksOut = await runState($, ['tracks'], root)
  const entries = tracksOut === null ? [] : parseTracks(tracksOut)
  if (tracksOut === null || entries.length === 0) return emptySnapshot()

  // Registry rows give every track a fallback bar; the rows that can be shown
  // get their status document on top, within the process budget.
  const bars = entries.map(barFromEntry)
  const budget = Math.min(MAX_DETAILED, MAX_PROCESSES - located.spawned - 1)
  const wanted = selectRows(bars, { finished }, budget).rows
  const raw: Record<string, string> = { tracks: tracksOut }
  await Promise.all(
    wanted.map(async (row) => {
      const out = await runState($, ['status', '--track', row.id], root)
      const status = out === null ? null : parseStatus(out)
      if (out === null || status === null) return
      raw['status:' + row.id] = out
      bars[bars.findIndex((bar) => bar.id === row.id)] = buildBar(status)
    }),
  )

  const changed = !sameRaw(raw, client.raw)
  client.raw = raw
  client.bars = bars
  return { bars, changed }
}

/**
 * Reads the track progress through the state script and returns one bar per
 * registry row, in registry order; the rows that can be shown (see
 * `selectRows`: in-progress tracks, else the first pending one, plus the
 * `finished` ids, at most MAX_DETAILED) are built from their status document and
 * the rest from the registry row alone.
 *
 * `changed` is false when every raw output equals the last refresh's, so the
 * caller can skip a redraw. The per-track calls always run: `tracks` only
 * carries counts, so an unchanged `tracks` cannot prove the plan is unchanged.
 * A call within MIN_REFRESH_INTERVAL_MS of the last one runs nothing, and calls
 * that overlap share one run. Never throws: any failure yields no bars.
 */
export async function refreshBars($: any, options: RefreshOptions): Promise<Snapshot> {
  try {
    if (client.inFlight !== null) return await client.inFlight
    if (options.force !== true && !shouldRefresh(client.lastAt, options.now)) return unchanged()
    client.lastAt = options.now
    const run = runRefresh($, options.finished ?? []).catch(() => emptySnapshot())
    client.inFlight = run
    try {
      return await run
    } finally {
      client.inFlight = null
    }
  } catch {
    return { bars: [], changed: false }
  }
}

// --- What the module remembers between draws -----------------------------------------------

/** The user's choices: bars shown, sounds muted. Loaded from `$.store` at session.start, saved on every toggle. */
const view = { visible: true, muted: false }

/** `$.store` keys of the two choices (booleans; anything else counts as unset). */
export const STORE_VISIBLE = 'progress.visible'
export const STORE_MUTED = 'progress.muted'

/** The slash commands registered at session.start. */
export const COMMAND_PROGRESS = 'conductor-progress'
export const COMMAND_SOUND = 'conductor-progress-sound'

/** The text each command answers with. */
export const REPLIES = {
  hidden: 'Conductor progress bars hidden',
  shown: 'Conductor progress bars shown',
  muted: 'Conductor progress sound muted',
  unmuted: 'Conductor progress sound unmuted',
}

type ModuleState = {
  /** The bars of the last refresh, one per registry row. */
  bars: TrackBar[]
  /** True once a refresh finished: the first draw waits for it, later ones never do. */
  loaded: boolean
  /** The refresh the session start began, which the first draw may wait for. */
  loading: Promise<void> | null
  /** Closed bars: track id -> signature when closed (in memory only, never stored). */
  dismissals: Dismissals
  /** Tracks that turned done during this session: their bars stay until closed. */
  finished: string[]
  /** State last seen per track, to spot transitions (null before the first refresh). */
  states: StateMap | null
  timer: { cancel: () => void } | null
}

const freshState = (): ModuleState => ({
  bars: [],
  loaded: false,
  loading: null,
  dismissals: {},
  finished: [],
  states: null,
  timer: null,
})

let state: ModuleState = freshState()

// --- Refreshing and redrawing ---------------------------------------------------------------

/** The sound files, relative to the plugin directory (made by `scripts/make_sounds.py`). */
export const SOUND_FILES = {
  needs_input: 'sounds/needs_input.wav',
  done: 'sounds/done.wav',
}

// Plays one sound. `$.audio.play` resolves only when the clip has ended, so callers
// never wait for it; a clip that cannot play (no player, no file) is ignored.
async function playSound($: any, sound: keyof typeof SOUND_FILES): Promise<void> {
  try {
    await $.audio.play({ asset: SOUND_FILES[sound] })
  } catch {
    // silent: a missing sound never matters more than the bars
  }
}

// Stores a refresh's bars, plays the sounds of the transitions it found, notes the
// tracks that turned done, and asks for a redraw when what is drawn can have
// changed. The same snapshot twice does nothing.
function applySnapshot($: any, snapshot: Snapshot): void {
  if (snapshot.bars === state.bars && state.loaded) return
  // `events` tells which tracks just needed input or finished. A muted session
  // still records them (a finished track keeps its bar), it only plays nothing.
  const { events, next } = detectSounds(state.states, snapshot.bars)
  let redraw = snapshot.changed
  for (const event of events) {
    if (!view.muted) void playSound($, event.sound)
    if (event.sound === 'done' && !state.finished.includes(event.track)) {
      state.finished.push(event.track)
      redraw = true
    }
  }
  state.states = next
  state.bars = snapshot.bars
  state.loaded = true
  if (redraw) $.ui.invalidate('ui.render')
}

/** Refreshes the bars once and redraws when needed. Never throws. */
async function tick($: any): Promise<void> {
  try {
    const now = await $.clock.now()
    if (typeof now !== 'number') return
    applySnapshot($, await refreshBars($, { now, finished: state.finished }))
  } catch {
    // fail soft: the bars stay as they were
  }
}

// Starts the refresh timer and the first refresh (the draw waits for it, if it is first)
function startRefresh($: any): void {
  try {
    state.timer?.cancel()
    state.timer = $.clock.every(REFRESH_MS, () => tick($))
  } catch {
    state.timer = null
  }
  state.loading = tick($)
}

// The first draw cannot wait for a timer tick: it waits for the first refresh instead
async function ensureLoaded($: any): Promise<void> {
  if (state.loaded) return
  if (state.loading === null) state.loading = tick($)
  await state.loading
}

function closeBar($: any, bar: TrackBar): void {
  state.dismissals = dismiss(state.dismissals, bar)
  $.ui.invalidate('ui.render')
}

// --- Choices: saved per user in $.store ----------------------------------------------------------

// A saved choice counts only when it is a boolean; anything else is unset
const savedChoice = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

// Reads one saved choice; a store that fails reads as unset
async function readChoice($: any, key: string, fallback: boolean): Promise<boolean> {
  try {
    return savedChoice(await $.store.get(key), fallback)
  } catch {
    return fallback
  }
}

// Saves one choice; the choice stays in effect for this session even if the write fails
async function writeChoice($: any, key: string, value: boolean): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // not saved: the next session starts from the defaults
  }
}

/** Loads both choices once, at session.start. Never throws. */
async function loadChoices($: any): Promise<void> {
  view.visible = await readChoice($, STORE_VISIBLE, true)
  view.muted = await readChoice($, STORE_MUTED, false)
}

/**
 * Shows or hides the bars (the band toggle and /conductor-progress), redraws and
 * saves the choice. Returns the command's answer. Never throws.
 */
async function toggleBars($: any): Promise<string> {
  view.visible = !view.visible
  const visible = view.visible
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the next draw shows it
  }
  await writeChoice($, STORE_VISIBLE, visible)
  return visible ? REPLIES.shown : REPLIES.hidden
}

/**
 * Mutes or unmutes the sounds (/conductor-progress-sound) and saves the choice.
 * Returns the command's answer. Never throws.
 */
async function toggleSound($: any): Promise<string> {
  view.muted = !view.muted
  const muted = view.muted
  await writeChoice($, STORE_MUTED, muted)
  return muted ? REPLIES.muted : REPLIES.unmuted
}

// Registers one slash command; a failure leaves the other command and the session alone
async function registerCommand($: any, name: string, description: string): Promise<void> {
  try {
    await $.command.register({ name, description, immediate: true })
  } catch {
    // the command is missing; the band button still works
  }
}

// --- Drawing --------------------------------------------------------------------------------

/**
 * The band's tree, or null when nothing is to be drawn: no initialized Conductor,
 * no track, or a script that failed. `engine` is the result of `await next(e)`.
 */
function drawBand($: any, e: any, engine: unknown): unknown {
  // Any track the bars could show decides whether the band is ours at all
  const any = selectRows(state.bars, { finished: state.finished }, MAX_ROWS)
  if (any.rows.length + any.more === 0) return null
  // Every shown candidate first, then as many rows as the band has room for
  const all = selectRows(state.bars, { dismissals: state.dismissals, finished: state.finished }, Infinity).rows
  const inline = planBand(all.slice(0, MAX_ROWS), e.props.bodyColumns).toggleInline
  const room = view.visible ? rowCapacity(e.props.maxRows, all.length, inline, MAX_ROWS) : all.length
  const rows = all.slice(0, room)
  const { Box, Text, Button, Svg } = $.ui.resolve(e)
  return buildBand({
    ui: { Box, Text, Button, Svg },
    desktop: e.surface === 'desktop',
    columns: e.props.bodyColumns,
    rows,
    more: all.length - rows.length,
    showBars: view.visible,
    engine,
    onClose: (bar: TrackBar) => closeBar($, bar),
    // The same action as /conductor-progress
    onToggle: () => {
      void toggleBars($)
    },
  })
}

// --- Module entry point -----------------------------------------------------------------

export function register(on: any) {
  // A fresh load starts from clean state, whatever an earlier load left behind
  resetClient()
  state = freshState()
  view.visible = true
  view.muted = false

  // Runs when the session starts. The saved choices are loaded first (they decide
  // the first draw), the commands are registered, the debug log is invisible to
  // users, the timer keeps the bars current, and `next(e)` lets the session start
  // as usual. Nothing here may stop the session from starting.
  on('session.start', async ($: any, e: any, next: any) => {
    await loadChoices($)
    await registerCommand($, COMMAND_PROGRESS, 'Show or hide the Conductor progress bars')
    await registerCommand($, COMMAND_SOUND, 'Mute or unmute the Conductor progress sounds')
    $.ui.log('conductor progress mod loaded', { to: 'debug' })
    startRefresh($)
    return next(e)
  })

  // The two commands answer with their own text and never run the engine's
  on('command.run', { command: 'conductor-progress' }, async ($: any) => ({ text: await toggleBars($) }))
  on('command.run', { command: 'conductor-progress-sound' }, async ($: any) => ({ text: await toggleSound($) }))

  // The bars, in the band above the prompt. The engine's own drawing (other mods'
  // too) is kept: `next(e)` is awaited once and its result placed inside our tree.
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const engine = await next(e)
    // A survey owns the band while it is up
    if (e.props.hasSurvey === true) return engine
    try {
      await ensureLoaded($)
      return drawBand($, e, engine) ?? engine
    } catch {
      return engine
    }
  })

  // After a tool ran (Claude may have edited plan.md), refresh before the next tick
  on('tool.call', async ($: any, e: any, next: any) => {
    const result = await next(e)
    await tick($)
    return result
  })
}
