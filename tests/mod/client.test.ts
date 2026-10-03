// Contract tests for the state-script client in hooks/register.ts.
//
// INTERFACE (top-level functions of hooks/register.ts that take the mods API
// object `$`; they never throw, whatever `$` or the script does):
//
//   runState($, args: string[], root?: string): Promise<string | null>
//     Runs `python3 <$.plugin.root>/scripts/conductor_state.py <args[0]>
//     --root <project> <args[1..]>` with `$.process.run` (cwd = project, a short
//     `timeoutMs`) and returns stdout, or null for a non-zero exit, a rejected
//     call, a missing `$.plugin.root` or any other failure. The project root is
//     `await $.session.root()`, falling back to `$.session.cwd()`; callers that
//     already know it pass `root`.
//
//   refreshBars($, { now, finished?, force? }): Promise<{ bars: TrackBar[], changed: boolean }>
//     Runs `locate` (a positive answer is cached for the session, a negative
//     one is re-checked every RECHECK_EVERY refreshes), then `tracks`, then
//     `status --track <id>` for the tracks that can be shown (see selectRows:
//     in-progress ones, else the first pending one, plus `finished` ids), at
//     most MAX_DETAILED of them and at most MAX_PROCESSES processes in all.
//     `bars` holds one bar per registry row, in registry order: built from the
//     status document when the per-track call worked, else from the row
//     (barFromEntry). `changed` is false when every raw output equals the last
//     refresh's. Per-track calls are never skipped when only `tracks` is
//     unchanged: `tracks` carries counts, not checkpoints or the current task.
//     A call within MIN_REFRESH_INTERVAL_MS of the last one (unless `force`)
//     runs nothing and returns the last bars with changed false. `now` is
//     passed in; the client never reads a clock.
//
//   shouldRefresh(lastAt: number | null, now: number, minIntervalMs = MIN_REFRESH_INTERVAL_MS): boolean
//     Pure interval guard: true when never refreshed, when the clock moved
//     backwards, or when at least minIntervalMs passed.
//
//   resetClient(): forgets the module-level caches (tests only).
import { expect, test } from 'claude-code/testing'
import {
  MAX_DETAILED,
  MAX_PROCESSES,
  MIN_REFRESH_INTERVAL_MS,
  RECHECK_EVERY,
  RUN_TIMEOUT_MS,
  refreshBars,
  resetClient,
  runState,
  shouldRefresh,
} from '../../hooks/register.ts'
import { barFromEntry, buildBar, parseStatus, parseTracks, selectRows } from '../../hooks/model.ts'
import * as fx from './fixtures.ts'
import {
  PLUGIN_ROOT,
  PROJECT,
  SCRIPT,
  commandOf,
  entryOf,
  fakeDollar,
  flagValue,
  ok,
  statusReply,
  world,
} from './client-helpers.ts'

// A fixture status object under another track id
function named(id: string, base: any = fx.running, status = 'in_progress') {
  return { ...base, track: { ...base.track, id, description: 'Track ' + id, status } }
}

const barOf = (status: any) => buildBar(parseStatus(fx.stdout(status))!)

// --- runState ---------------------------------------------------------------

test('runState runs python3 on the script under the plugin root with --root', async () => {
  resetClient()
  const { $, calls } = fakeDollar(world([], {}))
  const out = await runState($, ['tracks'])
  expect(calls.length).toBe(1)
  expect(calls[0].argv).toEqual(['python3', SCRIPT, 'tracks', '--root', PROJECT])
  expect(calls[0].init.cwd).toBe(PROJECT)
  expect(calls[0].init.timeoutMs).toBe(RUN_TIMEOUT_MS)
  expect(typeof out).toBe('string')
})

test('runState keeps the per-track arguments after the command', async () => {
  resetClient()
  const { $, calls } = fakeDollar(world([], {}))
  await runState($, ['status', '--track', 'abc'])
  expect(calls[0].argv).toEqual(['python3', SCRIPT, 'status', '--root', PROJECT, '--track', 'abc'])
})

test('the script path follows the plugin root', async () => {
  resetClient()
  const { $, calls } = fakeDollar(world([], {}), { pluginRoot: '/opt/other/conductor' })
  await runState($, ['locate'])
  expect(calls[0].argv[1]).toBe('/opt/other/conductor/scripts/conductor_state.py')
})

test('the timeout is short', () => {
  expect(RUN_TIMEOUT_MS > 0).toBe(true)
  expect(RUN_TIMEOUT_MS <= 10000).toBe(true)
})

