/**
 * The PR state icons, drawn as SVG on the surfaces that have `Svg`: the
 * pull-request glyph (open, draft, abandoned) and the merge glyph (merged).
 * Each stroke is drawn twice, a wide outline under a narrower colour.
 */

export type IconPhase = 'open' | 'draft' | 'merged' | 'closed'

const COLORS: Record<IconPhase, string> = {
  open: '#3fb950',
  draft: '#8b949e',
  merged: '#a371f7',
  closed: '#f85149',
}

const OUTLINE = '#000000'

const ring = (cx: number, cy: number) => `<circle cx="${cx}" cy="${cy}" r="2.6"/>`

/** Two stems; the right one curves up and over into an arrow pointing left. */
const PULL_REQUEST = [
  ring(6, 5.5),
  '<path d="M6 8.1V15.9"/>',
  ring(6, 18.5),
  ring(18, 18.5),
  '<path d="M18 15.9V9.5C18 7.3 16.7 6 14.5 6H10.5"/>',
  '<path d="M13 3.5L10.5 6L13 8.5"/>',
].join('')

/** One stem with a branch leaving it and curving up into a second head. */
const MERGE = [
  ring(7, 5),
  ring(17, 5),
  ring(7, 19),
  '<path d="M7 7.6V16.4"/>',
  '<path d="M7 15C7 12 8.6 10.6 11.5 10.6H13C15.4 10.6 17 9.4 17 7.6"/>',
].join('')

export function iconSvg(phase: IconPhase, size = 16): string {
  const shapes = phase === 'merged' ? MERGE : PULL_REQUEST
  const color = COLORS[phase]

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="${OUTLINE}" stroke-width="3.6">${shapes}</g>` +
    `<g stroke="${color}" stroke-width="1.8">${shapes}</g>` +
    '</svg>'
  )
}

export const ICON_ALT: Record<IconPhase, string> = {
  open: 'Open pull request',
  draft: 'Draft pull request',
  merged: 'Merged pull request',
  closed: 'Abandoned pull request',
}

/** The badge word the hover card shows. */
export const PHASE_LABEL: Record<IconPhase, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Abandoned',
}
