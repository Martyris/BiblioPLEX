import type { ScryfallCard } from './types'

export function isBasicLand(card: Pick<ScryfallCard, 'type_line'>): boolean {
  return card.type_line.includes('Basic Land')
}

/** Toggles a printing id in/out of a plain staging list (Card Pool, Want) — no singleton
 *  rule, since owning or wanting two copies of the same card is completely normal. */
export function toggleIdInList(ids: string[], clickedId: string): string[] {
  return ids.includes(clickedId) ? ids.filter((id) => id !== clickedId) : [...ids, clickedId]
}

/** Adds an id to a staging list only if it isn't already there — used for "move to the other
 *  list", where the destination should always gain the card rather than toggling it back out. */
export function addIdToList(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

// The five classic basics plus Wastes (colorless) — the only basic land types worth a direct
// stepper control. Snow-covered basics and other basic land variants are still reachable
// through the normal Add Cards search.
export const BASIC_LAND_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'] as const

const COLOR_TO_BASIC_LAND: Record<string, (typeof BASIC_LAND_NAMES)[number]> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest'
}

// Reverse of COLOR_TO_BASIC_LAND — Wastes has no entry (colorless, shown with the 'C' pip).
export const BASIC_LAND_COLOR: Partial<Record<(typeof BASIC_LAND_NAMES)[number], string>> = Object.fromEntries(
  Object.entries(COLOR_TO_BASIC_LAND).map(([color, name]) => [name, color])
)

/** Basics worth offering a direct stepper for, given a deck's (commander + partner) color
 *  identity — Wastes is colorless and legal in any deck regardless of identity, so it's
 *  always included; the WUBRG basics only show up for colors actually in the identity. */
export function basicLandNamesForIdentity(colorIdentity: string[]): (typeof BASIC_LAND_NAMES)[number][] {
  const identity = new Set(colorIdentity)
  return BASIC_LAND_NAMES.filter((name) => {
    if (name === 'Wastes') return true
    const color = Object.entries(COLOR_TO_BASIC_LAND).find(([, n]) => n === name)?.[0]
    return color ? identity.has(color) : false
  })
}

/** Counts how many copies of each basic land type are already in the deck, plus one sample
 *  printing id per type (so "+" can reuse the same art instead of re-searching). */
export function countBasicLands(deckCards: ScryfallCard[]): Map<string, { count: number; sampleId: string }> {
  const counts = new Map<string, { count: number; sampleId: string }>()
  for (const card of deckCards) {
    if (!isBasicLand(card)) continue
    const existing = counts.get(card.name)
    if (existing) existing.count += 1
    else counts.set(card.name, { count: 1, sampleId: card.id })
  }
  return counts
}

export function isCardInDeck(deckCards: ScryfallCard[], oracleId: string): boolean {
  return deckCards.some((c) => c.oracle_id === oracleId)
}

/** Toggles a card in/out of a deck's id list by oracle identity (EDH singleton rule).
 *  Basic lands are exempt and can have any number of copies. */
export function toggleCardInDeck(cardIds: string[], deckCards: ScryfallCard[], clicked: ScryfallCard): string[] {
  if (isBasicLand(clicked)) {
    return [...cardIds, clicked.id]
  }

  const existing = deckCards.find((c) => c.oracle_id === clicked.oracle_id)
  if (existing) {
    return cardIds.filter((id) => id !== existing.id)
  }
  return [...cardIds, clicked.id]
}

/** Replaces one printing with another (same underlying card) inside a deck's id list. */
export function swapPrinting(cardIds: string[], oldId: string, newId: string): string[] {
  return cardIds.map((id) => (id === oldId ? newId : id))
}

/** Swaps only the Nth (0-based) occurrence of `oldId`, leaving other copies of the same
 *  printing untouched — needed for basic lands, where every copy shares one printing id by
 *  default and a printing change should only ever affect the specific copy the user clicked. */
export function swapPrintingAtOccurrence(
  cardIds: string[],
  oldId: string,
  occurrence: number,
  newId: string
): string[] {
  let seen = -1
  return cardIds.map((id) => {
    if (id !== oldId) return id
    seen += 1
    return seen === occurrence ? newId : id
  })
}

export const CARD_CATEGORIES = [
  'Planeswalker',
  'Creature',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land'
] as const

export type CardCategory = (typeof CARD_CATEGORIES)[number] | 'Other'

