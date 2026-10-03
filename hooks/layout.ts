// Conductor progress mod: how a track bar is laid out and styled.
//
// Pure functions only: they never touch `$`. The module (register.ts) resolves
// the elements (`Box`, `Text`, `Button`, `Svg`) and hands them in as plain
// arguments, with the callbacks a press runs, so every width, color and text
// rule here can be tested without a session.
//
// One row per track, in cells on the terminal (`Box`/`Text`) and with an `Svg`
// for the bar on the desktop. The columns line up from row to row:
//
//   ► running  Login flow  ━━━━━━ ━━━───────  50%  phase 2/2  Write the parser   ✕  9: Conductor ▾
//
// The bar has one segment per phase, sized by its task count and filled as its
// tasks complete; hovering a segment shows the phase's title, counts and
// checkpoint in place of the row's phase and task. The toggle sits at the end of the first row when it fits, else in
// a footer row of its own (which also carries "+N more"). Narrow bands degrade
// in a fixed order instead of overflowing: the phase tag goes first, then the
// bar shrinks, then the task, then the toggle moves to the footer, and the
// title shrinks last. The right edge keeps room for the band's own `[-]`.
//
// COLOR. Terminal colors are theme keys (`success`, `warning`, `suggestion`,
// `inactive`, `subtle`), so they follow the person's light, dark or colorblind
// theme instead of fixed hex values. The desktop Svg cannot read the theme: it
// carries a light and a dark palette and picks one with `prefers-color-scheme`.
// Each fill keeps at least 3:1 (the non-text minimum) against its page and
// against the empty track, checked by tests/mod/layout.test.ts. State is never
// color alone: every row writes a glyph and a word, and the percent.
import type { Capsule, TrackBar, TrackState } from './model.ts'

// --- Colors ---------------------------------------------------------------------------

/** Terminal theme key of each state: its glyph, its label and the bar's fill. */
export const STATE_COLOR: Record<TrackState, string> = {
  running: 'suggestion',
  needs_input: 'warning',
  done: 'success',
  idle: 'inactive',
}
/** Theme key of secondary text (the phase tag, a next task, the controls). */
export const MUTED_COLOR = 'inactive'
/** Theme key of the empty part of the bar: quieter than text, read by its glyph too. */
export const TRACK_KEY = 'subtle'

/** One desktop palette: the page it is drawn on, the empty track and the fills. */
export type SvgPalette = { page: string, track: string } & Record<TrackState, string>

export const SVG_LIGHT: SvgPalette = {
  page: '#FFFFFF',
  track: '#E5E7EB',
  running: '#2563EB',
  needs_input: '#B45309',
  done: '#15803D',
  idle: '#6B7280',
}
export const SVG_DARK: SvgPalette = {
  page: '#1F1F1F',
  track: '#3F3F46',
  running: '#60A5FA',
  needs_input: '#F59E0B',
  done: '#4ADE80',
  idle: '#A1A1AA',
}

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2.x contrast ratio of two `#RRGGBB` colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

// --- Words and glyphs -----------------------------------------------------------------

export const STATE_LABEL: Record<TrackState, string> = {
  running: 'running',
  needs_input: 'needs input',
  done: 'done',
  idle: 'idle',
}
export const STATE_GLYPH: Record<TrackState, string> = {
  running: '►',
  needs_input: '!',
  done: '✓',
  idle: '○',
}

/** The state text: glyph, then the label, so the state reads without color. */
export const stateText = (state: TrackState): string => `${STATE_GLYPH[state]} ${STATE_LABEL[state]}`

/** The toggle's label while the bars show and while they are hidden. */
export const TOGGLE_LABEL = { shown: 'Conductor ▾', hidden: 'Conductor ▸' }
/** The toggle's digit hotkey: a digit also fires from an empty prompt. */
export const TOGGLE_HOTKEY = '9'

const FILLED = '━'
const TIP = '╸'
const EMPTY = '─'

// --- Text helpers ---------------------------------------------------------------------

const length = (text: string): number => Array.from(text).length

