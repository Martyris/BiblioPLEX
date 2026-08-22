import type { ScryfallCard } from './types'

export type ColorCode = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

export type ColorMode = 'atLeast' | 'exactly'

export interface FilterState {
  colors: ColorCode[]
  colorMode: ColorMode
  cmcMin: string
  cmcMax: string
  types: string
  rarities: string[]
  format: string
}

export const EMPTY_FILTERS: FilterState = {
  colors: [],
  colorMode: 'atLeast',
  cmcMin: '',
  cmcMax: '',
  types: '',
  rarities: [],
  format: ''
}

function hasActiveFilters(filters: FilterState): boolean {
  return (
    filters.colors.length > 0 ||
    filters.cmcMin.trim() !== '' ||
    filters.cmcMax.trim() !== '' ||
    filters.types.trim() !== '' ||
    filters.rarities.length > 0 ||
    filters.format.trim() !== ''
  )
}

// This app targets the physical TCG only — Arena-only cards (Alchemy rebalances, Arena
// exclusives) and digital-only sets are excluded from every search, unconditionally.
export const PAPER_ONLY_TERM = 'game:paper'

// Art Series cards (e.g. "Avatar: the Last Airbender Art Series") are not real gameplay
// cards and should never show up anywhere. Scryfall files them under set_type
// "memorabilia" (a mixed bag), so the reliable filter is the card's own layout.
export const EXCLUDE_ART_SERIES_TERM = '-layout:art_series'

// Front Cards (e.g. Jumpstart/Beginner Box "Front Cards") are also decorative, non-gameplay
// cards, filed under the same "memorabilia" set_type but with their own layout.
export const EXCLUDE_FRONT_CARDS_TERM = '-layout:front_card'

// Tokens get their own dedicated tab — excluded from normal search/set browsing.
export const EXCLUDE_TOKENS_TERM = '-is:token'

// Joke/playtest sets (Unglued, Unhinged, Unstable, Unfinity, Heroes of the Realm, Mystery
// Booster Playtest Cards, "Unknown Event", etc) are not legal in any real format and have
// no place in a physical-TCG deck builder.
export const EXCLUDE_FUNNY_TERM = '-is:funny'

// Bundles every always-on exclusion except tokens (which is conditional per view — the
// Tokens tab wants the opposite of this one).
export const BASE_EXCLUSION_TERMS = [
  PAPER_ONLY_TERM,
  EXCLUDE_ART_SERIES_TERM,
  EXCLUDE_FRONT_CARDS_TERM,
  EXCLUDE_FUNNY_TERM
]

/** Combines free-text search with structured filters into Scryfall query syntax.
 *  Returns '' (no search) when there's no real search intent yet. */
export function buildQuery(freeText: string, filters: FilterState): string {
  if (!isSearchable(freeText, filters)) return ''

  const parts: string[] = [...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM]
  const trimmedText = freeText.trim()
  if (trimmedText) parts.push(trimmedText)

  if (filters.colors.length > 0) {
    const op = filters.colorMode === 'exactly' ? '=' : '>='
    parts.push(`c${op}${filters.colors.join('').toLowerCase()}`)
  }

  const cmcMin = filters.cmcMin.trim()
  const cmcMax = filters.cmcMax.trim()
  if (cmcMin !== '') parts.push(`cmc>=${cmcMin}`)
  if (cmcMax !== '') parts.push(`cmc<=${cmcMax}`)

  const types = filters.types.trim()
  if (types) {
    for (const token of types.split(/\s+/)) {
      parts.push(`t:${token}`)
    }
  }

  if (filters.rarities.length > 0) {
    parts.push('(' + filters.rarities.map((r) => `r:${r}`).join(' or ') + ')')
  }

  const format = filters.format.trim()
  if (format) parts.push(`f:${format}`)

  return parts.join(' ')
}

export function isSearchable(freeText: string, filters: FilterState): boolean {
  return freeText.trim() !== '' || hasActiveFilters(filters)
}

/** Same semantics as buildQuery's filter terms, applied locally against an already-fetched
 *  card — for views (like tag search) backed by a local index rather than a live Scryfall
 *  query, where there's no query string to append terms to. */
export function cardMatchesFilters(card: ScryfallCard, filters: FilterState): boolean {
  if (filters.colors.length > 0) {
    const cardColors = new Set(card.colors ?? [])
    if (filters.colorMode === 'exactly') {
      if (filters.colors.includes('C')) {
        if (cardColors.size !== 0) return false
      } else if (cardColors.size !== filters.colors.length || !filters.colors.every((c) => cardColors.has(c))) {
        return false
      }
    } else {
      const matchesAll = filters.colors.every((c) => (c === 'C' ? cardColors.size === 0 : cardColors.has(c)))
      if (!matchesAll) return false
    }
  }

  const cmcMin = filters.cmcMin.trim()
  const cmcMax = filters.cmcMax.trim()
  if (cmcMin !== '' && card.cmc < Number(cmcMin)) return false
  if (cmcMax !== '' && card.cmc > Number(cmcMax)) return false

  const types = filters.types.trim()
  if (types) {
    const typeLine = card.type_line.toLowerCase()
    for (const token of types.split(/\s+/)) {
      if (!typeLine.includes(token.toLowerCase())) return false
    }
  }

  if (filters.rarities.length > 0 && !filters.rarities.includes(card.rarity)) return false

  const format = filters.format.trim()
  if (format && card.legalities?.[format] !== 'legal') return false

  return true
}