test('runState uses the session root, then the working directory, and honours an explicit root', async () => {
  resetClient()
  const viaCwd = fakeDollar(world([], {}), { root: new Error('no root'), cwd: '/from/cwd' })
  await runState(viaCwd.$, ['tracks'])
  expect(flagValue(viaCwd.calls[0], '--root')).toBe('/from/cwd')

  const explicit = fakeDollar(world([], {}))
  await runState(explicit.$, ['tracks'], '/explicit')
  expect(flagValue(explicit.calls[0], '--root')).toBe('/explicit')
  expect(explicit.calls[0].init.cwd).toBe('/explicit')
})

test('runState returns null for a non-zero exit', async () => {
  resetClient()
  const w = world([], {})
  w.tracks = { exitCode: 2, stdout: '{"ok": false}', stderr: 'boom' }
  const { $ } = fakeDollar(w)
  expect(await runState($, ['tracks'])).toBe(null)
})

test('runState returns null when python3 cannot start (rejected call)', async () => {
  resetClient()
  const w = world([], {})
  w.tracks = { reject: 'python3 not found' }
  const { $ } = fakeDollar(w)
  expect(await runState($, ['tracks'])).toBe(null)
})

test('runState returns null when the script is missing (python exits 2)', async () => {
  resetClient()
  const w = world([], {})
  w.tracks = { exitCode: 2, stdout: '', stderr: "python3: can't open file" }
  const { $ } = fakeDollar(w)
  expect(await runState($, ['tracks'])).toBe(null)
})

test('runState returns null without a plugin root, without a project root, or with a broken $', async () => {
  resetClient()
  const noPlugin = fakeDollar(world([], {}), { pluginRoot: undefined })
  expect(await runState(noPlugin.$, ['tracks'])).toBe(null)
  expect(noPlugin.calls.length).toBe(0)

  const noRoot = fakeDollar(world([], {}), { root: new Error('x'), cwd: new Error('y') })
  expect(await runState(noRoot.$, ['tracks'])).toBe(null)

  expect(await runState({}, ['tracks'])).toBe(null)
  expect(await runState(null, ['tracks'])).toBe(null)
  expect(await runState(undefined, ['tracks'])).toBe(null)
})

// --- refreshBars: happy path --------------------------------------------------

test('one in-progress track: locate, tracks, then its status, and one bar', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, calls, commands } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })

  expect(commands()).toEqual(['locate', 'tracks', 'status'])
  expect(flagValue(calls[2], '--track')).toBe(fx.TRACK_ID)
  for (const call of calls) {
    expect(call.argv[0]).toBe('python3')
    expect(call.argv[1]).toBe(SCRIPT)
    expect(flagValue(call, '--root')).toBe(PROJECT)
  }
  expect(snapshot.changed).toBe(true)
  expect(snapshot.bars.length).toBe(1)
  expect(snapshot.bars[0]).toEqual(barOf(fx.running))
  expect(snapshot.bars[0].state).toBe('running')
  expect(snapshot.bars[0].phases.length > 0).toBe(true)
})

test('the snapshot is plain data that survives a JSON round trip', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $ } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
})

test('a derived state (needs_input) comes from the status document', async () => {
  resetClient()
  const w = world([entryOf(fx.needsInput)], { [fx.TRACK_ID]: statusReply(fx.needsInput) })
  const { $ } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })
  expect(snapshot.bars[0].state).toBe('needs_input')
})

test('the first pending track is fetched when nothing is in progress', async () => {
  resetClient()
  const a = named('a_pending', fx.pendingTrack, 'pending')
  const b = named('b_pending', fx.pendingTrack, 'pending')
  const w = world([entryOf(a), entryOf(b)], { a_pending: statusReply(a), b_pending: statusReply(b) })
  const { $, calls } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })
  const tracked = calls.filter((c) => commandOf(c) === 'status').map((c) => flagValue(c, '--track'))
  expect(tracked).toEqual(['a_pending'])
  expect(snapshot.bars.length).toBe(2)
  expect(snapshot.bars[0].pill).not.toBe(null)
  // The second row was not fetched: a registry-row fallback
  expect(snapshot.bars[1]).toEqual(barFromEntry(parseTracks(fx.stdout(fx.tracksObject([entryOf(b)])))[0]))
})