const clip = (text: string, width: number): string => {
  const chars = Array.from(text)
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

/**
 * The title a row shows. Track descriptions tend to be a name, a colon and a
 * long explanation ("Progress mod: live bars, buttons and sounds"); the name
 * alone reads better in a row, so it is used when it is a sensible length.
 */
export function shortTitle(title: string): string {
  const cut = title.search(/:\s|\s[-–—]\s/)
  const head = cut > 0 ? title.slice(0, cut).trim() : ''
  return length(head) >= 4 && length(head) <= 40 ? head : title.trim()
}

/** A task as a row shows it: no `Task:` prefix, no trailing `(… workflow.md)` note. */
export function taskText(text: string): string {
  return text
    .replace(/^Task:\s*/, '')
    .replace(/\s*\([^()]*workflow\.md[^()]*\)\s*$/i, '')
    .trim()
}

/** The phase a row is on (`phase 2/3`), or null for a track without phases or a finished one. */
export function phaseTag(bar: TrackBar): string | null {
  if (bar.phases.length === 0 || bar.state === 'done') return null
  let index = bar.phases.findIndex((phase) => phase.state === 'active')
  if (index < 0) index = bar.phases.findIndex((phase) => phase.state !== 'done')
  if (index < 0) return null
  return `phase ${index + 1}/${bar.phases.length}`
}

/** What the row says the track is doing: its words, how to draw them, and a dim prefix. */
export type TaskLine = { prefix: string, text: string, color?: string, dim: boolean }

export function taskLine(bar: TrackBar): TaskLine | null {
  if (bar.state === 'done') {
    const tasks = bar.dots.length
    if (bar.phases.length === 0 || tasks === 0) return null
    const phases = bar.phases.length === 1 ? '1 phase' : `${bar.phases.length} phases`
    return { prefix: '', text: `${phases}, ${tasks} tasks complete`, dim: true }
  }
  if (bar.state === 'needs_input') {
    const phase = bar.pill?.phase ? ` ${bar.pill.phase}` : ''
    return { prefix: '', text: `waiting for you to verify${phase}`, color: STATE_COLOR.needs_input, dim: false }
  }
  if (bar.pill === null) return null
  const text = taskText(bar.pill.task)
  if (text === '') return null
  return bar.pill.kind === 'next' ? { prefix: 'next: ', text, dim: true } : { prefix: '', text, dim: false }
}

/** The hover text of a phase: title, completed/total counts and its checkpoint SHA. */
export function capsuleDetails(capsule: Capsule): string {
  const parts = [capsule.title || 'Phase ' + capsule.number, `${capsule.completed}/${capsule.total} tasks`]
  if (capsule.checkpoint) parts.push('checkpoint ' + capsule.checkpoint)
  return parts.join(' · ')
}

const PHASE_GLYPH: Record<Capsule['state'], string> = { done: '✓', active: '►', pending: '○' }

/**
 * The phase card a row shows over its phase and task while a run of the bar is
 * hovered: what matters most first, since a narrow row cuts the end.
 */
export function phaseCardText(capsule: Capsule): string {
  const parts = [`${PHASE_GLYPH[capsule.state]} ${capsule.completed}/${capsule.total}`, capsule.title || 'Phase ' + capsule.number]
  if (capsule.checkpoint) parts.push(capsule.checkpoint)
  return parts.join(' · ')
}

/** One line for a reader that cannot see the drawing. */
export function summary(bar: TrackBar): string {
  const done = bar.phases.filter((phase) => phase.state === 'done').length
  const phases = bar.phases.length > 0 ? `, ${done} of ${bar.phases.length} phases complete` : ''
  return `${bar.title}: ${STATE_LABEL[bar.state]}, ${bar.percent}%${phases}`
}

// --- The segmented bar ----------------------------------------------------------------

/** One run of the bar: a phase's share of the cells and how many of them are filled. */
export type Segment = {
  width: number
  filled: number
  /** 1 when the cell after the filled ones marks the task in progress, else 0. */
  tip: number
  /** Theme key of the filled cells. */
  color: string
  /** Fill state for the desktop palette. */
  tone: TrackState
  /** The phase it stands for; null when the bar has a single plain run. */
  phase: Capsule | null
}

// Splits `cells` among `weights` in proportion, at least one cell each (largest remainder)
function apportion(weights: number[], cells: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const spare = cells - weights.length
  const exact = weights.map((w) => (sum > 0 ? (w / sum) * spare : spare / weights.length))
  const sizes = exact.map((x) => 1 + Math.floor(x))
  let left = cells - sizes.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) sizes[order[k]!.i]! += 1
  return sizes
}

// Filled cells of a run: full only when every task is done, never full before
function filledCells(completed: number, total: number, width: number): number {
  if (total <= 0) return 0
  if (completed >= total) return width
  return Math.min(width - 1, Math.round((completed / total) * width))
}

