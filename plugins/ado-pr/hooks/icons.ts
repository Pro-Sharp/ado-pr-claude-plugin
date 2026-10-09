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
  closed: '#f0883e',
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

/** One coloured run of text on a chip. */
export type ChipPart = { text: string; color: string }

export const CHIP_COLORS = { added: '#3fb950', removed: '#f85149', muted: '#8b949e' } as const

const CHIP_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Escapes markup and writes non-ASCII (the `−` sign) as character references, whatever encoding the SVG is read in. */
const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[^\x20-\x7e]/gu, char => `&#x${(char.codePointAt(0) ?? 0x3f).toString(16)};`)

/**
 * A rounded pill of bold monospace runs (`+1,264 −206`, `7 files`), drawn as
 * SVG so its corners, font and height are exact. The width is measured from
 * the monospace advance (0.6 em), so no text is cut.
 */
export function chipSvg(parts: readonly ChipPart[], height = 22): { source: string; width: number; height: number } {
  const fontSize = 12
  const advance = fontSize * 0.6
  const padding = 8
  const gap = 6
  const chars = parts.reduce((sum, part) => sum + [...part.text].length, 0)
  const width = Math.ceil(padding * 2 + chars * advance + gap * Math.max(0, parts.length - 1))
  const runs = parts
    .map((part, i) => `<tspan${i > 0 ? ` dx="${gap}"` : ''} fill="${part.color}">${escapeXml(part.text)}</tspan>`)
    .join('')

  return {
    width,
    height,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="6" fill="#383838"/>` +
      `<text x="${padding}" y="${height / 2}" dominant-baseline="central" font-family="${CHIP_FONT}" ` +
      `font-size="${fontSize}" font-weight="700">${runs}</text>` +
      '</svg>',
  }
}

/** A speech bubble with three dots: white inside, black outline. */
export function commentSvg(size = 16): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">` +
    '<path d="M6 3.5H18A3 3 0 0 1 21 6.5V14A3 3 0 0 1 18 17H10.5L6.5 21V17H6A3 3 0 0 1 3 14V6.5A3 3 0 0 1 6 3.5Z" ' +
    'fill="#ffffff" stroke="#000000" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="10.25" r="1.4" fill="#000000"/>' +
    '<circle cx="12" cy="10.25" r="1.4" fill="#000000"/>' +
    '<circle cx="16" cy="10.25" r="1.4" fill="#000000"/>' +
    '</svg>'
  )
}
