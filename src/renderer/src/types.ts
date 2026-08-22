export interface ScryfallImageUris {
  small?: string
  normal?: string
  large?: string
  png?: string
  art_crop?: string
  border_crop?: string
}

export interface ScryfallCardFace {
  name: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  image_uris?: ScryfallImageUris
}

export interface ScryfallRelatedCard {
  id: string
  component: 'token' | 'meld_part' | 'meld_result' | 'combo_piece'
  name: string
  type_line: string
}

export interface ScryfallCard {
  id: string
  oracle_id: string
  name: string
  lang: string
  released_at: string
  mana_cost?: string
  cmc: number
  type_line: string
  oracle_text?: string
  colors?: string[]
  color_identity: string[]
  produced_mana?: string[]
  edhrec_rank?: number | null
  keywords: string[]
  power?: string
  toughness?: string
  loyalty?: string
  set: string
  set_name: string
  collector_number: string
  rarity: string
  legalities: Record<string, string>
  prices: Record<string, string | null>
  image_uris?: ScryfallImageUris
  card_faces?: ScryfallCardFace[]
  all_parts?: ScryfallRelatedCard[]
  scryfall_uri: string
  prints_search_uri: string
  rulings_uri: string
  full_art: boolean
  promo: boolean
  variation: boolean
  digital: boolean
  oversized: boolean
  border_color: string
  frame_effects?: string[]
  // Scryfall's flag for Wizards' official "Game Changers" list (part of the Commander
  // Bracket system) — cards powerful/format-warping enough that running them pushes a deck
  // out of the lower brackets.
  game_changer?: boolean
}

export interface ScryfallSet {
  id: string
  code: string
  name: string
  set_type: string
  released_at?: string
  card_count: number
  icon_svg_uri: string
  digital: boolean
}

export interface ScryfallSetList {
  object: 'list'
  data: ScryfallSet[]
}

export interface ScryfallSearchResult {
  object: 'list'
  total_cards?: number
  has_more?: boolean
  next_page?: string
  data: ScryfallCard[]
}

export interface ScryfallRuling {
  oracle_id: string
  source: string
  published_at: string
  comment: string
}

export interface ScryfallRulingsResult {
  object: 'list'
  data: ScryfallRuling[]
}

export interface ScryfallErrorResult {
  error: true
  status: number
  details: string
}

export type SearchResponse = ScryfallSearchResult | ScryfallErrorResult

export function isError(res: unknown): res is ScryfallErrorResult {
  return typeof res === 'object' && res !== null && 'error' in res && (res as { error: unknown }).error === true
}

export interface EdhrecCardEntry {
  id: string
  name: string
  synergy: number
  num_decks: number
  potential_decks: number
}

export interface EdhrecCardList {
  tag: string
  header: string
  cards: EdhrecCardEntry[]
}

export interface EdhrecTag {
  slug: string
  value: string
  count: number
}

export interface EdhrecCommanderData {
  name: string
  num_decks: number
  rank: number | null
  cardlists: EdhrecCardList[]
  tags: EdhrecTag[]
}

export interface CommanderTagIndex {
  tags: EdhrecTag[]
  cardTags: Record<string, string[]>
}

export interface SpellbookCardUse {
  cardName: string
  quantity: number
}

export interface SpellbookFeature {
  name: string
  quantity: number
}

export interface SpellbookVariant {
  id: string
  uses: SpellbookCardUse[]
  produces: SpellbookFeature[]
  description: string
  easyPrerequisites: string
  notablePrerequisites: string
  manaNeeded: string
  popularity: number | null
}

export interface SpellbookComboResult {
  included: SpellbookVariant[]
  almostIncluded: SpellbookVariant[]
}

export interface SpellbookErrorResult {
  error: true
  details: string
}

export function isSpellbookError(res: unknown): res is SpellbookErrorResult {
  return typeof res === 'object' && res !== null && 'error' in res && (res as { error: unknown }).error === true
}

export interface EdhrecTopCommander {
  id: string
  name: string
  num_decks: number
  rank: number
}

export interface DeckTag {
  slug: string
  value: string
  weight: number
}

export type Bracket = 1 | 2 | 3 | 4 | 5

export interface StoredDeck {
  id: string
  name: string
  commanderId: string
  commanderName: string
  partnerCommanderId: string | null
  partnerCommanderName: string | null
  cardIds: string[]
  tags: DeckTag[]
  bracket: Bracket | null
  wins: number
  losses: number
  order: number
  createdAt: string
  updatedAt: string
  // Token name -> chosen printing id, for tokens whose default (first-encountered) art the
  // user swapped via the Tokens Needed panel.
  tokenPrintingOverrides: Record<string, string>
  // Staging lists scoped to this deck — cards you own that could slot in, and cards you want
  // to find for it. Neither counts toward the deck's actual card total; they're just browsing
  // lists until a card is explicitly added via the normal Add Cards flow.
  cardPoolIds: string[]
  wantIds: string[]
  // Printing ids marked as owned-in-foil, toggled from the card inspect view. Scryfall models
  // foil/nonfoil as finishes of the same printing id, not separate objects, so this has to be
  // our own tracked state rather than something derivable from the card data.
  foilIds: string[]
  // Snapshot of the Score tab's result, written whenever it's computed there — shown on the
  // decks list so a score is visible without opening every deck. Not live; only as fresh as
  // the last time someone looked at that deck's Score tab.
  lastScore: { overall: number; grade: string; recordedAt: string } | null
  // Up to 3 tags (from the auto-detected Card Tags list) the player has singled out as this
  // deck's defining mechanics — shown on the "My Decks" tile. Capped at 3 in the UI, not here.
  coreMechanicTags: string[]
}
