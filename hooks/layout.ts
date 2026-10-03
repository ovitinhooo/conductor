// Conductor progress mod: how a track bar is laid out and styled.
//
// Pure functions only: they never touch `$`. The module (register.ts) resolves
// the elements (`Box`, `Text`, `Button`, `Svg`) and hands them in as plain
// arguments, with the callbacks a press runs, so every width, color and text
// rule here can be tested without a session.
//
// One row per track, in cells on the terminal (`Box`/`Text`, block characters) and
// with an `Svg` for the bar, the phase capsules and the task dots on the desktop:
//
//   [glyph label]  title  [=====-----] 50%  [capsules] [dots]  pill  [close]
//
// Narrow bands degrade in a fixed order instead of overflowing: the pill goes
// first, then the dots, then the capsules; the title shrinks last.
//
// PALETTE (WCAG contrast of the label text on its chip, computed by
// `contrastRatio`, and checked by tests/mod/layout.test.ts):
//   running      #FFFFFF on #1D4ED8  6.70:1
//   needs input  #FFFFFF on #B45309  5.02:1
//   done         #FFFFFF on #15803D  5.02:1
//   idle         #FFFFFF on #4B5563  7.56:1
//   hover card   #F9FAFB on #1F2937 14.05:1
// The bar fill reuses the chip color, drawn on the neutral track #D1D5DB, which
// keeps at least 3:1 (the non-text minimum). State is never color alone: every
// chip carries a glyph and a word, and the percent is always written out.
import type { Capsule, Dot, TrackBar, TrackState } from './model.ts'

// --- Palette -----------------------------------------------------------------------

export type Swatch = { bg: string, fg: string }

export const PALETTE: Record<TrackState, Swatch> = {
  running: { bg: '#1D4ED8', fg: '#FFFFFF' },
  needs_input: { bg: '#B45309', fg: '#FFFFFF' },
  done: { bg: '#15803D', fg: '#FFFFFF' },
  idle: { bg: '#4B5563', fg: '#FFFFFF' },
}
/** The empty part of a progress bar. */
export const TRACK_COLOR = '#D1D5DB'
/** The hover card shown over a phase capsule on the terminal. */
export const CARD: Swatch = { bg: '#1F2937', fg: '#F9FAFB' }

