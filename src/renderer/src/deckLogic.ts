import type { ScryfallCard } from './types'
import { colorIdentityGradient, colorIdentityName } from './colorIdentityName'

export function isBasicLand(card: Pick<ScryfallCard, 'type_line'>): boolean {
  // Snow-Covered basics print as "Basic Snow Land" — Snow sits as its own supertype between
  // Basic and Land, so the plain "Basic Land" substring alone doesn't match it. Missing this
  // was the actual cause behind a whole family of bugs (basic land counts not including snow
  // copies, singleton exemption not applying to them, etc.) — not just a display quirk.
  return card.type_line.includes('Basic Land') || card.type_line.includes('Basic Snow Land')
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

/** Every basic land name Scryfall prints has a "Snow-Covered <name>" counterpart (including
 *  Wastes, despite it being a much later addition) — plain string concatenation, not a lookup
 *  table, since the naming is completely regular. */
export function snowNameFor(name: string): string {
  return `Snow-Covered ${name}`
}

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

export type IllegalReason = 'color-identity' | 'banned'

export function isOutsideColorIdentity(card: ScryfallCard, deckColorIdentity: string[]): boolean {
  const identity = new Set(deckColorIdentity)
  return (card.color_identity ?? []).some((c) => !identity.has(c))
}

/** Checked independently, not "is this card legal" — a card can fail on either axis (or
 *  both), and the caller (a badge) only ever needs to show one, so banned wins the tie since
 *  it's the more absolute of the two problems. */
export function getIllegalReason(card: ScryfallCard, deckColorIdentity: string[]): IllegalReason | null {
  if (card.legalities?.commander === 'banned') return 'banned'
  if (isOutsideColorIdentity(card, deckColorIdentity)) return 'color-identity'
  return null
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
  category: string
  // label/dashColor are populated by every grouping function below (including
  // groupCardsByCategory) so a mode-agnostic renderer (DeckBuilder's main deck view) never needs
  // its own per-mode lookup table — it just reads these two fields off the group directly.
  // DeckBuilder's Card Pool/Want/Hot Swap views predate this and still do their own
  // DECK_CATEGORY_LABELS/DECK_CATEGORY_DASH_COLORS lookup keyed by `category` — untouched, since
  // groupCardsByCategory's `category` values (and their meaning) haven't changed.
  label: string
  dashColor?: string
  cards: ScryfallCard[]
}

const WUBRG_ORDER = 'WUBRG'

/** The colors (WUBRG only, colorless excluded) a land can produce, in canonical WUBRG order —
 *  used both to tier lands by fixing flexibility and to cluster same-combination lands. Exported
 *  for reuse anywhere else lands need the same "which color combo" grouping (e.g. the Playtest
 *  battlefield view). */
export function producedColorKey(card: ScryfallCard): string {
  const produced = (card.produced_mana ?? []).filter((c) => WUBRG_ORDER.includes(c))
  return [...produced].sort((a, b) => WUBRG_ORDER.indexOf(a) - WUBRG_ORDER.indexOf(b)).join('')
}

/** Nonbasic lands are tiered by mana fixing flexibility — any-color first, down through a
 *  specific 2-4 color combination, a single fixed color, then pure-colorless utility. Basic
 *  lands are their own tier at the very end regardless of the color they tap for. */
export function landTier(card: ScryfallCard): number {
  if (isBasicLand(card)) return 4
  const key = producedColorKey(card)
  if (key.length >= 5) return 0
  if (key.length >= 2) return 1
  if (key.length === 1) return 2
  return 3
}

const CATEGORY_LABELS: Record<CardCategory, string> = {
  Planeswalker: 'Planeswalkers',
  Creature: 'Creatures',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other'
}

// A fixed, curated palette (not hashed) — these are the same handful of categories on every
// deck, so a deliberate, memorable color per category reads better than an arbitrary one. Kept
// in sync with DeckBuilder.tsx's own DECK_CATEGORY_DASH_COLORS (that one also covers "OnDeck", a
// Want-list-only pseudo-category that doesn't exist at this layer).
const CATEGORY_DASH_COLORS: Record<CardCategory, string> = {
  Planeswalker: '#e6c229',
  Creature: '#7ee787',
  Instant: '#4fd8c4',
  Sorcery: '#f0824f',
  Artifact: '#9fb8d9',
  Enchantment: '#b388ff',
  Land: '#c9a876',
  Other: '#9a9aab'
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
  return order
    .filter((c) => buckets.has(c))
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      dashColor: CATEGORY_DASH_COLORS[category],
      cards: buckets.get(category)!
    }))
}

