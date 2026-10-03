// Tests for the row layout (hooks/layout.ts, pure) and for the drawing rules the
// module scenarios in module.test.ts leave open: palette contrast, the segmented
// bar, narrow-width degradation, the row cut-off, phase hover details, the desktop
// Svg, and the bars of tracks that finish during the session.
import { expect, test } from 'claude-code/testing'
import * as fx from './fixtures.ts'
import { buildBar, parseStatus } from '../../hooks/model.ts'
import {
  barSvg,
  capsuleDetails,
  contrastRatio,
  GAP,
  phaseCardText,
  phaseTag,
  planBand,
  RIGHT_GUTTER,
  rowCapacity,
  segmentCells,
  segmentsOf,
  shortTitle,
  STATE_COLOR,
  STATE_GLYPH,
  STATE_LABEL,
  stateText,
  SVG_DARK,
  SVG_LIGHT,
  taskLine,
  taskText,
} from '../../hooks/layout.ts'
import {
  arrange,
  draw,
  finished,
  KEYS,
  needsInput,
  publish,
  REFRESH_MS,
  running,
  startSession,
  textOf,
  worldOf,
} from './module-helpers.ts'

const barOf = (status: unknown) => buildBar(parseStatus(fx.stdout(status))!)
const STATES = ['running', 'needs_input', 'done', 'idle'] as const

// --- Colors --------------------------------------------------------------------------------

test('every desktop fill keeps 3:1 against its page and against the empty track', () => {
  for (const palette of [SVG_LIGHT, SVG_DARK]) {
    for (const state of STATES) {
      expect(contrastRatio(palette[state], palette.page), state).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(palette[state], palette.track), state).toBeGreaterThanOrEqual(3)
    }
  }
})

test('the terminal colors are theme keys, so they follow the person\'s theme', () => {
  for (const state of STATES) expect(STATE_COLOR[state]).toMatch(/^[a-z][A-Za-z]+$/)
  expect(new Set(STATES.map((s) => STATE_COLOR[s])).size).toBe(4)
})

test('the contrast function matches the known extremes', () => {
  expect(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21)).toBeLessThan(1e-9)
  expect(Math.abs(contrastRatio('#777777', '#777777') - 1)).toBeLessThan(1e-9)
})

test('every state has its own glyph and a word, so color is never the only signal', () => {
  expect(new Set(STATES.map((s) => STATE_GLYPH[s])).size).toBe(4)
  expect(new Set(STATES.map((s) => STATE_LABEL[s])).size).toBe(4)
  expect(stateText('needs_input')).toBe('! needs input')
})

// --- Words ---------------------------------------------------------------------------------

test('a title keeps the name before its colon, when that name is a sensible length', () => {
  expect(shortTitle('Conductor progress mod: live bars, a button and sounds')).toBe('Conductor progress mod')
  expect(shortTitle('Login flow - rework the parser')).toBe('Login flow')
  expect(shortTitle('Login flow')).toBe('Login flow')
  // Too short a head, or none: the whole title
  expect(shortTitle('UI: rework the band')).toBe('UI: rework the band')
  expect(shortTitle('  Plain title  ')).toBe('Plain title')
})

test('a task loses its "Task:" prefix and a trailing workflow.md note', () => {
  expect(taskText('Task: Write the parser')).toBe('Write the parser')
  expect(taskText('Task: Phase Verification & Checkpoint (Refer to workflow.md)')).toBe('Phase Verification & Checkpoint')
  expect(taskText('Keep (these) words')).toBe('Keep (these) words')
})

test('the task line says what the track is doing in each state', () => {
  expect(taskLine(barOf(running()))).toMatchObject({ prefix: '', text: 'Write the parser', dim: false })
  expect(taskLine(barOf(needsInput()))?.text).toBe('waiting for you to verify Phase 2: Parser')
  expect(taskLine(barOf(finished()))?.text).toBe('2 phases, 4 tasks complete')
  // Between tasks: the next one, dimmed with a prefix
  const idle = barOf(fx.statusObject(
    { id: 'idle_20260101', description: 'Idle', status: 'in_progress' },
    [fx.phase(1, 'Phase 1: Setup', { completed: 1, pending: 1 })],
    null,
    fx.taskView(2, 'Task: Next thing', 'pending', 'Phase 1: Setup', 1),
  ))
  expect(taskLine(idle)).toMatchObject({ prefix: 'next: ', text: 'Next thing', dim: true })
})