function plainSegment(bar: TrackBar, width: number): Segment {
  const percent = Math.min(100, Math.max(0, Number.isFinite(bar.percent) ? bar.percent : 0))
  const filled = bar.state === 'done' ? width : filledCells(percent, 100, width)
  return { width, filled, tip: 0, color: STATE_COLOR[bar.state], tone: bar.state, phase: null }
}

/**
 * The runs of a bar `cells` wide, one per phase with tasks and one cell apart,
 * sized by task count. A bar without phases, or with too many phases for its
 * width, is one plain run filled to its percent. Widths and gaps add up to
 * exactly `cells`.
 */
export function segmentsOf(bar: TrackBar, cells: number): Segment[] {
  const width = Math.max(1, Math.floor(cells))
  const phases = bar.phases.filter((phase) => phase.total > 0)
  if (phases.length === 0 || phases.length * 3 - 1 > width) return [plainSegment(bar, width)]
  const sizes = apportion(
    phases.map((phase) => phase.total),
    width - (phases.length - 1),
  )
  return phases.map((phase, i) => {
    const complete = bar.state === 'done' || phase.state === 'done'
    const tone: TrackState = complete ? 'done' : bar.state
    const filled = complete ? sizes[i]! : filledCells(phase.completed, phase.total, sizes[i]!)
    // A task in progress in this phase shows as a tip after the filled cells
    const working = !complete && phase.state === 'active' && (bar.state === 'running' || bar.state === 'needs_input')
    return {
      width: sizes[i]!,
      filled,
      tip: working && filled < sizes[i]! ? 1 : 0,
      color: STATE_COLOR[tone],
      tone,
      phase,
    }
  })
}

/** The terminal text of a run: filled cells (with the tip, when it has one), then empty ones. */
export function segmentCells(segment: Segment): { filled: string, empty: string } {
  return {
    filled: FILLED.repeat(segment.filled) + TIP.repeat(segment.tip),
    empty: EMPTY.repeat(segment.width - segment.filled - segment.tip),
  }
}

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

const PX_PER_CELL = 8
const BAR_PX_HEIGHT = 8
const GAP_PX = 3

// The <style> that picks the palette: classes per fill, the dark set under the media query
function svgStyle(): string {
  const rules = (p: SvgPalette) =>
    `.t{fill:${p.track}}.running{fill:${p.running}}.needs_input{fill:${p.needs_input}}` +
    `.done{fill:${p.done}}.idle{fill:${p.idle}}`
  return `<style>${rules(SVG_LIGHT)}@media (prefers-color-scheme: dark){${rules(SVG_DARK)}}</style>`
}

/**
 * The desktop bar: the same runs as the terminal's, 8 px per cell, rounded,
 * each run with a hover `<title>` naming its phase. Small and valid.
 */
export function barSvg(bar: TrackBar, cells: number): { source: string, width: number, height: number } {
  const segments = segmentsOf(bar, cells)
  const width = Math.max(1, Math.floor(cells)) * PX_PER_CELL
  const gaps = segments.length - 1
  const usable = width - gaps * GAP_PX
  const total = segments.reduce((sum, s) => sum + s.width, 0)
  const r = BAR_PX_HEIGHT / 2
  let x = 0
  let body = ''
  segments.forEach((segment, i) => {
    const w = i === segments.length - 1 ? width - x : Math.round((segment.width / total) * usable)
    const fill = segment.width > 0 ? Math.round((segment.filled / segment.width) * w) : 0
    const tip = segment.width > 0 ? Math.round(((segment.filled + segment.tip) / segment.width) * w) : 0
    const title = segment.phase ? `<title>${escapeXml(capsuleDetails(segment.phase))}</title>` : ''
    body +=
      `<g>${title}<rect class="t" x="${x}" width="${w}" height="${BAR_PX_HEIGHT}" rx="${r}"/>` +
      (tip > fill ? `<rect class="${segment.tone}" opacity="0.45" x="${x}" width="${tip}" height="${BAR_PX_HEIGHT}" rx="${r}"/>` : '') +
      (fill > 0 ? `<rect class="${segment.tone}" x="${x}" width="${fill}" height="${BAR_PX_HEIGHT}" rx="${r}"/>` : '') +
      '</g>'
    x += w + GAP_PX
  })
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_PX_HEIGHT}" ` +
    `viewBox="0 0 ${width} ${BAR_PX_HEIGHT}">${svgStyle()}${body}</svg>`
  return { source, width, height: BAR_PX_HEIGHT }
}