function cardColors(card: ScryfallCard): string[] {
  // No card_faces fallback here (unlike categorizeCard/cardSubtypes) — ScryfallCardFace doesn't
  // carry a `colors` field in this app's type, and Scryfall's top-level `colors` is already
  // populated for the vast majority of cards (only omitted for a handful of DFCs whose faces
  // genuinely differ in color, an acceptable edge case for a "sort by color" grouping).
  return card.colors ?? []
}

const WUBRG_ARRAY = ['W', 'U', 'B', 'R', 'G']

function wubrgKey(colors: string[]): string {
  return WUBRG_ARRAY.filter((c) => colors.includes(c)).join('')
}

// colorIdentityName's "Mono-White" etc. reads right for a deck's own overall identity, but is
// needlessly wordy for a per-card grouping bucket where every card in it actually IS that one
// color — just "White" reads better there.
const MONO_COLOR_NAMES: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green'
}

function colorGroupLabel(colors: string[]): string {
  return colors.length === 1 ? (MONO_COLOR_NAMES[colors[0]] ?? colorIdentityName(colors)) : colorIdentityName(colors)
}

/** Groups by the card's own color (not color identity — an artifact prints colorless even in a
 *  5-color deck), ordered mono-color first through five-color, colorless last. Within each color
 *  bucket, cards are sorted by the same type order groupCardsByCategory uses (Planeswalker,
 *  Creature, Instant, ...) — "arrange it to follow a type order" from the original ask. */
export function groupCardsByColor(cards: ScryfallCard[]): CategoryGroup[] {
  const buckets = new Map<string, ScryfallCard[]>()
  for (const card of cards) {
    const key = wubrgKey(cardColors(card))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(card)
    else buckets.set(key, [card])
  }

  const typeOrder = [...CARD_CATEGORIES, 'Other']
  for (const [key, bucket] of buckets) {
    buckets.set(
      key,
      [...bucket].sort((a, b) => typeOrder.indexOf(categorizeCard(a)) - typeOrder.indexOf(categorizeCard(b)))
    )
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    const lenA = a.length === 0 ? 6 : a.length // colorless sorts after five-color, not before mono
    const lenB = b.length === 0 ? 6 : b.length
    return lenA !== lenB ? lenA - lenB : a.localeCompare(b)
  })

  return keys.map((key) => {
    const colors = key.split('')
    return {
      category: key || 'Colorless',
      label: colorGroupLabel(colors),
      dashColor: colorIdentityGradient(colors),
      cards: buckets.get(key)!
    }
  })
}

const COST_BUCKET_MAX = 7 // "7+" catch-all, matching the existing mana-curve chart's convention

/** Groups nonland cards by mana value (0 through "7+"); lands get their own bucket at the end,
 *  since lumping them under "0" alongside actual 0-cost spells would be misleading. */
export function groupCardsByCost(cards: ScryfallCard[]): CategoryGroup[] {
  const buckets = new Map<number | 'Land', ScryfallCard[]>()
  for (const card of cards) {
    const key = isBasicLand(card) || categorizeCard(card) === 'Land' ? 'Land' : Math.min(Math.round(card.cmc ?? 0), COST_BUCKET_MAX)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(card)
    else buckets.set(key, [card])
  }

  const numericKeys = [...buckets.keys()].filter((k): k is number => typeof k === 'number').sort((a, b) => a - b)
  const order: (number | 'Land')[] = [...numericKeys, 'Land']

  return order
    .filter((k) => buckets.has(k))
    .map((key) => ({
      category: String(key),
      label: key === 'Land' ? 'Lands' : key === COST_BUCKET_MAX ? `${COST_BUCKET_MAX}+ Cost` : `${key} Cost`,
      cards: buckets.get(key)!
    }))
}

const NO_SUBTYPE = 'No Subtype'

/** The subtypes on a card's type line (the words after the em dash) — e.g. "Elf Warrior" ->
 *  ["Elf", "Warrior"], "Mountain" -> ["Mountain"], "Sorcery" -> [] (no subtype at all). Uses the
 *  front face's own type line for the same reason categorizeCard does (a combined MDFC/split
 *  type line would mix both faces' subtypes together). */
function cardSubtypes(card: ScryfallCard): string[] {
  const typeLine = card.card_faces?.[0]?.type_line || card.type_line || ''
  const afterDash = typeLine.split('—')[1]
  return afterDash ? afterDash.trim().split(/\s+/).filter(Boolean) : []
}