test('a track finished this session is fetched only when the caller says so', async () => {
  resetClient()
  const done = named('done_one', fx.allDone, 'completed')
  const live = named('live_one')
  const rows = [entryOf(live), entryOf(done)]
  const statuses = { live_one: statusReply(live), done_one: statusReply(done) }

  const without = fakeDollar(world(rows, statuses))
  await refreshBars(without.$, { now: 0 })
  expect(without.calls.filter((c) => commandOf(c) === 'status').length).toBe(1)

  resetClient()
  const withFinished = fakeDollar(world(rows, statuses))
  const snapshot = await refreshBars(withFinished.$, { now: 0, finished: ['done_one'] })
  const tracked = withFinished.calls.filter((c) => commandOf(c) === 'status').map((c) => flagValue(c, '--track'))
  expect(tracked).toEqual(['live_one', 'done_one'])
  expect(snapshot.bars.find((b) => b.id === 'done_one')!.state).toBe('done')
})

// --- refreshBars: caps ---------------------------------------------------------

test('many in-progress tracks: at most MAX_DETAILED status calls and MAX_PROCESSES processes', async () => {
  resetClient()
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
  const docs = ids.map((id) => named(id))
  const statuses: Record<string, any> = {}
  for (const d of docs) statuses[d.track.id] = statusReply(d)
  const { $, calls } = fakeDollar(world(docs.map(entryOf), statuses))
  const snapshot = await refreshBars($, { now: 0, finished: ['t1', 't2', 't3', 't4'] })

  const tracked = calls.filter((c) => commandOf(c) === 'status').map((c) => flagValue(c, '--track'))
  expect(tracked).toEqual(['t1', 't2', 't3'])
  expect(MAX_DETAILED).toBe(3)
  expect(calls.length <= MAX_PROCESSES).toBe(true)
  expect(calls.length).toBe(5)
  // Every registry row still yields a bar, so the caller can count "+N more"
  expect(snapshot.bars.map((b) => b.id)).toEqual(ids)
  expect(snapshot.bars[0].phases.length > 0).toBe(true)
  expect(snapshot.bars[3].phases.length).toBe(0)
  const shown = selectRows(snapshot.bars, {}, 3)
  expect(shown.rows.length).toBe(3)
  expect(shown.more).toBe(4)
})

test('the process cap also holds with several tracks finished this session', async () => {
  resetClient()
  const live = [named('l1'), named('l2')]
  const done = [named('d1', fx.allDone, 'completed'), named('d2', fx.allDone, 'completed')]
  const docs = [...live, ...done]
  const statuses: Record<string, any> = {}
  for (const d of docs) statuses[d.track.id] = statusReply(d)
  const { $, calls } = fakeDollar(world(docs.map(entryOf), statuses))
  await refreshBars($, { now: 0, finished: ['d1', 'd2'] })
  expect(calls.length <= MAX_PROCESSES).toBe(true)
})

// --- refreshBars: Conductor not initialized --------------------------------------------

test('a project without Conductor shows nothing and spawns only locate', async () => {
  resetClient()
  const { $, commands } = fakeDollar(world([], {}, false))
  const snapshot = await refreshBars($, { now: 0 })
  expect(snapshot).toEqual({ bars: [], changed: false })
  expect(commands()).toEqual(['locate'])
})

test('a negative locate is re-checked only every RECHECK_EVERY refreshes', async () => {
  resetClient()
  const { $, commands } = fakeDollar(world([], {}, false))
  let now = 0
  for (let i = 0; i < RECHECK_EVERY * 2; i++) {
    await refreshBars($, { now })
    now += MIN_REFRESH_INTERVAL_MS
  }
  // First refresh, the re-check after RECHECK_EVERY more, and nothing else
  expect(commands().filter((c) => c === 'locate').length).toBe(2)
  expect(commands().every((c) => c === 'locate')).toBe(true)
})

test('initializing Conductor later shows the bars at the next re-check', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) }, false)
  const { $ } = fakeDollar(w)
  let now = 0
  expect((await refreshBars($, { now })).bars).toEqual([])
  w.initialized = true
  let snapshot = { bars: [] as any[], changed: false }
  for (let i = 0; i < RECHECK_EVERY + 1 && snapshot.bars.length === 0; i++) {
    now += MIN_REFRESH_INTERVAL_MS
    snapshot = await refreshBars($, { now })
  }
  expect(snapshot.bars.length).toBe(1)
  expect(snapshot.changed).toBe(true)
})