/** Buckets a card by its primary type for deck-list grouping. Multi-typed cards (e.g.
 *  artifact creatures) fall into the earlier category in CARD_CATEGORIES order.
 *
 *  Adventure/split/transform/MDFC cards expose a *combined* type_line at the top level (both
 *  faces joined by " // ") — e.g. Glamdring's is "Artifact — Equipment // Sorcery — Adventure".
 *  Since "Sorcery" is checked before "Artifact" in CARD_CATEGORIES, using that combined string
 *  miscategorized it as a Sorcery even though its actual permanent is an Artifact. Categorize
 *  by the front face's own type specifically when the card has faces. */
export function categorizeCard(card: ScryfallCard): CardCategory {
  const typeLine = card.card_faces?.[0]?.type_line || card.type_line || ''
  for (const category of CARD_CATEGORIES) {
    if (typeLine.includes(category)) return category
  }
  return 'Other'
}

export interface CategoryGroup {
  category: CardCategory
  cards: ScryfallCard[]
}

const WUBRG_ORDER = 'WUBRG'

/** The colors (WUBRG only, colorless excluded) a land can produce, in canonical WUBRG order —
 *  used both to tier lands by fixing flexibility and to cluster same-combination lands. */
function producedColorKey(card: ScryfallCard): string {
  const produced = (card.produced_mana ?? []).filter((c) => WUBRG_ORDER.includes(c))
  return [...produced].sort((a, b) => WUBRG_ORDER.indexOf(a) - WUBRG_ORDER.indexOf(b)).join('')
}

/** Nonbasic lands are tiered by mana fixing flexibility — any-color first, down through a
 *  specific 2-4 color combination, a single fixed color, then pure-colorless utility. Basic
 *  lands are their own tier at the very end regardless of the color they tap for. */
function landTier(card: ScryfallCard): number {
  if (isBasicLand(card)) return 4
  const key = producedColorKey(card)
  if (key.length >= 5) return 0
  if (key.length >= 2) return 1
  if (key.length === 1) return 2
  return 3
}

/** Groups deck cards into the standard category buckets, in a fixed display order. */
export function groupCardsByCategory(cards: ScryfallCard[]): CategoryGroup[] {
  const buckets = new Map<CardCategory, ScryfallCard[]>()
  for (const card of cards) {
    const category = categorizeCard(card)
    const bucket = buckets.get(category)
    if (bucket) bucket.push(card)
    else buckets.set(category, [card])
  }

  // Lands sort by fixing tier (any-color > a specific combination > mono-color utility >
  // colorless utility), with same-combination lands clustered together, and basics always
  // last regardless of tier — otherwise a wall of Forests can push the deck's actually
  // interesting land choices out of easy view. Array.sort is stable, so relative order within
  // a tied tier+combination is preserved.
  const landBucket = buckets.get('Land')
  if (landBucket) {
    buckets.set(
      'Land',
      [...landBucket].sort((a, b) => {
        const tierDiff = landTier(a) - landTier(b)
        if (tierDiff !== 0) return tierDiff
        return producedColorKey(a).localeCompare(producedColorKey(b))
      })
    )
  }

  const order: CardCategory[] = [...CARD_CATEGORIES, 'Other']
  return order.filter((c) => buckets.has(c)).map((category) => ({ category, cards: buckets.get(category)! }))
}

export interface DerivedToken {
  id: string
  name: string
  type_line: string
}

/** Collects the unique set of tokens a deck's cards (commander included) can create. Deduped
 *  by name, not printing id — different cards can each reference a different printing of the
 *  "same" token (e.g. two different Treasure-token prints from different sets), which showed
 *  up as duplicates when deduped by id. `printingOverrides` (token name -> printing id) lets a
 *  user-chosen printing win over whichever one happened to be encountered first. */
export function deriveTokens(
  cards: ScryfallCard[],
  printingOverrides: Record<string, string> = {}
): DerivedToken[] {
  const seen = new Map<string, DerivedToken>()
  for (const card of cards) {
    for (const part of card.all_parts ?? []) {
      if (part.component === 'token' && !seen.has(part.name)) {
        const id = printingOverrides[part.name] ?? part.id
        seen.set(part.name, { id, name: part.name, type_line: part.type_line })
      }
    }
  }
  return [...seen.values()]
}
