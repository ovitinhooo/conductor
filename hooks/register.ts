// Conductor progress mod: module entry point and the state-script client.
//
// Claude Code calls `register` once when the plugin loads. This file also holds
// the client that reads track progress: it runs `scripts/conductor_state.py`
// through `$.process.run` and hands plain data to the pure model in model.ts.
// The progress bars, commands and sounds that use it are added in later tasks.
//
// Rules of the mods validator that shape this file: `$` is passed only to
// functions declared at the top level of this file, never destructured or
// stored, and every call is written in full (`$.process.run(...)`).
import {
  barFromEntry,
  buildBar,
  parseStatus,
  parseTracks,
  selectRows,
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

// --- Module entry point -----------------------------------------------------------------

export function register(on: any) {
  // Runs when the session starts. Writing to the debug log keeps it invisible
  // to users, and `next(e)` lets the session start as usual.
  on('session.start', async ($: any, e: any, next: any) => {
    $.ui.log('conductor progress mod loaded', { to: 'debug' })
    return next(e)
  })
}