/** Capsule colors: a finished phase is green, the active one blue, the rest gray. */
const CAPSULE: Record<Capsule['state'], Swatch> = {
  done: PALETTE.done,
  active: PALETTE.running,
  pending: PALETTE.idle,
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
const CAPSULE_GLYPH: Record<Capsule['state'], string> = { done: '✓', active: '►', pending: '·' }
const DOT_GLYPH: Record<Dot['status'], string> = { completed: '●', in_progress: '◐', pending: '○' }

/** The chip text: glyph, then the label, so the state reads without color. */
export const chipText = (state: TrackState): string => ` ${STATE_GLYPH[state]} ${STATE_LABEL[state]} `

// --- Width planning -------------------------------------------------------------------

/** Longest title drawn in full; a longer one is cut with an ellipsis. */
export const TITLE_MAX = 24
/** The least room worth giving a title or a pill. */
export const TITLE_MIN = 6
export const PILL_MIN = 14
export const PILL_MAX = 40
/** Task dots beyond this many are grouped so a long plan never fills the row. */
export const MAX_DOTS = 20

const PCT_W = 4
const CLOSE_W = 5
// Terminal: a capsule is ` ✓1 ` (4 cells). Desktop: 30 px wide, 8 px per cell.
const CAPSULE_CELLS = 4
const CAPSULE_PX = 30
const DOT_PX = 12
const PX_PER_CELL = 8

export type RowPlan = {
  barWidth: number
  titleWidth: number
  /** 0 when the pill is dropped. */
  pillWidth: number
  capsules: boolean
  dots: boolean
}

/** Dots to draw: the plan's own, or MAX_DOTS groups when there are more. */
export function compressDots(dots: Dot[], max: number = MAX_DOTS): Dot[] {
  if (dots.length <= max) return dots
  const grouped: Dot[] = []
  for (let i = 0; i < max; i++) {
    const slice = dots.slice(Math.floor((i * dots.length) / max), Math.floor(((i + 1) * dots.length) / max))
    const every = (status: Dot['status']) => slice.every((dot) => dot.status === status)
    const status: Dot['status'] = every('completed') ? 'completed' : every('pending') ? 'pending' : 'in_progress'
    grouped.push({ status, phase: slice[0]!.phase, title: slice.find((dot) => dot.title !== null)?.title ?? null })
  }
  return grouped
}

function capsulesWidth(count: number, desktop: boolean): number {
  if (count === 0) return 0
  return desktop ? Math.ceil((count * (CAPSULE_PX + 4)) / PX_PER_CELL) : count * CAPSULE_CELLS + (count - 1)
}

function dotsWidth(count: number, desktop: boolean): number {
  if (count === 0) return 0
  return desktop ? Math.ceil((count * DOT_PX + 8) / PX_PER_CELL) : count
}

/**
 * Decides what fits in `columns` cells: the bar shrinks on narrow bands, then
 * the pill, the dots and the capsules drop in that order, then the title
 * shrinks. The widths of what stays always add up to at most `columns`, except
 * when even the bare row (chip, bar, percent, close) is wider, which only a
 * band under about 30 cells can be.
 */
export function planRow(bar: TrackBar, columns: number, desktop = false): RowPlan {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80
  const barWidth = width >= 60 ? 12 : width >= 40 ? 8 : 5
  const titleFull = Math.min(Array.from(bar.title).length, TITLE_MAX)
  const capsulesW = capsulesWidth(bar.phases.length, desktop)
  const dotsW = dotsWidth(Math.min(bar.dots.length, MAX_DOTS), desktop)
  const pillFull = bar.pill ? Math.min(Array.from(bar.pill.text).length, PILL_MAX) : 0

  // Row width for a choice of parts: the elements are separated by one cell
  const total = (title: number, parts: { capsules: boolean, dots: boolean, pill: number }): number => {
    const sizes = [chipText(bar.state).length, Math.max(title, 1), barWidth, PCT_W, CLOSE_W]
    if (parts.capsules) sizes.push(capsulesW)
    if (parts.dots) sizes.push(dotsW)
    if (parts.pill > 0) sizes.push(parts.pill)
    return sizes.reduce((sum, size) => sum + size, 0) + sizes.length - 1
  }

  const tiers = [
    { capsules: capsulesW > 0, dots: dotsW > 0, pill: pillFull > 0 ? PILL_MIN : 0 },
    { capsules: capsulesW > 0, dots: dotsW > 0, pill: 0 },
    { capsules: capsulesW > 0, dots: false, pill: 0 },
    { capsules: false, dots: false, pill: 0 },
  ]
  for (const tier of tiers) {
    if (total(titleFull, tier) > width) continue
    const rest = width - total(titleFull, { ...tier, pill: 0 })
    const pillWidth = tier.pill > 0 ? Math.min(pillFull, rest - 1) : 0
    return { barWidth, titleWidth: titleFull, pillWidth, capsules: tier.capsules, dots: tier.dots }
  }
  // Nothing optional left: the title takes what remains
  const bare = { capsules: false, dots: false, pill: 0 }
  const titleWidth = Math.max(1, Math.min(titleFull, width - (total(1, bare) - 1)))
  return { barWidth, titleWidth, pillWidth: 0, capsules: false, dots: false }
}

/** How many bar rows fit: the band's rows less the footer row, at most `max`. */
export function rowCapacity(maxRows: number, max = 3): number {
  const rows = Number.isFinite(maxRows) ? Math.floor(maxRows) : 12
  return Math.max(0, Math.min(max, rows - 1))
}

// --- Text helpers ---------------------------------------------------------------------

const clip = (text: string, width: number): string => {
  const chars = Array.from(text)
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

/** The hover text of a phase: title, completed/total counts and its checkpoint SHA. */
export function capsuleDetails(capsule: Capsule): string {
  const parts = [capsule.title || 'Phase ' + capsule.number, `${capsule.completed}/${capsule.total} tasks`]
  if (capsule.checkpoint) parts.push('checkpoint ' + capsule.checkpoint)
  return parts.join(' · ')
}

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

/** One line for a reader that cannot see the drawing. */
export function summary(bar: TrackBar): string {
  const done = bar.phases.filter((phase) => phase.state === 'done').length
  const phases = bar.phases.length > 0 ? `, ${done} of ${bar.phases.length} phases complete` : ''
  return `${bar.title}: ${STATE_LABEL[bar.state]}, ${bar.percent}%${phases}`
}

// --- The progress bar -------------------------------------------------------------------

/** The filled and empty cells of a terminal bar. */
export function barCells(percent: number, width: number): { filled: string, empty: string } {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  const count = Math.round((clamped / 100) * width)
  return { filled: '█'.repeat(count), empty: '░'.repeat(width - count) }
}

/** The desktop bar: a track and a fill, 8 px per cell, 10 px high. Small and valid. */
export function barSvg(percent: number, state: TrackState, cells: number): { source: string, width: number } {
  const width = cells * PX_PER_CELL
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  const fill = Math.round((clamped / 100) * width)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">` +
    `<rect width="${width}" height="10" rx="5" fill="${TRACK_COLOR}"/>` +
    (fill > 0 ? `<rect width="${fill}" height="10" rx="5" fill="${PALETTE[state].bg}"/>` : '') +
    '</svg>'
  return { source, width }
}

/** The desktop capsules and dots: one interactive SVG, each shape with a hover `<title>`. */
export function phasesSvg(bar: TrackBar, withCapsules: boolean, withDots: boolean): { source: string, width: number } {
  let x = 0
  let body = ''
  if (withCapsules) {
    for (const capsule of bar.phases) {
      const swatch = CAPSULE[capsule.state]
      body +=
        `<g><title>${escapeXml(capsuleDetails(capsule))}</title>` +
        `<rect x="${x}" y="0" width="${CAPSULE_PX}" height="16" rx="8" fill="${swatch.bg}"/>` +
        `<text x="${x + CAPSULE_PX / 2}" y="12" font-size="11" text-anchor="middle" fill="${swatch.fg}">` +
        `${CAPSULE_GLYPH[capsule.state]}${capsule.number}</text></g>`
      x += CAPSULE_PX + 4
    }
  }
  if (withDots) {
    if (withCapsules) x += 4
    for (const dot of compressDots(bar.dots)) {
      const cx = x + DOT_PX / 2
      const title = dot.title ? `<title>${escapeXml(dot.title)}</title>` : ''
      if (dot.status === 'completed') {
        body += `<circle cx="${cx}" cy="8" r="4" fill="${PALETTE.done.bg}">${title}</circle>`
      } else if (dot.status === 'in_progress') {
        body += `<circle cx="${cx}" cy="8" r="3.5" fill="#FFFFFF" stroke="${PALETTE.running.bg}" stroke-width="2">${title}</circle>`
      } else {
        body += `<circle cx="${cx}" cy="8" r="3.5" fill="none" stroke="${PALETTE.idle.bg}" stroke-width="1.5">${title}</circle>`
      }
      x += DOT_PX
    }
  }
  const width = Math.max(x, 1)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16" viewBox="0 0 ${width} 16">${body}</svg>`
  return { source, width }
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

function chip({ Text }: UiElements, state: TrackState) {
  const swatch = PALETTE[state]
  return Text({ color: swatch.fg, backgroundColor: swatch.bg, bold: true, children: [chipText(state)] })
}

function cell(Box: any, width: number, child: unknown, key?: string) {
  return Box({ ...(key ? { key } : {}), width, flexShrink: 0, children: [child] })
}

// One capsule with its hover card: the card is drawn hidden below the capsule and
// shown while the pointer is over the capsule's keyed Box. Terminal only.
function terminalCapsule(ui: UiElements, bar: TrackBar, capsule: Capsule, index: number) {
  const { Box, Text } = ui
  const swatch = CAPSULE[capsule.state]
  return Box({
    key: `phase-${bar.id}-${index}`,
    flexShrink: 0,
    children: [
      Text({
        color: swatch.fg,
        backgroundColor: swatch.bg,
        children: [` ${CAPSULE_GLYPH[capsule.state]}${capsule.number} `],
      }),
      Box({
        position: 'absolute',
        top: 1,
        left: 0,
        display: 'none',
        hover: { display: 'flex' },
        backgroundColor: CARD.bg,
        children: [Text({ color: CARD.fg, backgroundColor: CARD.bg, wrap: 'truncate', children: [' ' + capsuleDetails(capsule) + ' '] })],
      }),
    ],
  })
}

function terminalDots(ui: UiElements, bar: TrackBar) {
  const text = compressDots(bar.dots)
    .map((dot) => DOT_GLYPH[dot.status])
    .join('')
  return ui.Text({ children: [text] })
}

/** One track's row. */
export function buildRow(input: BandInput, bar: TrackBar) {
  const { ui, desktop } = input
  const { Box, Text, Button, Svg } = ui
  const plan = planRow(bar, input.columns, desktop)
  const useSvg = desktop && typeof Svg === 'function'
  const parts: unknown[] = [
    chip(ui, bar.state),
    cell(Box, plan.titleWidth, Text({ bold: true, wrap: 'truncate-end', children: [bar.title] })),
  ]

  if (useSvg) {
    const drawn = barSvg(bar.percent, bar.state, plan.barWidth)
    parts.push(Svg({ source: drawn.source, alt: summary(bar), width: drawn.width, height: 10 }))
  } else {
    const cells = barCells(bar.percent, plan.barWidth)
    parts.push(
      Box({
        flexShrink: 0,
        // An empty string is no child: a bar at 0% or 100% has one run only
        children: [
          ...(cells.filled !== '' ? [Text({ color: PALETTE[bar.state].bg, children: [cells.filled] })] : []),
          ...(cells.empty !== '' ? [Text({ color: TRACK_COLOR, dimColor: true, children: [cells.empty] })] : []),
        ],
      }),
    )
  }
  parts.push(cell(Box, PCT_W, Text({ children: [`${bar.percent}%`.padStart(PCT_W)] })))

  if (useSvg && (plan.capsules || plan.dots)) {
    const drawn = phasesSvg(bar, plan.capsules, plan.dots)
    parts.push(Svg({ source: drawn.source, alt: summary(bar), width: drawn.width, height: 16, isInteractive: true }))
  } else if (plan.capsules || plan.dots) {
    const inner: unknown[] = []
    if (plan.capsules) bar.phases.forEach((capsule, index) => inner.push(terminalCapsule(ui, bar, capsule, index)))
    if (plan.dots) inner.push(terminalDots(ui, bar))
    parts.push(Box({ flexShrink: 0, columnGap: 1, children: inner }))
  }

  if (plan.pillWidth > 0 && bar.pill) {
    parts.push(cell(Box, plan.pillWidth, Text({ dimColor: true, wrap: 'truncate-end', children: [clip(bar.pill.text, PILL_MAX)] })))
  }

  parts.push(Button({ key: `close-${bar.id}`, label: '✕', onPress: () => input.onClose(bar) }))
  return Box({ key: `bar-${bar.id}`, flexDirection: 'row', columnGap: 1, children: parts })
}

/**
 * The whole band: the bar rows, a footer with "+N more" and the Conductor toggle,
 * then the engine's own drawing. Never throws away `input.engine`.
 */
export function buildBand(input: BandInput) {
  const { Box, Text, Button } = input.ui
  const footer: unknown[] = []
  if (input.more > 0) footer.push(Text({ dimColor: true, children: [`+${input.more} more`] }))
  footer.push(
    Button({ key: 'toggle', label: 'Conductor', hotkey: '9', plain: true, dimColor: true, onPress: () => input.onToggle() }),
  )
  const rows = input.showBars ? input.rows.map((bar) => buildRow(input, bar)) : []
  return Box({
    flexDirection: 'column',
    children: [...rows, Box({ flexDirection: 'row', columnGap: 2, children: footer }), input.engine],
  })
}