/** A multi-subtype card's "main" subtype (its first listed one) — e.g. Hydroid Krasis (Hydra
 *  Jellyfish) primarily files under Hydra. Exported so the renderer can tell a card's primary
 *  subtype-group appearance apart from its secondary ("ghost") ones in the other subtype groups
 *  it also shows up in — see groupCardsBySubtype. */
export function primarySubtype(card: ScryfallCard): string {
  return cardSubtypes(card)[0] ?? NO_SUBTYPE
}

/** A subtype bucket's "type origin" — whichever card type (Creature, Instant, ...) accounts for
 *  the most cards in that bucket, ties broken toward the earlier type in CARD_CATEGORIES order.
 *  E.g. 5 Goblin creatures + 1 Goblin enchantment -> Goblin's origin is Creature. */
function dominantTypeIndex(bucketCards: ScryfallCard[]): number {
  const typeOrder = [...CARD_CATEGORIES, 'Other']
  const counts = new Map<string, number>()
  for (const card of bucketCards) {
    const category = categorizeCard(card)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  let best = typeOrder[typeOrder.length - 1]
  let bestCount = -1
  for (const category of typeOrder) {
    const count = counts.get(category) ?? 0
    if (count > bestCount) {
      bestCount = count
      best = category
    }
  }
  return typeOrder.indexOf(best)
}

/** Groups by subtype — e.g. Dwarf, Goblin, Mountain, with a "No Subtype" bucket for cards that
 *  don't have one (most instants/sorceries, vanilla-typed permanents), always last. A card with
 *  more than one subtype (Hydroid Krasis: Hydra Jellyfish) appears in EVERY one of its subtype
 *  groups, not just its primary (first-listed) one — for viewing only, it's the same card/id
 *  everywhere, not a second copy, and it still only counts once toward the deck's real total.
 *  The renderer (DeckBuilder) is what tells a card's primary appearance apart from its secondary
 *  ("ghost") ones, via primarySubtype() above — this function itself doesn't distinguish them,
 *  every subtype bucket a card belongs to counts it as a full member for sorting purposes.
 *
 *  Real subtype buckets are ordered by their dominant type first (Creature-rooted subtypes
 *  before Instant-rooted ones, etc. — the same CARD_CATEGORIES order groupCardsByCategory uses),
 *  then by total card count descending within that type group — most Creature-rooted subtypes
 *  first, biggest first, then Instant-rooted, and so on. */
export function groupCardsBySubtype(cards: ScryfallCard[]): CategoryGroup[] {
  const buckets = new Map<string, ScryfallCard[]>()
  for (const card of cards) {
    const subtypes = cardSubtypes(card)
    const keys = subtypes.length > 0 ? subtypes : [NO_SUBTYPE]
    for (const key of keys) {
      const bucket = buckets.get(key)
      if (bucket) bucket.push(card)
      else buckets.set(key, [card])
    }
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === NO_SUBTYPE) return 1
    if (b === NO_SUBTYPE) return -1
    const bucketA = buckets.get(a)!
    const bucketB = buckets.get(b)!
    const typeDiff = dominantTypeIndex(bucketA) - dominantTypeIndex(bucketB)
    if (typeDiff !== 0) return typeDiff
    const countDiff = bucketB.length - bucketA.length
    if (countDiff !== 0) return countDiff
    return a.localeCompare(b)
  })

  // Within a bucket, a card's primary (first-listed) subtype appearance sorts before its
  // secondary ("ghost") ones — e.g. Hydroid Krasis (Hydra Jellyfish) sits with the other Hydras
  // first, and only shows up trailing the Jellyfish bucket after every card that's actually
  // primarily a Jellyfish.
  return keys.map((key) => {
    const bucketCards = buckets.get(key)!
    const primary = bucketCards.filter((c) => primarySubtype(c) === key)
    const ghosts = bucketCards.filter((c) => primarySubtype(c) !== key)
    return { category: key, label: key, cards: [...primary, ...ghosts] }
  })
}

/** Groups by printing set, most recently released first — matches how Precons/Decks lists are
 *  already sorted elsewhere in the app. */
export function groupCardsBySet(cards: ScryfallCard[]): CategoryGroup[] {
  const buckets = new Map<string, { name: string; releasedAt: string; cards: ScryfallCard[] }>()
  for (const card of cards) {
    const existing = buckets.get(card.set)
    if (existing) existing.cards.push(card)
    else buckets.set(card.set, { name: card.set_name, releasedAt: card.released_at, cards: [card] })
  }

  return [...buckets.entries()]
    .sort(([, a], [, b]) => b.releasedAt.localeCompare(a.releasedAt))
    .map(([set, { name, cards: setCards }]) => ({ category: set, label: name, cards: setCards }))
}

