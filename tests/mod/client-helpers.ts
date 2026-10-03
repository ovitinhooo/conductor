// Helpers for the state-script client tests (not a test file itself).
//
// The functions under test take the mods API object `$` and call `$.plugin.root`,
// `$.session.root()` and `$.process.run(argv, init)`. `claude plugin test` does
// not hand a test the mods API (its own `$` acts as Claude Code and fires
// events), so these tests pass a plain fake `$` that records each process call
// and answers it from a scripted world: a Conductor directory that can be
// initialized or not, a registry and one status document per track.
import * as fx from './fixtures.ts'

/** How a scripted command ends: stdout, a non-zero exit, or a rejected call. */
export type Reply = { stdout: string } | { exitCode: number, stdout?: string, stderr?: string } | { reject: string }

export type World = {
  /** Answer to `locate`; `false` prints `initialized: false`. */
  initialized: boolean
  /** Raw stdout of `tracks`, or a failure. */
  tracks: Reply
  /** Raw stdout of `status --track <id>`, by track id; a missing id exits 1. */
  status: Record<string, Reply>
  /** Overrides `locate` entirely (non-zero exit, garbage, rejection). */
  locate?: Reply
}

export type Call = { argv: string[], init: any }

export const PLUGIN_ROOT = '/plugins/conductor'
export const PROJECT = '/work/project'
export const SCRIPT = PLUGIN_ROOT + '/scripts/conductor_state.py'

export const ok = (value: unknown): Reply => ({ stdout: fx.stdout(value) })

export const locateOutput = (initialized: boolean) =>
  fx.stdout({ ok: true, conductor_dir: 'conductor', source: 'detected', initialized, candidates: ['conductor'] })

/** The scripted `status --track <id>` document of a fixture status object. */
export const statusReply = (status: unknown): Reply => ok(status)

/** Registry progress block of a fixture status object (what `tracks` prints). */
export function progressOf(status: any) {
  return status.tasks
}

/** A registry row for a fixture status object. */
export function entryOf(status: any) {
  return fx.trackEntry(status.track.id, status.track.status, progressOf(status), {
    description: status.track.description,
  })
}

/** A world with the given registry rows; per-track documents are added by the test. */
export function world(rows: any[], statuses: Record<string, Reply> = {}, initialized = true): World {
  return { initialized, tracks: ok(fx.tracksObject(rows)), status: statuses }
}

/** The command word of a recorded call: `locate`, `tracks` or `status`. */
export const commandOf = (call: Call) => call.argv[2]

/** Value that follows a flag in the argument vector, or undefined. */
export function flagValue(call: Call, flag: string): string | undefined {
  const at = call.argv.indexOf(flag)
  return at >= 0 ? call.argv[at + 1] : undefined
}

function answer(w: World, call: Call): Reply {
  const command = commandOf(call)
  if (command === 'locate') return w.locate ?? { stdout: locateOutput(w.initialized) }
  if (command === 'tracks') return w.tracks
  if (command === 'status') {
    const id = flagValue(call, '--track')
    return (id !== undefined && w.status[id]) || { exitCode: 1, stderr: 'unknown track' }
  }
  return { exitCode: 2, stderr: 'unexpected command' }
}

/**
 * Builds a fake `$` over a world. `calls` lists every `$.process.run` in order;
 * `sessionRoot` and `sessionCwd` can be set to a string or made to reject.
 */
export function fakeDollar(
  w: World,
  opts: { root?: string | Error, cwd?: string | Error, pluginRoot?: any } = {},
) {
  const calls: Call[] = []
  const root = opts.root ?? PROJECT
  const cwd = opts.cwd ?? PROJECT
  const settle = (value: string | Error) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value))
  const $ = {
    plugin: { name: 'conductor', root: 'pluginRoot' in opts ? opts.pluginRoot : PLUGIN_ROOT },
    session: { root: () => settle(root), cwd: () => settle(cwd) },
    process: {
      run: async (argv: string[], init: any) => {
        const call = { argv: [...argv], init }
        calls.push(call)
        const reply: any = answer(w, call)
        if ('reject' in reply) throw new Error(reply.reject)
        return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
      },
    },
  }
  return { $, calls, commands: () => calls.map(commandOf) }
}
