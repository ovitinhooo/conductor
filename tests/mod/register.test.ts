import { expect, test } from 'claude-code/testing'

test('session.start logs once and lets the session start', async ($, on) => {
  // Collect the text of each debug-log line the mod writes
  const logged: string[] = []
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  // Answer the event after the mod's hook passes it on with next(e)
  on('session.start', () => ({ cwd: '/work' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(logged).toEqual(['conductor progress mod loaded'])
})
