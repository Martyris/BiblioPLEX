const WUBRG_ORDER = ['W', 'U', 'B', 'R', 'G']

const MONO_NAMES: Record<string, string> = {
  W: 'Mono-White',
  U: 'Mono-Blue',
  B: 'Mono-Black',
  R: 'Mono-Red',
  G: 'Mono-Green'
}

// Keyed by colors sorted into WUBRG order.
const COMBO_NAMES: Record<string, string> = {
  // Guilds (2-color)
  WU: 'Azorius',
  WB: 'Orzhov',
  WR: 'Boros',
  WG: 'Selesnya',
  UB: 'Dimir',
  UR: 'Izzet',
  UG: 'Simic',
  BR: 'Rakdos',
  BG: 'Golgari',
  RG: 'Gruul',
  // Shards & wedges (3-color)
  WUB: 'Esper',
  WUR: 'Jeskai',
  WUG: 'Bant',
  WBR: 'Mardu',
  WBG: 'Abzan',
  WRG: 'Naya',
  UBR: 'Grixis',
  UBG: 'Sultai',
  URG: 'Temur',
  BRG: 'Jund',
  // Nephilim (4-color, named for the missing color)
  WUBR: 'Yore-Tiller',
  WUBG: 'Witch-Maw',
  WURG: 'Ink-Treader',
  WBRG: 'Dune-Brood',
  UBRG: 'Glint-Eye'
}

/** Official/community-standard name for a color identity (guild, shard/wedge, etc). */
export function colorIdentityName(colors: string[]): string {
  const ordered = WUBRG_ORDER.filter((c) => colors.includes(c))
  if (ordered.length === 0) return 'Colorless'
  if (ordered.length === 1) return MONO_NAMES[ordered[0]]
  if (ordered.length === 5) return 'Five-Color'
  return COMBO_NAMES[ordered.join('')] ?? ordered.join('')
}

export const COLOR_HEX: Record<string, string> = {
  W: '#f8f6d8',
  U: '#0e68ab',
  B: '#5a2d82',
  R: '#d3202a',
  G: '#00733e',
  C: '#919799'
}

/** A left-edge accent gradient for a color identity, for quick visual scanning in lists. */
export function colorIdentityGradient(colors: string[]): string {
  const ordered = WUBRG_ORDER.filter((c) => colors.includes(c))
  const hexes = (ordered.length > 0 ? ordered : ['C']).map((c) => COLOR_HEX[c])
  if (hexes.length === 1) return hexes[0]
  return `linear-gradient(180deg, ${hexes.join(', ')})`
}