test('the phase tag counts the phase the track is on', () => {
  expect(phaseTag(barOf(running()))).toBe('phase 2/2')
  expect(phaseTag(barOf(finished()))).toBeNull()
})

test('the hover texts name the phase, its counts and its checkpoint when it has one', () => {
  const base = { number: 1, title: 'Phase 1: Setup', completed: 2, total: 3, state: 'active' as const }
  expect(capsuleDetails({ ...base, checkpoint: 'abc1234' })).toBe('Phase 1: Setup · 2/3 tasks · checkpoint abc1234')
  expect(capsuleDetails({ ...base, checkpoint: null })).toBe('Phase 1: Setup · 2/3 tasks')
  // The in-row card puts the counts first, since a narrow row cuts the end
  expect(phaseCardText({ ...base, checkpoint: 'abc1234' })).toBe('► 2/3 · Phase 1: Setup · abc1234')
  expect(phaseCardText({ ...base, state: 'done', completed: 3, checkpoint: null })).toBe('✓ 3/3 · Phase 1: Setup')
})

// --- The segmented bar ---------------------------------------------------------------------

test('the bar has one run per phase, sized by tasks, filling exactly its width', () => {
  const bar = barOf(running())
  for (const cells of [6, 12, 18, 40]) {
    const segments = segmentsOf(bar, cells)
    expect(segments).toHaveLength(2)
    const used = segments.reduce((sum, s) => sum + s.width, 0) + segments.length - 1
    expect(used, `cells ${cells}`).toBe(cells)
  }
  // Phase 1 is done (filled, success color); phase 2 has none done yet
  const [setup, parser] = segmentsOf(bar, 18)
  expect(setup!.filled).toBe(setup!.width)
  expect(setup!.color).toBe(STATE_COLOR.done)
  expect(parser!.filled).toBe(0)
  expect(parser!.color).toBe(STATE_COLOR.running)
  // The task in progress shows as a tip on the active phase only
  expect(parser!.tip).toBe(1)
  expect(setup!.tip).toBe(0)
  expect(segmentsOf(barOf(finished()), 18).every((s) => s.tip === 0)).toBe(true)
})

test('a run is never shown full before its phase is done, nor empty-looking when done', () => {
  const bar = barOf(fx.statusObject(
    { id: 'x_20260101', description: 'X', status: 'in_progress' },
    [fx.phase(1, 'Phase 1', { completed: 9, in_progress: 1 })],
    fx.taskView(10, 'Task: Last', 'in_progress', 'Phase 1', 1),
    null,
  ))
  const [only] = segmentsOf(bar, 8)
  expect(only!.filled).toBe(7)
  const done = segmentsOf(barOf(finished()), 8)
  expect(done.every((s) => s.filled === s.width)).toBe(true)
})

test('a bar without phases, or with too many for its width, is one plain run at its percent', () => {
  const plain = { ...barOf(running()), phases: [], percent: 50 }
  expect(segmentsOf(plain, 10)).toEqual([{ width: 10, filled: 5, tip: 0, color: STATE_COLOR.running, tone: 'running', phase: null }])
  expect(segmentsOf(barOf(running()), 4)).toHaveLength(1)
  expect(segmentCells({ width: 5, filled: 2, tip: 0, color: 'x', tone: 'idle', phase: null })).toEqual({ filled: '━━', empty: '───' })
  expect(segmentCells({ width: 5, filled: 2, tip: 1, color: 'x', tone: 'running', phase: null })).toEqual({ filled: '━━╸', empty: '──' })
})

test('the desktop bar is small valid SVG with escaped titles and a dark palette', () => {
  const bar = barOf(running())
  const drawn = barSvg(bar, 12)
  expect(drawn.source.startsWith('<svg ')).toBe(true)
  expect(drawn.source.endsWith('</svg>')).toBe(true)
  expect(drawn.width).toBe(96)
  expect(drawn.source).toContain('prefers-color-scheme: dark')
  expect(drawn.source).toContain('<title>Phase 1: Setup · 2/2 tasks · checkpoint abc1234</title>')

  const tricky = { ...bar, phases: [{ ...bar.phases[0]!, title: 'A & <B> "C"' }, bar.phases[1]!] }
  const source = barSvg(tricky, 12).source
  expect(source).toContain('A &amp; &lt;B&gt; &quot;C&quot;')
  expect(source).not.toContain('<B>')
  expect(source.length).toBeLessThan(131072)
})

// --- Width planning ------------------------------------------------------------------------