// --- Width planning -------------------------------------------------------------------

/** Longest title drawn in full; a longer one is cut with an ellipsis. */
export const TITLE_MAX = 32
/** The least room worth giving a title or a task. */
export const TITLE_MIN = 6
export const TASK_MIN = 12
export const TASK_MAX = 72
/** The widest bar: room left once the task is whole goes to the bar, up to this. */
export const BAR_MAX = 40
/** Cells kept free at the right edge for the band's own `[-]` marker. */
export const RIGHT_GUTTER = 4
/** Cells between two parts of a row. */
export const GAP = 2

const PCT_W = 4
const CLOSE_W = 1
const PHASE_W = 'phase 9/9'.length
const TOGGLE_W = `${TOGGLE_HOTKEY}: ${TOGGLE_LABEL.shown}`.length

/** What every row of the band draws, and how wide; the same for all rows so they line up. */
export type BandPlan = {
  stateWidth: number
  titleWidth: number
  barWidth: number
  /** 0 when the phase tag is dropped. */
  phaseWidth: number
  /** 0 when the task is dropped. */
  taskWidth: number
  /** True when the toggle ends the first row; false puts it in the footer. */
  toggleInline: boolean
}

/**
 * Decides what fits in `columns` cells for these rows. Parts drop or shrink in a
 * fixed order (phase tag, bar, task, inline toggle, bar again), then the title
 * shrinks. While the bare row (state, a short title, bar, percent, close) fits,
 * the parts and their gaps never take more than `columns - RIGHT_GUTTER`.
 */
export function planBand(rows: TrackBar[], columns: number): BandPlan {
  const width = (Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80) - RIGHT_GUTTER
  const stateWidth = Math.max(1, ...rows.map((bar) => stateText(bar.state).length))
  const titleFull = Math.min(TITLE_MAX, Math.max(1, ...rows.map((bar) => length(shortTitle(bar.title)))))
  const taskFull = Math.min(
    TASK_MAX,
    Math.max(0, ...rows.map((bar) => {
      const line = taskLine(bar)
      return line ? length(line.prefix + line.text) : 0
    })),
  )
  const hasPhase = rows.some((bar) => phaseTag(bar) !== null)
  const ideal = width >= 120 ? 24 : width >= 80 ? 18 : 14

  type Tier = { bar: number, phase: boolean, task: boolean, toggle: boolean }
  const used = (title: number, tier: Tier): number => {
    const sizes = [stateWidth, title, tier.bar, PCT_W, CLOSE_W]
    if (tier.phase) sizes.push(PHASE_W)
    if (tier.task) sizes.push(Math.min(taskFull, TASK_MIN))
    if (tier.toggle) sizes.push(TOGGLE_W)
    return sizes.reduce((sum, size) => sum + size, 0) + GAP * (sizes.length - 1)
  }
  const withTask = taskFull > 0
  const tiers: Tier[] = [
    { bar: ideal, phase: hasPhase, task: withTask, toggle: true },
    { bar: ideal, phase: false, task: withTask, toggle: true },
    { bar: 12, phase: false, task: withTask, toggle: true },
    { bar: 12, phase: false, task: false, toggle: true },
    { bar: 12, phase: false, task: false, toggle: false },
    { bar: 8, phase: false, task: false, toggle: false },
  ]
  for (const tier of tiers) {
    if (used(titleFull, tier) > width) continue
    // Room left over goes to the task until it is whole, then to the bar, and
    // what is still left widens the task's region: the controls end the row at
    // the right edge, and the phase cards drawn over that region get it all
    let spare = width - used(titleFull, tier)
    const taskMin = Math.min(taskFull, TASK_MIN)
    let taskWidth = tier.task ? Math.min(taskFull, taskMin + spare) : 0
    if (tier.task) spare -= taskWidth - taskMin
    const grow = Math.max(0, Math.min(BAR_MAX - tier.bar, spare))
    const barWidth = tier.bar + grow
    spare -= grow
    if (tier.task) taskWidth += spare
    return {
      stateWidth,
      titleWidth: titleFull,
      barWidth,
      phaseWidth: tier.phase ? PHASE_W : 0,
      taskWidth,
      toggleInline: tier.toggle,
    }
  }
  // Nothing optional left: the title takes what remains
  const bare: Tier = { bar: 8, phase: false, task: false, toggle: false }
  const titleWidth = Math.max(1, Math.min(titleFull, width - used(0, bare)))
  return { stateWidth, titleWidth, barWidth: 8, phaseWidth: 0, taskWidth: 0, toggleInline: false }
}

