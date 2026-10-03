// Tests for the row layout (hooks/layout.ts, pure) and for the drawing rules the
// module scenarios in module.test.ts leave open: palette contrast, narrow-width
// degradation, the row cut-off, phase hover details, the desktop Svg, and the bars
// of tracks that finish during the session.
import { expect, test } from 'claude-code/testing'
import * as fx from './fixtures.ts'
import { buildBar, parseStatus } from '../../hooks/model.ts'
import {
  barCells,
  barSvg,
  capsuleDetails,
  CARD,
  compressDots,
  contrastRatio,
  MAX_DOTS,
  PALETTE,
  phasesSvg,
  planRow,
  rowCapacity,
  STATE_GLYPH,
  STATE_LABEL,
  TRACK_COLOR,
} from '../../hooks/layout.ts'
import {
  arrange,
  draw,
  finished,
  KEYS,
  publish,
  REFRESH_MS,
  running,
  startSession,
  textOf,
  worldOf,
} from './module-helpers.ts'

const barOf = (status: unknown) => buildBar(parseStatus(fx.stdout(status))!)

// --- Palette ------------------------------------------------------------------------------

test('every state chip keeps at least 4.5:1 between its text and its background', () => {
  for (const [state, swatch] of Object.entries(PALETTE)) {
    expect(contrastRatio(swatch.fg, swatch.bg), state).toBeGreaterThanOrEqual(4.5)
  }
  expect(contrastRatio(CARD.fg, CARD.bg)).toBeGreaterThanOrEqual(4.5)
})

test('the bar fill stands out from the track by at least 3:1', () => {
  for (const [state, swatch] of Object.entries(PALETTE)) {
    expect(contrastRatio(swatch.bg, TRACK_COLOR), state).toBeGreaterThanOrEqual(3)
  }
})

test('the contrast function matches the known extremes', () => {
  expect(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21)).toBeLessThan(1e-9)
  expect(Math.abs(contrastRatio('#777777', '#777777') - 1)).toBeLessThan(1e-9)
})

test('every state has its own glyph and a word, so color is never the only signal', () => {
  const states = ['running', 'needs_input', 'done', 'idle'] as const
  expect(new Set(states.map((s) => STATE_GLYPH[s])).size).toBe(4)
  expect(new Set(states.map((s) => STATE_LABEL[s])).size).toBe(4)
})

// --- Width planning -----------------------------------------------------------------------

test('a wide band keeps everything, a narrow one drops the pill, then the dots, then the capsules', () => {
  const bar = barOf(running('login_20260101', 'Login flow', 'Write the parser'))
  let last = { pill: true, dots: true, capsules: true, barWidth: 12 }
  for (let columns = 140; columns >= 20; columns--) {
    const plan = planRow(bar, columns)
    const now = { pill: plan.pillWidth > 0, dots: plan.dots, capsules: plan.capsules, barWidth: plan.barWidth }
    // A part that was dropped never comes back on a narrower band (the bar itself
    // shrinks at 60 and 40 columns, which frees room for the parts again)
    if (now.barWidth === last.barWidth) {
      for (const part of ['pill', 'dots', 'capsules'] as const) expect(last[part] || !now[part]).toBe(true)
    }
    // The pill goes first, then the dots, then the capsules
    if (now.pill) expect(now.dots && now.capsules).toBe(true)
    if (now.dots) expect(now.capsules).toBe(true)
    last = now
  }
  expect(planRow(bar, 140)).toMatchObject({ capsules: true, dots: true })
  expect(planRow(bar, 140).pillWidth).toBeGreaterThan(0)
  const bare = planRow(bar, 40)
  expect(bare).toMatchObject({ capsules: false, dots: false, pillWidth: 0 })
})

test('the planned widths never exceed the band while the bare row fits', () => {
  const bar = barOf(running('login_20260101', 'A very long track title that must be cut somewhere', 'Task'))
  for (let columns = 36; columns <= 140; columns++) {
    const plan = planRow(bar, columns)
    // chip + title + bar + percent + close, then the optional parts, one cell apart
    let sizes = [' ► running '.length, plan.titleWidth, plan.barWidth, 4, 5]
    if (plan.capsules) sizes.push(bar.phases.length * 4 + (bar.phases.length - 1))
    if (plan.dots) sizes.push(bar.dots.length)
    if (plan.pillWidth > 0) sizes.push(plan.pillWidth)
    const used = sizes.reduce((a, b) => a + b, 0) + sizes.length - 1
    expect(used, `columns ${columns}`).toBeLessThanOrEqual(columns)
  }
})

test('the bar width and the row cut-off follow the band', () => {
  const bar = barOf(running())
  expect(planRow(bar, 100).barWidth).toBe(12)
  expect(planRow(bar, 50).barWidth).toBe(8)
  expect(planRow(bar, 30).barWidth).toBe(5)
  // The footer row takes one row of the band; at most three bars
  expect(rowCapacity(12)).toBe(3)
  expect(rowCapacity(3)).toBe(2)
  expect(rowCapacity(1)).toBe(0)
  expect(rowCapacity(0)).toBe(0)
})