export type DeckGroupMode = 'type' | 'color' | 'cost' | 'subtype' | 'set'

export const DECK_GROUP_MODE_LABELS: Record<DeckGroupMode, string> = {
  type: 'Type',
  color: 'Color',
  cost: 'Cost',
  subtype: 'Subtype',
  set: 'Set'
}

/** Single entry point DeckBuilder's main deck view uses — dispatches to whichever grouping
 *  function matches the user's chosen "Group By" mode. Card Pool/Want/Hot Swap are unaffected;
 *  they call groupCardsByCategory directly and always group by type. */
export function groupDeckCards(cards: ScryfallCard[], mode: DeckGroupMode): CategoryGroup[] {
  switch (mode) {
    case 'color':
      return groupCardsByColor(cards)
    case 'cost':
      return groupCardsByCost(cards)
    case 'subtype':
      return groupCardsBySubtype(cards)
    case 'set':
      return groupCardsBySet(cards)
    case 'type':
    default:
      return groupCardsByCategory(cards)
  }
}

export interface DecklistPdfEntry {
  count: number
  name: string
  set: string
  collectorNumber: string
  foil: boolean
  isCommander: boolean
  isBasicLand: boolean
  imageUrl: string
}

export interface DecklistPdfGroup {
  label: string
  color: string
  entries: DecklistPdfEntry[]
}

/** Builds the grouped, cost-sorted, image-carrying structure Export Deck List (PDF) hands to
 *  the main process for typesetting a visual card sheet — the standard type categories
 *  (groupCardsByCategory's own order and dash colors), each sorted by mana value ascending
 *  ("divided by groups type, ordered within groups by cost from lowest to highest"), except
 *  that the commander(s) always lead whichever category they land in (almost always Creatures)
 *  rather than sitting in their own separate section — commanders are folded into the same
 *  groupCardsByCategory pass as deckCards precisely so they land in their correct category
 *  instead of needing a synthetic one. `foilOf` mirrors DeckBuilder's own foilKeyFor/occurrence
 *  scheme so a duplicate basic's later copies aren't all reported under the first copy's foil
 *  status; `imageUrl` resolves a printing to the thumbnail the PDF actually embeds. */
export function buildDecklistPdfGroups(
  commanders: { card: ScryfallCard; foil: boolean }[],
  deckCards: ScryfallCard[],
  foilOf: (card: ScryfallCard, occurrence: number) => boolean,
  imageUrl: (card: ScryfallCard) => string
): DecklistPdfGroup[] {
  const commanderOracleIds = new Set(commanders.map((c) => c.card.oracle_id))

  const occurrenceCount = new Map<string, number>()
  const deckWithFoil = deckCards.map((card) => {
    const occurrence = occurrenceCount.get(card.id) ?? 0
    occurrenceCount.set(card.id, occurrence + 1)
    return { card, foil: foilOf(card, occurrence) }
  })
  const allWithFoil = [...commanders, ...deckWithFoil]

  function makeEntries(cardsAndFoil: { card: ScryfallCard; foil: boolean }[]): DecklistPdfEntry[] {
    const counts = new Map<string, DecklistPdfEntry>()
    for (const { card, foil } of cardsAndFoil) {
      const key = `${card.name}|||${card.set}|||${card.collector_number}|||${foil}`
      const existing = counts.get(key)
      if (existing) existing.count++
      else
        counts.set(key, {
          count: 1,
          name: card.name,
          set: card.set,
          collectorNumber: card.collector_number,
          foil,
          isCommander: commanderOracleIds.has(card.oracle_id),
          isBasicLand: isBasicLand(card),
          imageUrl: imageUrl(card)
        })
    }
    // Stable sort: alphabetical first, then commander(s) pulled to the front — preserves
    // alphabetical order among the rest while still guaranteeing "commander leads the block."
    return [...counts.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .sort((a, b) => Number(b.isCommander) - Number(a.isCommander))
  }

  const groups: DecklistPdfGroup[] = []
  for (const categoryGroup of groupCardsByCategory([...commanders.map((c) => c.card), ...deckCards])) {
    const inGroup = allWithFoil.filter((wf) => categoryGroup.cards.includes(wf.card))
    const sortedByCost = [...inGroup].sort(
      (a, b) => (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name)
    )
    groups.push({ label: categoryGroup.label, color: categoryGroup.dashColor ?? '#9a9aab', entries: makeEntries(sortedByCost) })
  }

  return groups
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