/**
 * How many bar rows to draw out of `candidates`, at most `max`: a footer row is
 * kept when the toggle cannot sit on the first row or when rows are cut.
 */
export function rowCapacity(maxRows: number, candidates: number, toggleInline: boolean, max = 3): number {
  const rows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 12
  const fitsAll = candidates <= Math.min(max, rows)
  if (toggleInline && fitsAll) return candidates
  return Math.max(0, Math.min(max, candidates, rows - 1))
}

// --- Elements ----------------------------------------------------------------------------

/** The element constructors of the surface, as `$.ui.resolve(e)` returns them. */
export type UiElements = { Box: any, Text: any, Button: any, Svg?: any }

export type BandInput = {
  ui: UiElements
  /** True when `Svg` draws the bars (the desktop), false for `Box`/`Text` characters. */
  desktop: boolean
  /** `props.bodyColumns`. */
  columns: number
  /** The rows to draw (already cut to what fits). */
  rows: TrackBar[]
  /** Bars left out for lack of room; drawn as "+N more". */
  more: number
  /** False while the bars are hidden: only the footer row is drawn. */
  showBars: boolean
  /** The engine's own drawing from `await next(e)`, embedded exactly once. */
  engine: unknown
  onClose: (bar: TrackBar) => void
  onToggle: () => void
}

function cell(Box: any, width: number, child: unknown, key?: string) {
  return Box({ ...(key ? { key } : {}), width, flexShrink: 0, children: [child] })
}

function toggleButton(input: BandInput) {
  return input.ui.Button({
    key: 'toggle',
    label: input.showBars ? TOGGLE_LABEL.shown : TOGGLE_LABEL.hidden,
    hotkey: TOGGLE_HOTKEY,
    plain: true,
    dimColor: true,
    onPress: () => input.onToggle(),
  })
}

// The hover group that ties a run of the bar to its phase card (64 characters at most)
const phaseScope = (bar: TrackBar, index: number): string => `phase:${index}:${bar.id}`.slice(0, 64)

// One run of the terminal bar. Each cell joins the run's hover group: the
// pointer on it lights the run (the empty cells brighten) and reveals the
// phase card that buildRow lays over the row's phase and task.
function terminalSegment(ui: UiElements, bar: TrackBar, segment: Segment, index: number) {
  const { Box, Text } = ui
  const cells = segmentCells(segment)
  const scope = segment.phase === null ? null : phaseScope(bar, index)
  const lit = (color: string) => (scope === null ? {} : { hover: { scope, color } })
  return Box({
    flexShrink: 0,
    children: [
      ...(cells.filled !== '' ? [Text({ color: segment.color, ...lit(segment.color), children: [cells.filled] })] : []),
      ...(cells.empty !== '' ? [Text({ color: TRACK_KEY, ...lit(MUTED_COLOR), children: [cells.empty] })] : []),
    ],
  })
}

// The phase cards of a row: drawn hidden over the row's phase and task, one per
// run, each shown while its run is hovered. Padded to the full width so the card
// covers the words beneath it. Inside the row, so the band never clips it.
function phaseCards(ui: UiElements, bar: TrackBar, segments: Segment[], width: number) {
  const { Box, Text } = ui
  const cards: unknown[] = []
  segments.forEach((segment, index) => {
    if (segment.phase === null) return
    const words = clip(phaseCardText(segment.phase), width).padEnd(width)
    cards.push(
      Box({
        position: 'absolute',
        top: 0,
        left: 0,
        display: 'none',
        hover: { scope: phaseScope(bar, index), display: 'flex' },
        children: [Text({ bold: true, wrap: 'truncate-end', children: [words] })],
      }),
    )
  })
  return cards
}

function barElement(input: BandInput, bar: TrackBar, width: number) {
  const { Box, Svg } = input.ui
  if (input.desktop && typeof Svg === 'function') {
    const drawn = barSvg(bar, width)
    return Svg({ source: drawn.source, alt: summary(bar), width: drawn.width, height: drawn.height, isInteractive: true })
  }
  return Box({
    flexShrink: 0,
    columnGap: 1,
    children: segmentsOf(bar, width).map((segment, index) => terminalSegment(input.ui, bar, segment, index)),
  })
}