test('a long plan groups its task dots instead of filling the row', () => {
  const dots = Array.from({ length: 47 }, (_, i) => ({
    status: (i < 20 ? 'completed' : i === 20 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
    phase: 1,
    title: null,
  }))
  const grouped = compressDots(dots)
  expect(grouped).toHaveLength(MAX_DOTS)
  expect(grouped[0]!.status).toBe('completed')
  expect(grouped[grouped.length - 1]!.status).toBe('pending')
  expect(compressDots(dots.slice(0, 5))).toHaveLength(5)
})

// --- Pieces -------------------------------------------------------------------------------------

test('the terminal bar fills in proportion to the percent', () => {
  expect(barCells(50, 12)).toEqual({ filled: '█'.repeat(6), empty: '░'.repeat(6) })
  expect(barCells(0, 8).filled).toBe('')
  expect(barCells(100, 8).empty).toBe('')
  expect(barCells(250, 4).filled).toHaveLength(4)
  expect(barCells(Number.NaN, 4).filled).toBe('')
})

test('the hover text names the phase, its counts and its checkpoint when it has one', () => {
  const base = { number: 1, title: 'Phase 1: Setup', completed: 2, total: 3, state: 'active' as const }
  expect(capsuleDetails({ ...base, checkpoint: 'abc1234' })).toBe('Phase 1: Setup · 2/3 tasks · checkpoint abc1234')
  expect(capsuleDetails({ ...base, checkpoint: null })).toBe('Phase 1: Setup · 2/3 tasks')
})

test('the desktop drawings are small valid SVG with escaped titles', () => {
  const bar = barOf(running())
  const track = barSvg(50, 'running', 12)
  expect(track.source.startsWith('<svg ')).toBe(true)
  expect(track.source.endsWith('</svg>')).toBe(true)
  expect(track.width).toBe(96)

  const tricky = { ...bar, phases: [{ ...bar.phases[0]!, title: 'A & <B> "C"' }] }
  const phases = phasesSvg(tricky, true, true).source
  expect(phases).toContain('A &amp; &lt;B&gt; &quot;C&quot;')
  expect(phases).not.toContain('<B>')
  expect(phasesSvg(bar, true, true).source.length).toBeLessThan(131072)
})

// --- Through the module -------------------------------------------------------------------------

test('a narrow band drops the pill and keeps the bar, percent and close button', async ($, on) => {
  arrange(on, worldOf(running('login_20260101', 'Login flow', 'Write the parser')))
  await startSession($)

  const wide = await draw($, 'terminal', { bodyColumns: 100 })
  expect(await textOf(wide, /Write the parser/)).toBeDefined()
  await wide.unmount()

  const narrow = await draw($, 'terminal', { bodyColumns: 45 })
  expect(await textOf(narrow, /Write the parser/)).toBeUndefined()
  expect(await textOf(narrow, /Login flow/)).toBeDefined()
  expect(await textOf(narrow, /\b50%/)).toBeDefined()
  expect((await narrow.find({ key: KEYS.close('login_20260101') }))?.type).toBe('Button')
})

test('the rows cut to what the band allows, with a "+N more" text', async ($, on) => {
  const ids = ['a_20260101', 'b_20260101', 'c_20260101']
  arrange(on, worldOf(...ids.map((id) => running(id, 'Track ' + id))))
  await startSession($)

  // Two rows: one for a bar, one for the footer
  const ui = await draw($, 'terminal', { maxRows: 2 })

  expect(await ui.find({ key: KEYS.bar(ids[0]!) })).toBeDefined()
  expect(await ui.find({ key: KEYS.bar(ids[1]!) })).toBeUndefined()
  expect(await textOf(ui, /\+2 more/)).toBeDefined()
  expect((await ui.find({ key: KEYS.toggle }))?.type).toBe('Button')
})

test('the terminal shows a phase hover card with title, counts and checkpoint SHA', async ($, on) => {
  arrange(on, worldOf(running()))
  await startSession($)

  const ui = await draw($, 'terminal')

  expect(await textOf(ui, /Phase 1: Setup · 2\/2 tasks · checkpoint abc1234/)).toBeDefined()
  expect(await textOf(ui, /Phase 2: Parser · 0\/2 tasks\s*$/)).toBeDefined()
})

test('the desktop draws the bar and the phases as Svg, with the labels still in Text', async ($, on) => {
  arrange(on, worldOf(running()))
  await startSession($, 'desktop')

  const ui = await draw($, 'desktop')

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
  expect(await textOf(ui, /running/)).toBeDefined()
  expect(await textOf(ui, /\b50%/)).toBeDefined()
  expect(await textOf(ui, /Write the parser/)).toBeDefined()
})

test('a track that finishes during the session keeps its bar until it is closed', async ($, on) => {
  const id = 'login_20260101'
  const w = worldOf(running(id))
  const h = arrange(on, w)
  await startSession($)
  const ui = await draw($)
  expect(await ui.find({ key: KEYS.bar(id) })).toBeDefined()

  // The registry moves on to `completed`, which on its own would take the row away
  const done = finished(id)
  publish(w, { ...done, track: { ...done.track, status: 'completed' } })
  await h.clock.advance(REFRESH_MS)

  expect(await ui.find({ key: KEYS.bar(id) })).toBeDefined()
  expect(await textOf(ui, /done/)).toBeDefined()

  await ui.press({ key: KEYS.close(id) })
  expect(await ui.find({ key: KEYS.bar(id) })).toBeUndefined()
})

test('a track already completed when the session starts draws nothing', async ($, on) => {
  const id = 'old_20260101'
  const done = finished(id)
  arrange(on, worldOf({ ...done, track: { ...done.track, status: 'completed' } }))
  await startSession($)

  const ui = await draw($)

  expect(await ui.find({ key: KEYS.bar(id) })).toBeUndefined()
  expect(await ui.find({ key: KEYS.toggle })).toBeUndefined()
})
