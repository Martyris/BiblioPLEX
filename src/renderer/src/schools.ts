import { COLOR_HEX } from './colorIdentityName'
import fatehold from './assets/schools/fatehold.png'
import theorix from './assets/schools/theorix.png'
import stingerquill from './assets/schools/stingerquill.png'
import konstrari from './assets/schools/konstrari.png'
import vigorbloom from './assets/schools/vigorbloom.png'
import silverquill from './assets/schools/silverquill.png'
import prismari from './assets/schools/prismari.png'
import witherbloom from './assets/schools/witherbloom.png'
import lorehold from './assets/schools/lorehold.png'
import quandrix from './assets/schools/quandrix.png'

export interface SchoolInfo {
  name: string
  colors: [string, string]
  logo: string
  motto: string
}

// The 5 real Strixhaven colleges (Lorehold, Prismari, Quandrix, Silverquill, Witherbloom) plus
// 5 homebrew "Hexhaven" counterparts for the other 5 guild pairs, together covering all 10
// Ravnica color pairs — ordered as the guild wheel (5 adjacent pairs, then the 5 opposing
// pairs), matching main/accounts.ts's SCHOOLS list. Hexhaven mottos are placeholders mirroring
// their Strixhaven counterpart's phrasing but twisted to the opposite theme: Fatehold (future
// history) answers Lorehold (the past), Theorix (exoteric/public math) answers Quandrix
// (esoteric/mystical math), Stingerquill (words that wound) answers Silverquill (words that
// dazzle), Konstrari (constructive art) answers Prismari (expressive art), and Vigorbloom
// (invasive healing) answers Witherbloom (hands-dirty decay).
export const SCHOOLS: SchoolInfo[] = [
  { name: 'Fatehold', colors: ['W', 'U'], logo: fatehold, motto: 'Leave no future unwritten.' },
  { name: 'Theorix', colors: ['U', 'B'], logo: theorix, motto: 'Math is truth.' },
  { name: 'Stingerquill', colors: ['B', 'R'], logo: stingerquill, motto: 'Sharp words, sharper wounds.' },
  { name: 'Konstrari', colors: ['R', 'G'], logo: konstrari, motto: 'Build yourself with the elements.' },
  { name: 'Vigorbloom', colors: ['G', 'W'], logo: vigorbloom, motto: 'Bloom, whether you want to or not.' },
  { name: 'Silverquill', colors: ['W', 'B'], logo: silverquill, motto: 'Sharp style, sharper wit.' },
  { name: 'Prismari', colors: ['U', 'R'], logo: prismari, motto: 'Express yourself with the elements.' },
  { name: 'Witherbloom', colors: ['B', 'G'], logo: witherbloom, motto: 'Get your hands dirty.' },
  { name: 'Lorehold', colors: ['R', 'W'], logo: lorehold, motto: 'Leave no stone unturned.' },
  { name: 'Quandrix', colors: ['G', 'U'], logo: quandrix, motto: 'Math is magic.' }
]

const BY_NAME = new Map(SCHOOLS.map((s) => [s.name, s]))

export function getSchool(name: string | null | undefined): SchoolInfo | null {
  if (!name) return null
  return BY_NAME.get(name) ?? null
}

/** The two canonical Magic-color hexes for a school, in the order used for its glow — first
 *  color tighter/brighter, second wider/softer, mirroring the default teal/navy treatment. */
export function schoolGlowColors(school: SchoolInfo): [string, string] {
  return [COLOR_HEX[school.colors[0]], COLOR_HEX[school.colors[1]]]
}

// Each Strixhaven college's "twisted" Hexhaven opposite (see the mottos comment above for the
// thematic reasoning) — the pairing the transfer-schools easter egg swaps a student between.
const COUNTERPARTS: Record<string, string> = {
  Lorehold: 'Fatehold',
  Fatehold: 'Lorehold',
  Prismari: 'Konstrari',
  Konstrari: 'Prismari',
  Quandrix: 'Theorix',
  Theorix: 'Quandrix',
  Silverquill: 'Stingerquill',
  Stingerquill: 'Silverquill',
  Witherbloom: 'Vigorbloom',
  Vigorbloom: 'Witherbloom'
}

export function getCounterpartSchool(name: string): SchoolInfo | null {
  return getSchool(COUNTERPARTS[name])
}

// The 5 homebrew "Hexhaven" schools — the odd-numbered half of SCHOOLS above (Strixhaven's 5
// real colleges come first, then their Hexhaven counterparts), kept as an explicit list rather
// than an index check so it reads clearly at call sites.
const HEXHAVEN_SCHOOL_NAMES: readonly string[] = ['Fatehold', 'Theorix', 'Stingerquill', 'Konstrari', 'Vigorbloom']

export function isHexhavenSchool(name: string | null | undefined): boolean {
  return !!name && HEXHAVEN_SCHOOL_NAMES.includes(name)
}

// Each Hexhaven school paired with its Strixhaven counterpart, in a fixed row order — the
// layout the account-settings school picker uses (Hexhaven column on the left, Strixhaven on
// the right, each row a counterpart pair) so the two are never rendered in an order that
// doesn't line them up.
export const SCHOOL_PAIRS: [SchoolInfo, SchoolInfo][] = HEXHAVEN_SCHOOL_NAMES.map((hexName) => {
  const hex = getSchool(hexName)
  const strix = getCounterpartSchool(hexName)
  if (!hex || !strix) throw new Error(`Missing counterpart pairing for ${hexName}`)
  return [hex, strix]
})