/** One track's row. `first` rows end with the toggle when the plan puts it inline. */
export function buildRow(input: BandInput, bar: TrackBar, plan: BandPlan, first: boolean) {
  const { Box, Text, Button } = input.ui
  const color = STATE_COLOR[bar.state]
  const parts: unknown[] = [
    cell(Box, plan.stateWidth, Text({ color, bold: true, children: [stateText(bar.state)] })),
    cell(Box, plan.titleWidth, Text({ bold: true, wrap: 'truncate-end', children: [shortTitle(bar.title)] })),
    barElement(input, bar, plan.barWidth),
    cell(Box, PCT_W, Text({ ...(bar.state === 'done' ? { color } : {}), children: [`${bar.percent}%`.padStart(PCT_W)] })),
  ]

  // The phase tag and the task share one region, where the phase cards open
  const info: unknown[] = []
  if (plan.phaseWidth > 0) {
    info.push(cell(Box, plan.phaseWidth, Text({ color: MUTED_COLOR, children: [phaseTag(bar) ?? ''] })))
  }
  const line = taskLine(bar)
  if (plan.taskWidth > 0) {
    const words = line
      ? [
          ...(line.prefix !== '' ? [Text({ color: MUTED_COLOR, children: [line.prefix] })] : []),
          Text({
            ...(line.dim ? { color: MUTED_COLOR } : line.color ? { color: line.color } : {}),
            wrap: 'truncate-end',
            children: [clip(line.text, Math.max(1, plan.taskWidth - length(line.prefix)))],
          }),
        ]
      : []
    info.push(Box({ width: plan.taskWidth, flexShrink: 0, children: words }))
  }
  if (info.length > 0) {
    const width = plan.phaseWidth + plan.taskWidth + (info.length > 1 ? GAP : 0)
    const terminal = !(input.desktop && typeof input.ui.Svg === 'function')
    const cards = terminal ? phaseCards(input.ui, bar, segmentsOf(bar, plan.barWidth), width) : []
    parts.push(Box({ width, flexShrink: 0, columnGap: GAP, children: [...info, ...cards] }))
  }

  parts.push(
    Button({ key: `close-${bar.id}`, label: '✕', plain: true, dimColor: true, onPress: () => input.onClose(bar) }),
  )
  if (plan.toggleInline) {
    parts.push(first ? toggleButton(input) : Box({ width: TOGGLE_W, flexShrink: 0 }))
  }
  return Box({ key: `bar-${bar.id}`, flexDirection: 'row', columnGap: GAP, children: parts })
}

/** The hidden band's one line: the toggle and a dim word on the first track. */
function hiddenLine(input: BandInput) {
  const { Box, Text } = input.ui
  const first = input.rows[0]
  const children: unknown[] = [toggleButton(input)]
  if (first) {
    const words = `${STATE_GLYPH[first.state]} ${clip(shortTitle(first.title), TITLE_MAX)} ${first.percent}%`
    children.push(Text({ color: MUTED_COLOR, wrap: 'truncate-end', children: [words] }))
  }
  if (input.more > 0 || input.rows.length > 1) {
    const others = input.more + Math.max(0, input.rows.length - 1)
    children.push(Text({ color: MUTED_COLOR, children: [`+${others} more`] }))
  }
  return Box({ flexDirection: 'row', columnGap: GAP, children })
}

/**
 * The whole band: the bar rows, a footer when it is needed ("+N more", or the
 * toggle when it does not fit on the first row), then the engine's own drawing.
 * Never throws away `input.engine`.
 */
export function buildBand(input: BandInput) {
  const { Box, Text } = input.ui
  if (!input.showBars) {
    return Box({ flexDirection: 'column', children: [hiddenLine(input), input.engine] })
  }
  const plan = planBand(input.rows, input.columns)
  const footer: unknown[] = []
  if (!plan.toggleInline) footer.push(toggleButton(input))
  if (input.more > 0) footer.push(Text({ color: MUTED_COLOR, children: [`+${input.more} more`] }))
  const hasFooter = footer.length > 0
  const rows = input.rows.map((bar, index) => buildRow(input, bar, plan, index === 0))
  return Box({
    flexDirection: 'column',
    children: [...rows, ...(hasFooter ? [Box({ flexDirection: 'row', columnGap: GAP, children: footer })] : []), input.engine],
  })
}