test('a positive locate is cached for the session', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, commands } = fakeDollar(w)
  let now = 0
  for (let i = 0; i < 5; i++) {
    await refreshBars($, { now })
    now += MIN_REFRESH_INTERVAL_MS
  }
  expect(commands().filter((c) => c === 'locate').length).toBe(1)
  expect(commands().filter((c) => c === 'tracks').length).toBe(5)
})

test('a new project root is located again', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const first = fakeDollar(w, { root: '/work/a' })
  await refreshBars(first.$, { now: 0 })
  const second = fakeDollar(w, { root: '/work/b' })
  const snapshot = await refreshBars(second.$, { now: MIN_REFRESH_INTERVAL_MS })
  expect(second.commands()[0]).toBe('locate')
  expect(flagValue(second.calls[0], '--root')).toBe('/work/b')
  // A different project is a change even when the output text is the same
  expect(snapshot.changed).toBe(true)
})

// --- refreshBars: throttling and change detection ------------------------------------------

test('unchanged output reports changed false, keeps the bars and still runs the status calls', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, commands } = fakeDollar(w)
  const first = await refreshBars($, { now: 0 })
  const second = await refreshBars($, { now: MIN_REFRESH_INTERVAL_MS })
  expect(first.changed).toBe(true)
  expect(second.changed).toBe(false)
  expect(second.bars).toEqual(first.bars)
  // Skipping `status` when only `tracks` is unchanged would miss checkpoints
  // and the current task, so every refresh runs it again
  expect(commands()).toEqual(['locate', 'tracks', 'status', 'tracks', 'status'])
})

test('changed track output reports changed true with the new bars', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $ } = fakeDollar(w)
  await refreshBars($, { now: 0 })

  const later = named(fx.TRACK_ID, fx.needsInput)
  w.tracks = ok(fx.tracksObject([entryOf(later)]))
  w.status[fx.TRACK_ID] = statusReply(later)
  const snapshot = await refreshBars($, { now: MIN_REFRESH_INTERVAL_MS })
  expect(snapshot.changed).toBe(true)
  expect(snapshot.bars[0].state).toBe('needs_input')
})

test('a change only in the status document (same counts) is noticed', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $ } = fakeDollar(w)
  await refreshBars($, { now: 0 })
  // Same registry output; a checkpoint SHA appears in the plan
  const edited = JSON.parse(JSON.stringify(fx.running))
  edited.phases[1].checkpoint = 'abcdef0'
  w.status[fx.TRACK_ID] = statusReply(edited)
  const snapshot = await refreshBars($, { now: MIN_REFRESH_INTERVAL_MS })
  expect(snapshot.changed).toBe(true)
  expect(snapshot.bars[0].phases[1].checkpoint).toBe('abcdef0')
})

test('an interval guard skips a refresh that comes too soon', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, calls } = fakeDollar(w)
  const first = await refreshBars($, { now: 10_000 })
  const spawned = calls.length

  const early = await refreshBars($, { now: 10_000 + MIN_REFRESH_INTERVAL_MS - 1 })
  expect(calls.length).toBe(spawned)
  expect(early.changed).toBe(false)
  expect(early.bars).toEqual(first.bars)

  await refreshBars($, { now: 10_000 + MIN_REFRESH_INTERVAL_MS })
  expect(calls.length > spawned).toBe(true)
})

test('force bypasses the interval guard', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, calls } = fakeDollar(w)
  await refreshBars($, { now: 500 })
  const spawned = calls.length
  await refreshBars($, { now: 501, force: true })
  expect(calls.length > spawned).toBe(true)
})

test('shouldRefresh compares the passed-in times', () => {
  expect(shouldRefresh(null, 0)).toBe(true) // never refreshed
  expect(shouldRefresh(1000, 1999, 1000)).toBe(false)
  expect(shouldRefresh(1000, 2000, 1000)).toBe(true)
  expect(shouldRefresh(1000, 1000 + MIN_REFRESH_INTERVAL_MS - 1)).toBe(false)
  expect(shouldRefresh(1000, 1000 + MIN_REFRESH_INTERVAL_MS)).toBe(true)
  // A clock that moved backwards must not freeze the refresh
  expect(shouldRefresh(5000, 100, 1000)).toBe(true)
})

test('overlapping refreshes share one run', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $, calls } = fakeDollar(w)
  const [a, b] = await Promise.all([refreshBars($, { now: 0 }), refreshBars($, { now: 1 })])
  expect(calls.length).toBe(3)
  expect(b).toEqual(a)
})

