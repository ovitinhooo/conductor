// A store that fails must never break the module: the session still starts, the
// timer still runs, and a toggle still takes effect for the rest of the session.
import { expect, test } from 'claude-code/testing'
import {
  arrange,
  COMMAND_PROGRESS,
  COMMAND_SOUND,
  draw,
  KEYS,
  REPLIES,
  running,
  startSession,
  worldOf,
} from './module-helpers.ts'

const ID = 'login_20260101'

// `arrange` stubs the whole store; this drops one of its handlers so the test can
// register a failing one in its place (the kit refuses two handlers for one call).
const without = (on: any, skipped: string) => (event: any, ...rest: any[]) =>
  event === skipped ? undefined : on(event, ...rest)

test('a store that cannot be read leaves the defaults and the session starts', async ($, on) => {
  const h = arrange(without(on, 'store.get'), worldOf(running(ID)))
  on('store.get', () => ({ deny: 'store unavailable' }))

  await startSession($)
  const ui = await draw($)

  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
  expect(h.registered.length).toBe(2)
  const answer = await $.command.run({ command: COMMAND_SOUND, args: '' })
  expect(answer.text).toBe(REPLIES.muted)
})

test('a store that cannot be written still toggles for the session', async ($, on) => {
  const h = arrange(without(on, 'store.set'), worldOf(running(ID)))
  on('store.set', () => ({ deny: 'store full' }))
  await startSession($)
  const ui = await draw($)

  const hidden = await $.command.run({ command: COMMAND_PROGRESS, args: '' })

  expect(hidden.text).toBe(REPLIES.hidden)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeUndefined()
  expect(h.writes).toEqual([])
  const shown = await $.command.run({ command: COMMAND_PROGRESS, args: '' })
  expect(shown.text).toBe(REPLIES.shown)
  expect(await ui.find({ key: KEYS.bar(ID) })).toBeDefined()
})