// The cells a plan takes on one row: every part, one GAP apart
function usedBy(plan: ReturnType<typeof planBand>): number {
  const sizes = [plan.stateWidth, plan.titleWidth, plan.barWidth, 4, 1]
  if (plan.phaseWidth > 0 || plan.taskWidth > 0) {
    sizes.push(plan.phaseWidth + plan.taskWidth + (plan.phaseWidth > 0 && plan.taskWidth > 0 ? GAP : 0))
  }
  if (plan.toggleInline) sizes.push('9: Conductor ▾'.length)
  return sizes.reduce((a, b) => a + b, 0) + GAP * (sizes.length - 1)
}

test('a wide band keeps everything; narrower ones drop the phase tag, then the task, then move the toggle', () => {
  const rows = [barOf(running('login_20260101', 'Login flow', 'Write the parser'))]
  let last = { phase: true, task: true, toggle: true }
  for (let columns = 160; columns >= 30; columns--) {
    const plan = planBand(rows, columns)
    const now = { phase: plan.phaseWidth > 0, task: plan.taskWidth > 0, toggle: plan.toggleInline }
    // A part that was dropped never comes back on a narrower band
    for (const part of ['phase', 'task', 'toggle'] as const) expect(last[part] || !now[part], `${part} at ${columns}`).toBe(true)
    // The phase tag goes first, then the task, then the inline toggle
    if (now.phase) expect(now.task && now.toggle).toBe(true)
    if (now.task) expect(now.toggle).toBe(true)
    last = now
  }
  expect(planBand(rows, 140)).toMatchObject({ toggleInline: true })
  expect(planBand(rows, 140).phaseWidth).toBeGreaterThan(0)
  expect(planBand(rows, 140).taskWidth).toBeGreaterThanOrEqual('Write the parser'.length)
  expect(planBand(rows, 45)).toMatchObject({ phaseWidth: 0, taskWidth: 0, toggleInline: false })
})

test('the planned widths, with the gutter for the band marker, never exceed the band', () => {
  const rows = [
    barOf(running('login_20260101', 'A very long track title that must be cut somewhere', 'A long task name too')),
    barOf(needsInput('other_20260101', 'Other')),
  ]
  for (let columns = 40; columns <= 200; columns++) {
    expect(usedBy(planBand(rows, columns)) + RIGHT_GUTTER, `columns ${columns}`).toBeLessThanOrEqual(columns)
  }
})

test('room left over goes to the task, then to the bar, then fills the row to the controls', () => {
  const rows = [barOf(running())]
  const wide = planBand(rows, 200)
  expect(wide.phaseWidth + GAP + wide.taskWidth).toBeGreaterThanOrEqual(phaseCardText(rows[0]!.phases[0]!).length)
  // With the task shown, the row ends exactly at the gutter: the controls line up at the right
  for (const columns of [100, 140, 200]) expect(usedBy(planBand(rows, columns)) + RIGHT_GUTTER).toBe(columns)
  expect(planBand(rows, 100).barWidth).toBeGreaterThanOrEqual(18)
  expect(planBand(rows, 200).barWidth).toBe(40)
  expect(planBand(rows, 50).barWidth).toBeGreaterThanOrEqual(8)
})

test('the rows cut to the band, keeping a footer row only when it is needed', () => {
  // The toggle on the first row and every candidate fits: no footer
  expect(rowCapacity(12, 2, true)).toBe(2)
  // More candidates than the most rows: a footer for "+N more"
  expect(rowCapacity(12, 5, true)).toBe(3)
  // The toggle in the footer: one row less
  expect(rowCapacity(3, 3, false)).toBe(2)
  expect(rowCapacity(2, 3, true)).toBe(1)
  expect(rowCapacity(1, 1, true)).toBe(1)
  expect(rowCapacity(1, 1, false)).toBe(0)
  expect(rowCapacity(0, 1, true)).toBe(0)
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

test('the terminal row holds a phase card per run, with counts, title and checkpoint SHA', async ($, on) => {
  arrange(on, worldOf(running()))
  await startSession($)

  // Wide enough for the whole card; a narrower row cuts its end
  const ui = await draw($, 'terminal', { bodyColumns: 140 })

  expect(await textOf(ui, /✓ 2\/2 · Phase 1: Setup · abc1234/)).toBeDefined()
  expect(await textOf(ui, /► 0\/2 · Phase 2: Parser\s*$/)).toBeDefined()
})

test('the desktop draws the bar as one Svg, with the labels still in Text', async ($, on) => {
  arrange(on, worldOf(running()))
  await startSession($, 'desktop')

  const ui = await draw($, 'desktop')

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
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