// --- refreshBars: fail soft ----------------------------------------------------------------

test('a failing per-track call falls back to the registry row', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: { exitCode: 1, stderr: 'nope' } })
  const { $ } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })
  const row = parseTracks(fx.stdout(fx.tracksObject([entryOf(fx.running)])))[0]
  expect(snapshot.bars).toEqual([barFromEntry(row)])
  expect(snapshot.bars[0].phases).toEqual([])
})

test('a rejected or garbled per-track call falls back too, and recovers later', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: { reject: 'spawn failed' } })
  const { $ } = fakeDollar(w)
  const row = parseTracks(fx.stdout(fx.tracksObject([entryOf(fx.running)])))[0]
  expect((await refreshBars($, { now: 0 })).bars).toEqual([barFromEntry(row)])

  w.status[fx.TRACK_ID] = { stdout: 'not json' }
  expect((await refreshBars($, { now: 1000 })).bars).toEqual([barFromEntry(row)])

  w.status[fx.TRACK_ID] = statusReply(fx.running)
  const healed = await refreshBars($, { now: 2000 })
  expect(healed.changed).toBe(true)
  expect(healed.bars).toEqual([barOf(fx.running)])
})

test('a non-zero exit from locate shows nothing and does not throw', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  w.locate = { exitCode: 1, stdout: '', stderr: 'error' }
  const { $, commands } = fakeDollar(w)
  const snapshot = await refreshBars($, { now: 0 })
  expect(snapshot).toEqual({ bars: [], changed: false })
  expect(commands()).toEqual(['locate'])
})

test('invalid locate output counts as not initialized', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  w.locate = { stdout: 'Traceback (most recent call last)' }
  const { $ } = fakeDollar(w)
  expect(await refreshBars($, { now: 0 })).toEqual({ bars: [], changed: false })
})

test('python3 missing (rejected call) shows nothing', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  w.locate = { reject: 'python3 not found' }
  const { $ } = fakeDollar(w)
  expect(await refreshBars($, { now: 0 })).toEqual({ bars: [], changed: false })
})

test('invalid JSON from tracks shows nothing', async () => {
  resetClient()
  const w = world([], {})
  w.tracks = { stdout: '{"ok": tru' }
  const { $, commands } = fakeDollar(w)
  expect(await refreshBars($, { now: 0 })).toEqual({ bars: [], changed: false })
  expect(commands()).toEqual(['locate', 'tracks'])
})

test('tracks failing after bars were shown empties them and reports a change', async () => {
  resetClient()
  const w = world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) })
  const { $ } = fakeDollar(w)
  expect((await refreshBars($, { now: 0 })).bars.length).toBe(1)

  w.tracks = { exitCode: 2, stderr: 'script missing' }
  const failed = await refreshBars($, { now: 1000 })
  expect(failed).toEqual({ bars: [], changed: true })

  // Still failing: nothing new to draw
  expect(await refreshBars($, { now: 2000 })).toEqual({ bars: [], changed: false })

  // Back to normal: the bar returns and counts as a change
  w.tracks = ok(fx.tracksObject([entryOf(fx.running)]))
  const healed = await refreshBars($, { now: 3000 })
  expect(healed.changed).toBe(true)
  expect(healed.bars.length).toBe(1)
})

test('refreshBars never throws, whatever $ is', async () => {
  resetClient()
  expect(await refreshBars({}, { now: 0 })).toEqual({ bars: [], changed: false })
  resetClient()
  expect(await refreshBars(null, { now: 0 })).toEqual({ bars: [], changed: false })
  resetClient()
  const thrower = { plugin: { root: PLUGIN_ROOT }, session: { root: async () => PROJECT }, process: { run: () => { throw new Error('sync') } } }
  expect(await refreshBars(thrower, { now: 0 })).toEqual({ bars: [], changed: false })
  resetClient()
  const empty = fakeDollar(world([], {}), { pluginRoot: undefined })
  expect(await refreshBars(empty.$, { now: 0 })).toEqual({ bars: [], changed: false })
})

test('the plugin root is only read from $.plugin.root', async () => {
  resetClient()
  const { $, calls } = fakeDollar(world([entryOf(fx.running)], { [fx.TRACK_ID]: statusReply(fx.running) }))
  await refreshBars($, { now: 0 })
  expect(calls.every((c) => c.argv[1].startsWith(PLUGIN_ROOT + '/'))).toBe(true)
})
