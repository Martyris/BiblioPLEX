import { useEffect, useMemo, useRef, useState } from 'react'
import CardTile from './CardTile'
import CardResults from './CardResults'
import CardDetail from './CardDetail'
import CommanderView from './CommanderView'
import ColorPips from './ColorPips'
import TagSearchView from './TagSearchView'
import DeckAnalyticsView from './DeckAnalyticsView'
import DeckScoreView from './DeckScoreView'
import DeckCombosView from './DeckCombosView'
import { SORT_OPTIONS } from './SortControl'
import { BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM } from '../queryBuilder'
import {
  addIdToList,
  BASIC_LAND_COLOR,
  basicLandNamesForIdentity,
  CARD_CATEGORIES,
  categorizeCard,
  countBasicLands,
  deriveTokens,
  groupCardsByCategory,
  isBasicLand,
  swapPrinting,
  swapPrintingAtOccurrence,
  toggleCardInDeck,
  toggleIdInList,
  type CardCategory,
  type DerivedToken
} from '../deckLogic'
import CardContextMenu from './CardContextMenu'
import { scryfallImageUrl } from '../scryfallImage'
import { winRate, winRateColor } from '../winRate'
import { bracketColor } from '../bracketColor'
import { detectSecondCommanderMode, secondCommanderQuery } from '../partnerEligibility'
import { resolveCardTags, type CardTagOverride } from '../cardTagging'
import {
  isError,
  type Bracket,
  type CommanderTagIndex,
  type ScryfallCard,
  type ScryfallSearchResult,
  type StoredDeck
} from '../types'

const BRACKETS: Bracket[] = [1, 2, 3, 4, 5]
const BRACKET_LABELS: Record<Bracket, string> = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH'
}

const ALL_CATEGORIES: CardCategory[] = [...CARD_CATEGORIES, 'Other']

const DECK_CATEGORY_LABELS: Record<string, string> = {
  OnDeck: 'On Deck',
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
// deck, so a deliberate, memorable color per category reads better than an arbitrary one.
const DECK_CATEGORY_DASH_COLORS: Record<string, string> = {
  OnDeck: '#ec6ad0',
  Planeswalker: '#e6c229',
  Creature: '#7ee787',
  Instant: '#4fd8c4',
  Sorcery: '#f0824f',
  Artifact: '#9fb8d9',
  Enchantment: '#b388ff',
  Land: '#c9a876',
  Other: '#9a9aab'
}

// Shared by the Deck/Card Pool/Want tabs' category sidebars — each tab gets its own instance
// (collapse state and scroll targets are per-tab, not shared) but the behavior is identical.
function useCategorySidebar(initiallyCollapsed: string[] = []) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(initiallyCollapsed))
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map())
  const topRef = useRef<HTMLHeadingElement>(null)

  function toggleCollapsed(category: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  function scrollToSection(category: string): void {
    sectionRefs.current.get(category)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function scrollToTop(): void {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return { collapsed, toggleCollapsed, sectionRefs, topRef, scrollToSection, scrollToTop }
}

interface Props {
  deckId: string
  onBack: () => void
}

type View = 'deck' | 'cardPool' | 'want' | 'analytics' | 'score' | 'combos' | 'recommendations' | 'tagSearch'

export default function DeckBuilder({ deckId, onBack }: Props) {
  const [storedDeck, setStoredDeck] = useState<StoredDeck | null>(null)
  const [cardsById, setCardsById] = useState<Record<string, ScryfallCard>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('deck')
  const [initialTag, setInitialTag] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [cardPoolQuery, setCardPoolQuery] = useState('')
  const [wantQuery, setWantQuery] = useState('')
  const [viewingCard, setViewingCard] = useState<ScryfallCard | null>(null)
  const [viewingSlotId, setViewingSlotId] = useState<string | null>(null)
  // Which copy of viewingSlotId's printing was clicked, among duplicates that share the same
  // id (basic lands) — 0 for every other kind of slot, where duplicates can't happen.
  const [viewingSlotOccurrence, setViewingSlotOccurrence] = useState(0)
  const [viewingKind, setViewingKind] = useState<'card' | 'commander' | 'partner' | 'token' | 'poolCard' | 'wantCard'>(
    'card'
  )
  const [poolWantContextMenu, setPoolWantContextMenu] = useState<{
    card: ScryfallCard
    list: 'pool' | 'want'
    x: number
    y: number
  } | null>(null)
  const [viewingTokenName, setViewingTokenName] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  // Which slot is currently being dragged over — separate from draggedId (the card being
  // lifted) so the drop target itself can get a distinct highlight, not just the dragged card
  // dimming. Native HTML5 drag-and-drop gives no feedback at all otherwise.
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const deckSidebar = useCategorySidebar()
  const poolSidebar = useCategorySidebar(['OnDeck'])
  const wantSidebar = useCategorySidebar()
  const [hotSwapOpen, setHotSwapOpen] = useState(false)
  const [hotSwapDeckCategory, setHotSwapDeckCategory] = useState<CardCategory>('Creature')
  const [hotSwapPoolCategory, setHotSwapPoolCategory] = useState<CardCategory>('Creature')
  const [hotSwapDragCard, setHotSwapDragCard] = useState<ScryfallCard | null>(null)
  const [hotSwapDragSource, setHotSwapDragSource] = useState<'deck' | 'pool' | null>(null)
  const [hotSwapDragOverSide, setHotSwapDragOverSide] = useState<'deck' | 'pool' | null>(null)
  // Hovering a dragged card over a specific card on the other side, held long enough, *arms*
  // a direct swap of the two — it still only actually happens on release (onDrop), holding
  // just shows the ring filling in to signal "let go now for a swap".
  const [hotSwapHoverTargetId, setHotSwapHoverTargetId] = useState<string | null>(null)
  const [hotSwapSwapArmed, setHotSwapSwapArmed] = useState(false)
  const hotSwapHoverTimer = useRef<number | null>(null)
  const HOT_SWAP_HOLD_MS = 650
  const [addingPartner, setAddingPartner] = useState(false)
  const [partnerQuery, setPartnerQuery] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [cardTagOverrides, setCardTagOverrides] = useState<Map<string, CardTagOverride>>(new Map())
  const [activeSearchTags, setActiveSearchTags] = useState<string[]>([])
  const [showAllTags, setShowAllTags] = useState(false)
  const [openTagMenu, setOpenTagMenu] = useState<string | null>(null)
  const [deckTagFilter, setDeckTagFilter] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setView('deck')
    // Fresh deck, fresh cache — otherwise a card cached under some id from a previously
    // viewed deck could theoretically collide, however unlikely.
    setCardsById({})

    async function load(): Promise<void> {
      const deckResult = await window.api.getDeck(deckId)
      if (cancelled) return
      if (!deckResult) {
        setError('Deck not found.')
        setLoading(false)
        return
      }
      const deck = deckResult as StoredDeck
      setStoredDeck(deck)

      const ids = [deck.commanderId, ...(deck.partnerCommanderId ? [deck.partnerCommanderId] : []), ...deck.cardIds]
      const cardsResult = await window.api.getCardsByIds(ids)
      if (cancelled) return
      if (isError(cardsResult)) {
        setError(cardsResult.details)
        setLoading(false)
        return
      }
      const cards = (cardsResult as { data: ScryfallCard[] }).data
      // Merge, not replace — the separate Card Pool/Want fetch effect (triggered by the
      // setStoredDeck above) can resolve before or after this one, and a plain replace here
      // would silently wipe out whichever of the two finished first.
      setCardsById((prev) => {
        const next = { ...prev }
        for (const c of cards) next[c.id] = c
        return next
      })
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [deckId])

  const commander = storedDeck ? (cardsById[storedDeck.commanderId] ?? null) : null
  const partnerCommander =
    storedDeck?.partnerCommanderId ? (cardsById[storedDeck.partnerCommanderId] ?? null) : null
  const secondMode = commander ? detectSecondCommanderMode(commander) : null

  const deckCards = useMemo(() => {
    if (!storedDeck) return []
    return storedDeck.cardIds.map((id) => cardsById[id]).filter((c): c is ScryfallCard => Boolean(c))
  }, [storedDeck, cardsById])

  const tokens = useMemo(() => {
    const commanders = [commander, partnerCommander].filter((c): c is ScryfallCard => Boolean(c))
    return deriveTokens([...commanders, ...deckCards], storedDeck?.tokenPrintingOverrides)
  }, [commander, partnerCommander, deckCards, storedDeck?.tokenPrintingOverrides])

  const deckWinRate = useMemo(
    () => (storedDeck ? winRate(storedDeck.wins, storedDeck.losses) : null),
    [storedDeck?.wins, storedDeck?.losses]
  )
  const deckOracleIds = useMemo(() => new Set(deckCards.map((c) => c.oracle_id)), [deckCards])
  // The commander (and partner/background, if any) are part of the 100-card deck total —
  // deckCards only holds the non-commander cardIds, so the displayed count needs the +1/+2.
  const totalDeckSize = deckCards.length + 1 + (storedDeck?.partnerCommanderId ? 1 : 0)
  const categoryGroups = useMemo(() => groupCardsByCategory(deckCards), [deckCards])
  const basicLandCounts = useMemo(() => countBasicLands(deckCards), [deckCards])
  const deckColorIdentity = useMemo(() => {
    const colors = new Set<string>()
    for (const c of commander?.color_identity ?? []) colors.add(c)
    for (const c of partnerCommander?.color_identity ?? []) colors.add(c)
    return [...colors]
  }, [commander, partnerCommander])
  const visibleBasicLandNames = useMemo(() => basicLandNamesForIdentity(deckColorIdentity), [deckColorIdentity])

  // Card Pool and Want ids aren't preloaded with the rest of the deck (they're staging lists,
  // not part of cardIds) — fetch whichever of them aren't already known whenever they change.
  useEffect(() => {
    if (!storedDeck) return
    const idsToFetch = [...storedDeck.cardPoolIds, ...storedDeck.wantIds].filter((id) => !cardsById[id])
    if (idsToFetch.length === 0) return
    let cancelled = false
    window.api.getCardsByIds(idsToFetch).then((result) => {
      if (cancelled || isError(result)) return
      const cards = (result as { data: ScryfallCard[] }).data
      setCardsById((prev) => {
        const next = { ...prev }
        for (const c of cards) next[c.id] = c
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedDeck?.cardPoolIds, storedDeck?.wantIds])

  const cardPoolCards = useMemo(() => {
    if (!storedDeck) return []
    const resolved = storedDeck.cardPoolIds.map((id) => cardsById[id]).filter((c): c is ScryfallCard => Boolean(c))
    // Cards not yet in the deck are the actionable ones — surface them first, ahead of pool
    // entries that are already sitting in the deck (a card added to the deck always joins the
    // pool too, so this list otherwise fills up with cards there's nothing left to do with).
    return [...resolved].sort((a, b) => Number(deckOracleIds.has(a.oracle_id)) - Number(deckOracleIds.has(b.oracle_id)))
  }, [storedDeck?.cardPoolIds, cardsById, deckOracleIds])

  const wantCards = useMemo(() => {
    if (!storedDeck) return []
    return storedDeck.wantIds.map((id) => cardsById[id]).filter((c): c is ScryfallCard => Boolean(c))
  }, [storedDeck?.wantIds, cardsById])

  // Oracle-based (not printing-based) so a card shows its Want/Pool marker everywhere,
  // regardless of which printing turns up in a given search.
  const wantOracleIds = useMemo(() => new Set(wantCards.map((c) => c.oracle_id)), [wantCards])
  const cardPoolOracleIds = useMemo(() => new Set(cardPoolCards.map((c) => c.oracle_id)), [cardPoolCards])
  const foilIdSet = useMemo(() => new Set(storedDeck?.foilIds ?? []), [storedDeck?.foilIds])

  // "On Deck" is its own bucket ahead of the type categories — a pool card already in the
  // deck has nothing left to do with it, so it's worth calling out separately rather than
  // mixed in among the cards still worth considering.
  const poolCategoryGroups = useMemo(() => {
    const onDeck = cardPoolCards.filter((c) => deckOracleIds.has(c.oracle_id))
    const rest = cardPoolCards.filter((c) => !deckOracleIds.has(c.oracle_id))
    const groups: { category: string; cards: ScryfallCard[] }[] = [...groupCardsByCategory(rest)]
    if (onDeck.length > 0) groups.push({ category: 'OnDeck', cards: onDeck })
    return groups
  }, [cardPoolCards, deckOracleIds])

  const wantCategoryGroups = useMemo(() => groupCardsByCategory(wantCards), [wantCards])

  // Hot Swap's two columns: the deck side is just "cards of this type currently in the deck";
  // the pool side deliberately excludes cards already in the deck (same "on deck" cards the
  // Card Pool tab carves out) — nothing to swap in for a card you're already running.
  const hotSwapDeckCards = useMemo(
    () => deckCards.filter((c) => categorizeCard(c) === hotSwapDeckCategory),
    [deckCards, hotSwapDeckCategory]
  )
  const hotSwapPoolCards = useMemo(
    () =>
      cardPoolCards.filter(
        (c) => !deckOracleIds.has(c.oracle_id) && categorizeCard(c) === hotSwapPoolCategory
      ),
    [cardPoolCards, deckOracleIds, hotSwapPoolCategory]
  )

  // Duplicate basic lands share one printing id, so foil status can't be tracked per-id there —
  // occurrence 0 (the common case: a singleton card, or a basic's first copy) keeps using the
  // plain id for backward compatibility; later copies of the same id get a distinct key.
  function foilKeyFor(id: string, occurrence: number): string {
    return occurrence > 0 ? `${id}::${occurrence}` : id
  }

  async function toggleFoil(key: string): Promise<void> {
    if (!storedDeck) return
    await persist({ foilIds: toggleIdInList(storedDeck.foilIds, key) })
  }

  function getMarker(card: ScryfallCard): 'want' | 'pool' | undefined {
    if (wantOracleIds.has(card.oracle_id)) return 'want'
    if (cardPoolOracleIds.has(card.oracle_id)) return 'pool'
    return undefined
  }

  function getMarkerForOracleId(oracleId: string): 'want' | 'pool' | undefined {
    if (wantOracleIds.has(oracleId)) return 'want'
    if (cardPoolOracleIds.has(oracleId)) return 'pool'
    return undefined
  }

  // Manual tag overrides for every card currently in the deck, fetched in one batch — needed
  // to resolve the same final tag list the per-card editor shows, not just the auto-derived one.
  useEffect(() => {
    let cancelled = false
    const oracleIds = [...new Set(deckCards.map((c) => c.oracle_id))]
    if (oracleIds.length === 0) {
      setCardTagOverrides(new Map())
      return
    }
    window.api.getCardTagOverridesBatch(oracleIds).then((map) => {
      if (cancelled) return
      setCardTagOverrides(new Map(Object.entries(map)))
    })
    return () => {
      cancelled = true
    }
  }, [deckCards])

  // EDHREC's per-commander tag index (top ~30 synergy pages) — used only for the Score tab's
  // synergy category, so it's fetched lazily on first visit to that tab rather than on every
  // deck load (the first fetch takes ~15s; edhrec.ts caches it 6h after that). Keyed off the
  // commander's oracle id, not the object reference, so a printing swap doesn't refetch.
  const [commanderTagIndex, setCommanderTagIndex] = useState<CommanderTagIndex | null>(null)
  const [synergyOracleIds, setSynergyOracleIds] = useState<Set<string> | null>(null)
  // How many of the commander's top tags each card matched (by oracle id) — a cheap proxy
  // for "how synergistic" a card is, reusing data already fetched for the Set above rather
  // than fetching EDHREC's actual per-card synergy percentages separately.
  const [synergyWeights, setSynergyWeights] = useState<Map<string, number> | null>(null)
  const [synergyLoading, setSynergyLoading] = useState(false)

  useEffect(() => {
    setCommanderTagIndex(null)
    setSynergyOracleIds(null)
    setSynergyWeights(null)
  }, [commander?.oracle_id])

  useEffect(() => {
    if (view !== 'score' || !commander || commanderTagIndex || synergyLoading) return
    let cancelled = false

    async function load(): Promise<void> {
      setSynergyLoading(true)
      const result = await window.api.getCommanderTagIndex(commander!.name)
      if (cancelled) return
      if (isError(result)) {
        setSynergyLoading(false)
        return
      }
      const index = result as CommanderTagIndex
      setCommanderTagIndex(index)
      const ids = Object.keys(index.cardTags)
      if (ids.length === 0) {
        setSynergyOracleIds(new Set())
        setSynergyWeights(new Map())
        setSynergyLoading(false)
        return
      }
      const cardsResult = await window.api.getCardsByIds(ids)
      if (cancelled) return
      if (!isError(cardsResult)) {
        const cards = (cardsResult as { data: ScryfallCard[] }).data ?? []
        setSynergyOracleIds(new Set(cards.map((c) => c.oracle_id)))
        const weights = new Map<string, number>()
        for (const c of cards) {
          const weight = index.cardTags[c.id]?.length ?? 0
          weights.set(c.oracle_id, Math.max(weights.get(c.oracle_id) ?? 0, weight))
        }
        setSynergyWeights(weights)
      }
      setSynergyLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
    // commanderTagIndex/synergyLoading are read here only to gate against a duplicate fetch,
    // not to react to — including them re-triggers this effect the moment load() calls
    // setSynergyLoading(true), which cancels the very fetch it just started before it can
    // ever resolve, leaving synergyLoading stuck at true forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, commander?.oracle_id])

  // Card tags used across the deck, most-represented first — replaces the old EDHREC-driven
  // "Deck Themes" panel with our own tagging system so it works the same for every card,
  // not just ones EDHREC has recommendation data for.
  const deckCardTagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const card of deckCards) {
      const tags = resolveCardTags(card, cardTagOverrides.get(card.oracle_id))
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  }, [deckCards, cardTagOverrides])

  const deckTagFilterCards = useMemo(() => {
    if (!deckTagFilter) return []
    return deckCards.filter((card) => resolveCardTags(card, cardTagOverrides.get(card.oracle_id)).includes(deckTagFilter))
  }, [deckTagFilter, deckCards, cardTagOverrides])

  async function persist(patch: {
    cardIds?: string[]
    name?: string
    commanderId?: string
    commanderName?: string
    partnerCommanderId?: string | null
    partnerCommanderName?: string | null
    tags?: StoredDeck['tags']
    bracket?: Bracket | null
    wins?: number
    losses?: number
    tokenPrintingOverrides?: Record<string, string>
    cardPoolIds?: string[]
    wantIds?: string[]
    foilIds?: string[]
    lastScore?: StoredDeck['lastScore']
  }): Promise<void> {
    if (!storedDeck) return
    setStoredDeck({ ...storedDeck, ...patch })
    await window.api.updateDeck(storedDeck.id, patch)
  }

  function addWin(): void {
    if (!storedDeck) return
    persist({ wins: storedDeck.wins + 1 })
  }

  function removeWin(): void {
    if (!storedDeck) return
    persist({ wins: Math.max(0, storedDeck.wins - 1) })
  }

  function addLoss(): void {
    if (!storedDeck) return
    persist({ losses: storedDeck.losses + 1 })
  }

  function removeLoss(): void {
    if (!storedDeck) return
    persist({ losses: Math.max(0, storedDeck.losses - 1) })
  }

  async function handleToggleCard(card: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    const newIds = toggleCardInDeck(storedDeck.cardIds, deckCards, card)
    setCardsById((prev) => ({ ...prev, [card.id]: card }))
    const isAdding = newIds.length > storedDeck.cardIds.length
    // Adding a card to the deck means you have it — fold it into the Card Pool too, and clear
    // it off the Want list if it was there (you don't "want" a card you just added). Skipped
    // for basics — you always effectively "have" unlimited basics, so tracking them in either
    // staging list is meaningless.
    if (isAdding && !isBasicLand(card)) {
      await persist({
        cardIds: newIds,
        cardPoolIds: addIdToList(storedDeck.cardPoolIds, card.id),
        wantIds: storedDeck.wantIds.filter((id) => id !== card.id)
      })
    } else {
      await persist({ cardIds: newIds })
    }
  }

  async function toggleCardPool(card: ScryfallCard): Promise<void> {
    if (!storedDeck || isBasicLand(card)) return
    const next = toggleIdInList(storedDeck.cardPoolIds, card.id)
    setCardsById((prev) => ({ ...prev, [card.id]: card }))
    await persist({ cardPoolIds: next })
  }

  async function toggleWant(card: ScryfallCard): Promise<void> {
    if (!storedDeck || isBasicLand(card)) return
    const next = toggleIdInList(storedDeck.wantIds, card.id)
    setCardsById((prev) => ({ ...prev, [card.id]: card }))
    await persist({ wantIds: next })
  }

  // A card can sit in the deck's cardIds and the Card Pool's cardPoolIds simultaneously (a
  // deck card is always also pooled), so a printing change from ANY one of the three lists
  // has to propagate to whichever of the others also happens to reference the same old id —
  // otherwise whichever list wasn't updated keeps pointing at the old printing, which only
  // becomes visible later once the card moves between lists and the stale copy is all
  // that's left. cardIds is occurrence-aware (duplicate basics); the other two never have
  // duplicate ids, so a plain full-list swap is correct for them.
  function syncedListsAfterPrintingChange(
    oldId: string,
    newId: string,
    occurrence: number
  ): { cardIds: string[]; cardPoolIds: string[]; wantIds: string[] } {
    if (!storedDeck) return { cardIds: [], cardPoolIds: [], wantIds: [] }
    return {
      cardIds: storedDeck.cardIds.includes(oldId)
        ? swapPrintingAtOccurrence(storedDeck.cardIds, oldId, occurrence, newId)
        : storedDeck.cardIds,
      cardPoolIds: storedDeck.cardPoolIds.includes(oldId)
        ? swapPrinting(storedDeck.cardPoolIds, oldId, newId)
        : storedDeck.cardPoolIds,
      wantIds: storedDeck.wantIds.includes(oldId) ? swapPrinting(storedDeck.wantIds, oldId, newId) : storedDeck.wantIds
    }
  }

  async function handlePoolPrintingChange(oldId: string, newCard: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    const synced = syncedListsAfterPrintingChange(oldId, newCard.id, 0)
    setCardsById((prev) => ({ ...prev, [newCard.id]: newCard }))
    setViewingSlotId(newCard.id)
    await persist(synced)
  }

  async function handleWantPrintingChange(oldId: string, newCard: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    const synced = syncedListsAfterPrintingChange(oldId, newCard.id, 0)
    setCardsById((prev) => ({ ...prev, [newCard.id]: newCard }))
    setViewingSlotId(newCard.id)
    await persist(synced)
  }

  async function moveToWant(card: ScryfallCard): Promise<void> {
    if (!storedDeck || isBasicLand(card)) return
    await persist({
      cardPoolIds: storedDeck.cardPoolIds.filter((id) => id !== card.id),
      wantIds: addIdToList(storedDeck.wantIds, card.id)
    })
  }

  async function moveToPool(card: ScryfallCard): Promise<void> {
    if (!storedDeck || isBasicLand(card)) return
    await persist({
      wantIds: storedDeck.wantIds.filter((id) => id !== card.id),
      cardPoolIds: addIdToList(storedDeck.cardPoolIds, card.id)
    })
  }

  function handlePoolWantContextMenu(list: 'pool' | 'want', card: ScryfallCard, e: React.MouseEvent): void {
    e.preventDefault()
    setPoolWantContextMenu({ card, list, x: e.clientX, y: e.clientY })
  }

  async function handleRemoveId(id: string): Promise<void> {
    if (!storedDeck) return
    const idx = storedDeck.cardIds.indexOf(id)
    if (idx === -1) return
    const newIds = [...storedDeck.cardIds.slice(0, idx), ...storedDeck.cardIds.slice(idx + 1)]
    await persist({ cardIds: newIds })
  }

  async function handlePrintingChange(oldId: string, newCard: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    const synced = syncedListsAfterPrintingChange(oldId, newCard.id, viewingSlotOccurrence)
    setCardsById((prev) => ({ ...prev, [newCard.id]: newCard }))
    setViewingSlotId(newCard.id)
    setViewingSlotOccurrence(0)
    await persist(synced)
  }

  async function handleCommanderPrintingChange(newCard: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    setCardsById((prev) => ({ ...prev, [newCard.id]: newCard }))
    setViewingSlotId(newCard.id)
    await persist({ commanderId: newCard.id, commanderName: newCard.name })
  }

  async function handlePartnerPrintingChange(newCard: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    setCardsById((prev) => ({ ...prev, [newCard.id]: newCard }))
    setViewingSlotId(newCard.id)
    await persist({ partnerCommanderId: newCard.id, partnerCommanderName: newCard.name })
  }

  async function handleRemovePartner(): Promise<void> {
    await persist({ partnerCommanderId: null, partnerCommanderName: null })
  }

  async function handlePickPartner(card: ScryfallCard): Promise<void> {
    setAddingPartner(false)
    setPartnerQuery('')
    setCardsById((prev) => ({ ...prev, [card.id]: card }))
    await persist({ partnerCommanderId: card.id, partnerCommanderName: card.name })
  }

  // Only ever called for basic lands (see addBasicLand below) — never touches Card Pool/Want,
  // since tracking basics there is meaningless (you always effectively have unlimited basics).
  async function addCardIdToDeck(id: string): Promise<void> {
    if (!storedDeck) return
    await persist({ cardIds: [...storedDeck.cardIds, id] })
  }

  // First copy of a given basic land name in this deck: prefer a printing from the
  // commander's own set (matches the deck's "flavor"), falling back to whichever printing
  // released closest to the commander's release date if that set never printed this basic.
  async function findDefaultBasicPrinting(name: string): Promise<ScryfallCard | null> {
    const exclusion = BASE_EXCLUSION_TERMS.join(' ')
    if (commander?.set) {
      const setResult = await window.api.searchCards(`!"${name}" set:${commander.set} ${exclusion}`, {
        order: 'released',
        dir: 'desc'
      })
      if (!isError(setResult)) {
        const setMatch = (setResult as ScryfallSearchResult).data?.[0]
        if (setMatch) return setMatch
      }
    }
    const allResult = await window.api.searchCards(`!"${name}" ${exclusion}`, {
      order: 'released',
      dir: 'desc'
    })
    if (isError(allResult)) return null
    const list = (allResult as ScryfallSearchResult).data ?? []
    if (list.length === 0) return null
    if (!commander?.released_at) return list[0]

    const commanderDate = new Date(commander.released_at).getTime()
    return list.reduce((closest, card) => {
      const diff = Math.abs(new Date(card.released_at).getTime() - commanderDate)
      const closestDiff = Math.abs(new Date(closest.released_at).getTime() - commanderDate)
      return diff < closestDiff ? card : closest
    }, list[0])
  }

  async function addBasicLand(name: string): Promise<void> {
    if (!storedDeck) return
    const existing = basicLandCounts.get(name)
    if (existing) {
      await addCardIdToDeck(existing.sampleId)
      return
    }
    const found = await findDefaultBasicPrinting(name)
    if (!found) return
    setCardsById((prev) => ({ ...prev, [found.id]: found }))
    await addCardIdToDeck(found.id)
  }

  async function removeBasicLand(name: string): Promise<void> {
    if (!storedDeck) return
    const ids = [...storedDeck.cardIds]
    for (let i = ids.length - 1; i >= 0; i--) {
      const card = cardsById[ids[i]]
      if (card && card.name === name) {
        ids.splice(i, 1)
        break
      }
    }
    await persist({ cardIds: ids })
  }

  async function handleViewToken(token: DerivedToken): Promise<void> {
    const result = await window.api.getCard(token.id)
    if (isError(result)) return
    setViewingKind('token')
    setViewingTokenName(token.name)
    setViewingCard(result as ScryfallCard)
  }

  async function handleTokenPrintingChange(newCard: ScryfallCard): Promise<void> {
    if (!storedDeck || !viewingTokenName) return
    const next = { ...storedDeck.tokenPrintingOverrides, [viewingTokenName]: newCard.id }
    setViewingCard(newCard)
    await persist({ tokenPrintingOverrides: next })
  }

  function openTagSearch(tag: string): void {
    setActiveSearchTags([tag])
    setView('tagSearch')
  }

  // A true swap — the dragged card takes the target's exact spot and vice versa, rather than
  // removing the dragged card first and re-inserting before the target. That "remove then
  // insert" approach shifts everything between the two positions by one slot, and for the
  // immediate-right-neighbor case it puts the dragged card right back where it started
  // (removing it shifts the target back into the same index), which looked like dragging
  // onto the very next slot simply did nothing.
  async function handleReorder(draggedCardId: string, targetCardId: string): Promise<void> {
    if (!storedDeck || draggedCardId === targetCardId) return
    const ids = [...storedDeck.cardIds]
    const fromIdx = ids.indexOf(draggedCardId)
    const toIdx = ids.indexOf(targetCardId)
    if (fromIdx === -1 || toIdx === -1) return
    ;[ids[fromIdx], ids[toIdx]] = [ids[toIdx], ids[fromIdx]]
    await persist({ cardIds: ids })
  }

  // Dropping a card back onto the side it came from is a no-op (not a removal) — only an
  // actual cross-side drop should move anything. This is the fallback for dropping on empty
  // column space (not on a specific card) — a plain add/remove, never a swap.
  function handleHotSwapDrop(target: 'deck' | 'pool'): void {
    clearHotSwapHoverTimer()
    setHotSwapDragOverSide(null)
    if (!hotSwapDragCard || hotSwapDragSource === target) {
      setHotSwapDragCard(null)
      setHotSwapDragSource(null)
      return
    }
    if (target === 'deck') handleToggleCard(hotSwapDragCard)
    else handleRemoveId(hotSwapDragCard.id)
    setHotSwapDragCard(null)
    setHotSwapDragSource(null)
  }

  function clearHotSwapHoverTimer(): void {
    if (hotSwapHoverTimer.current !== null) {
      window.clearTimeout(hotSwapHoverTimer.current)
      hotSwapHoverTimer.current = null
    }
    setHotSwapHoverTargetId(null)
    setHotSwapSwapArmed(false)
  }

  // Single atomic patch for a swap — `outgoing` leaves the deck, `incoming` joins it. Doing
  // this as one persist() call matters: firing handleRemoveId() and handleToggleCard() back
  // to back both read the same stale `storedDeck` closure (React hasn't re-rendered between
  // them), so the second call's persist would silently overwrite the first's effect instead
  // of combining with it.
  async function performHotSwap(outgoing: ScryfallCard, incoming: ScryfallCard): Promise<void> {
    if (!storedDeck) return
    const idx = storedDeck.cardIds.indexOf(outgoing.id)
    const withoutOutgoing =
      idx === -1 ? storedDeck.cardIds : [...storedDeck.cardIds.slice(0, idx), ...storedDeck.cardIds.slice(idx + 1)]
    const newIds = [...withoutOutgoing, incoming.id]
    if (isBasicLand(incoming)) {
      await persist({ cardIds: newIds })
    } else {
      await persist({
        cardIds: newIds,
        cardPoolIds: addIdToList(storedDeck.cardPoolIds, incoming.id),
        wantIds: storedDeck.wantIds.filter((id) => id !== incoming.id)
      })
    }
  }

  // Holding a dragged card over a specific card on the other side *arms* a direct swap — the
  // ring finishes charging and stays lit, but nothing actually happens until the card is
  // released (see handleHotSwapCardDrop). Just hovering, even past the hold duration, never
  // moves anything on its own.
  function handleHotSwapHoverStart(target: ScryfallCard, targetSide: 'deck' | 'pool'): void {
    if (!hotSwapDragCard || hotSwapDragSource === targetSide) return
    setHotSwapHoverTargetId(target.id)
    setHotSwapSwapArmed(false)
    if (hotSwapHoverTimer.current !== null) window.clearTimeout(hotSwapHoverTimer.current)
    hotSwapHoverTimer.current = window.setTimeout(() => {
      setHotSwapSwapArmed(true)
      hotSwapHoverTimer.current = null
    }, HOT_SWAP_HOLD_MS)
  }

  function handleHotSwapHoverEnd(targetId: string): void {
    if (hotSwapHoverTargetId !== targetId) return
    clearHotSwapHoverTimer()
  }

  // Dropping directly on a specific card: a full swap if the hold armed it, otherwise the
  // same plain add/remove as dropping on empty column space.
  function handleHotSwapCardDrop(target: ScryfallCard, targetSide: 'deck' | 'pool', e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const dragged = hotSwapDragCard
    const armed = hotSwapSwapArmed && hotSwapHoverTargetId === target.id
    clearHotSwapHoverTimer()
    setHotSwapDragOverSide(null)
    if (!dragged || hotSwapDragSource === targetSide) {
      setHotSwapDragCard(null)
      setHotSwapDragSource(null)
      return
    }
    if (armed) {
      // targetSide 'deck' means target is currently in the deck and dragged is coming from
      // the pool — target is the outgoing card, dragged is incoming. Reversed for 'pool'.
      if (targetSide === 'deck') performHotSwap(target, dragged)
      else performHotSwap(dragged, target)
    } else if (targetSide === 'deck') {
      handleToggleCard(dragged)
    } else {
      handleRemoveId(dragged.id)
    }
    setHotSwapDragCard(null)
    setHotSwapDragSource(null)
  }

  function startRename(): void {
    if (!storedDeck) return
    setNameDraft(storedDeck.name)
    setEditingName(true)
  }

  async function commitRename(): Promise<void> {
    setEditingName(false)
    const trimmed = nameDraft.trim()
    if (!storedDeck || !trimmed || trimmed === storedDeck.name) return
    await persist({ name: trimmed })
  }

  function openRecommendations(tagSlug?: string): void {
    setInitialTag(tagSlug)
    setView('recommendations')
  }

  if (loading) {
    return (
      <div className="app__results">
        <p className="app__hint">Loading deck…</p>
      </div>
    )
  }

  if (error || !storedDeck) {
    return (
      <div className="app__results">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← My Decks
        </button>
        <p className="app__error">{error ?? 'Deck not found.'}</p>
      </div>
    )
  }

  if (view === 'recommendations' && commander) {
    return (
      <div className="app__results">
        <CommanderView
          commander={commander}
          backLabel="Back to deck"
          helpText="Click a card to add it to this deck — click it again to remove it. Right-click for more options."
          initialTag={initialTag}
          onBack={() => setView('deck')}
          onSelectCard={handleToggleCard}
          onAddToDeck={handleToggleCard}
          onAddToPool={toggleCardPool}
          onAddToWant={toggleWant}
          getMarkerForOracleId={getMarkerForOracleId}
          deckOracleIds={deckOracleIds}
        />
      </div>
    )
  }

  if (view === 'tagSearch') {
    return (
      <TagSearchView
        initialTags={activeSearchTags}
        onBack={() => setView('deck')}
        onSelectCard={handleToggleCard}
        onAddToPool={toggleCardPool}
        onAddToWant={toggleWant}
        getMarker={getMarker}
        deckOracleIds={deckOracleIds}
        colorIdentity={deckColorIdentity}
      />
    )
  }

  const trimmedSearch = searchQuery.trim()
  const searchQueryFull = trimmedSearch
    ? [...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, trimmedSearch].join(' ')
    : ''

  return (
    <div className="app__results">
      <div className="app__results-toolbar">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← My Decks
        </button>
        {editingName ? (
          <input
            className="app__search deck-builder__name-input"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          <h2 className="set-detail__title deck-builder__name" onClick={startRename} title="Click to rename">
            {storedDeck.name} <span className="deck-builder__edit-icon">✎</span>
          </h2>
        )}
        <div className="app__tabs">
          <button className={view === 'deck' ? 'is-active' : ''} onClick={() => setView('deck')}>
            Deck
          </button>
          <button className={view === 'cardPool' ? 'is-active' : ''} onClick={() => setView('cardPool')}>
            Card Pool
          </button>
          <button className={view === 'want' ? 'is-active' : ''} onClick={() => setView('want')}>
            Want
          </button>
          <button className={view === 'analytics' ? 'is-active' : ''} onClick={() => setView('analytics')}>
            Analytics
          </button>
          <button className={view === 'score' ? 'is-active' : ''} onClick={() => setView('score')}>
            Score
          </button>
          <button className={view === 'combos' ? 'is-active' : ''} onClick={() => setView('combos')}>
            Combos
          </button>
          <button
            className={view === 'recommendations' ? 'is-active' : ''}
            onClick={() => openRecommendations(undefined)}
            disabled={!commander}
          >
            EDHREC
          </button>
        </div>
      </div>

      <div className="deck-builder__header-row">
        {commander && (
          <button
            className="deck-builder__commander"
            title="Click to view or change printing"
            onClick={() => {
              setViewingKind('commander')
              setViewingSlotId(commander.id)
              setViewingCard(commander)
            }}
          >
            {commander.image_uris?.art_crop && (
              <span
                className="deck-builder__commander-art-bg"
                style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
              />
            )}
            <div className="deck-builder__commander-content">
              {commander.image_uris?.small && (
                <img
                  src={commander.image_uris.small}
                  alt={commander.name}
                  className="deck-builder__commander-image"
                />
              )}
              <div>
                <p className="card-detail__meta">Commander</p>
                <h3>{commander.name}</h3>
                <ColorPips colors={commander.color_identity} size={18} showName />
              </div>
            </div>
          </button>
        )}

        {partnerCommander && (
          <div className="deck-builder__commander-wrap">
            <button
              className="deck-builder__commander"
              title="Click to view or change printing"
              onClick={() => {
                setViewingKind('partner')
                setViewingSlotId(partnerCommander.id)
                setViewingCard(partnerCommander)
              }}
            >
              {partnerCommander.image_uris?.art_crop && (
                <span
                  className="deck-builder__commander-art-bg"
                  style={{ backgroundImage: `url(${partnerCommander.image_uris.art_crop})` }}
                />
              )}
              <div className="deck-builder__commander-content">
                {partnerCommander.image_uris?.small && (
                  <img
                    src={partnerCommander.image_uris.small}
                    alt={partnerCommander.name}
                    className="deck-builder__commander-image"
                  />
                )}
                <div>
                  <p className="card-detail__meta">
                    {secondMode === 'background' ? 'Background' : 'Partner'}
                  </p>
                  <h3>{partnerCommander.name}</h3>
                  <ColorPips colors={partnerCommander.color_identity} size={18} showName />
                </div>
              </div>
            </button>
            <button className="link-button" onClick={handleRemovePartner}>
              Remove
            </button>
          </div>
        )}

        {!partnerCommander && secondMode && !addingPartner && (
          <button className="deck-builder__add-partner" onClick={() => setAddingPartner(true)}>
            + Choose {secondMode === 'background' ? 'a Background' : 'a partner'}
          </button>
        )}

        <div className="deck-builder__header-block">
          <h3 className="section-heading">Bracket</h3>
          <div className="bracket-row">
            {BRACKETS.map((b) => {
              const isActive = storedDeck.bracket === b
              const color = bracketColor(b)
              return (
                <button
                  key={b}
                  className={`bracket-chip ${isActive ? 'is-active' : ''}`}
                  title={BRACKET_LABELS[b]}
                  style={
                    isActive
                      ? { background: color, borderColor: color, color: '#1a1a1a' }
                      : { borderColor: color, color }
                  }
                  onClick={() => persist({ bracket: isActive ? null : b })}
                >
                  {b}
                </button>
              )
            })}
            {storedDeck.bracket && (
              <span className="bracket-row__label" style={{ color: bracketColor(storedDeck.bracket) }}>
                {BRACKET_LABELS[storedDeck.bracket]}
              </span>
            )}
          </div>
        </div>

        <div className="deck-builder__header-block">
          <h3 className="section-heading">Match Record</h3>
          <div className="record-row">
            <div className="record-control">
              <button
                className="record-button record-button--minus"
                onClick={removeWin}
                disabled={storedDeck.wins === 0}
              >
                −
              </button>
              <div className="record-control__value">
                <span className="record-control__count">{storedDeck.wins}</span>
                <span className="record-control__label">Wins</span>
              </div>
              <button className="record-button record-button--plus" onClick={addWin}>
                +
              </button>
            </div>
            <div className="record-control">
              <button
                className="record-button record-button--minus"
                onClick={removeLoss}
                disabled={storedDeck.losses === 0}
              >
                −
              </button>
              <div className="record-control__value">
                <span className="record-control__count">{storedDeck.losses}</span>
                <span className="record-control__label">Losses</span>
              </div>
              <button className="record-button record-button--plus" onClick={addLoss}>
                +
              </button>
            </div>
            {deckWinRate !== null && (
              <div className="record-winrate" style={{ color: winRateColor(deckWinRate) }}>
                {Math.round(deckWinRate * 100)}% win rate
              </div>
            )}
          </div>
        </div>
      </div>

      {addingPartner && secondMode && commander && (
        <div className="partner-picker">
          <div className="app__results-toolbar">
            <h3 className="section-heading">
              Choose {secondMode === 'background' ? 'a Background' : 'a partner'} for {commander.name}
            </h3>
            <button className="back-link" onClick={() => setAddingPartner(false)}>
              Cancel
            </button>
          </div>
          <input
            className="app__search"
            type="text"
            placeholder={secondMode === 'background' ? 'Search backgrounds…' : 'Search for a partner…'}
            value={partnerQuery}
            onChange={(e) => setPartnerQuery(e.target.value)}
            autoFocus
          />
          <CardResults
            query={[...BASE_EXCLUSION_TERMS, secondCommanderQuery(secondMode), partnerQuery.trim()]
              .filter(Boolean)
              .join(' ')}
            sort={SORT_OPTIONS[0]}
            emptyHint="No results."
            onSelect={handlePickPartner}
            rawText={partnerQuery.trim()}
          />
        </div>
      )}

      {view === 'deck' && (
        <>
      <div className="deck-builder__mid-section">
        {commander?.image_uris?.art_crop && (
          <span
            className="deck-builder__mid-section-art-bg"
            style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
          />
        )}
      <h3 className="section-heading">Card Tags</h3>
      <p className="app__hint">
        Auto-detected from the cards you've added, most-common first. Click one to search for more cards,
        or see which of this deck's cards already have it.
      </p>
      {deckCardTagCounts.length === 0 && <p className="app__hint">No tags detected yet — add some cards.</p>}
      <div className="tag-row">
        {(showAllTags ? deckCardTagCounts : deckCardTagCounts.slice(0, 10)).map(({ tag, count }) => {
          const maxCount = deckCardTagCounts[0]?.count ?? 1
          // Most-used tags read as vivid/accent-colored; less-represented tags fade toward
          // the neutral chip look, so the eye lands on the deck's dominant themes first.
          const pct = Math.round(15 + (count / maxCount) * 85)
          return (
            <div key={tag} className="tag-menu-wrapper">
              <button
                className="tag-chip"
                style={{
                  background: `color-mix(in srgb, var(--accent) ${pct}%, var(--panel))`,
                  borderColor: `color-mix(in srgb, var(--accent) ${pct}%, var(--border))`,
                  color: pct >= 60 ? '#fff' : 'var(--muted)'
                }}
                onClick={() => setOpenTagMenu(openTagMenu === tag ? null : tag)}
                title={`${count} card(s) in this deck`}
              >
                {tag} <span className="tag-chip__weight">{count}</span>
              </button>
              {openTagMenu === tag && (
                <>
                  <div className="tag-menu-backdrop" onClick={() => setOpenTagMenu(null)} />
                  <div className="tag-menu">
                    <button
                      onClick={() => {
                        setOpenTagMenu(null)
                        openTagSearch(tag)
                      }}
                    >
                      Search more cards
                    </button>
                    <button
                      onClick={() => {
                        setOpenTagMenu(null)
                        setDeckTagFilter(tag)
                      }}
                    >
                      See cards in this deck
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {!showAllTags && deckCardTagCounts.length > 10 && (
          <button className="tag-chip tag-chip--edit" onClick={() => setShowAllTags(true)}>
            Show More ({deckCardTagCounts.length - 10})
          </button>
        )}
      </div>

      {deckTagFilter && (
        <div className="deck-tag-filter">
          <div className="deck-tag-filter__header">
            <h3 className="section-heading">Cards in this deck tagged "{deckTagFilter}"</h3>
            <button className="deck-tag-filter__close" onClick={() => setDeckTagFilter(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="card-grid">
            {deckTagFilterCards.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                onSelect={(c) => {
                  setViewingKind('card')
                  setViewingSlotId(c.id)
                  setViewingSlotOccurrence(0)
                  setViewingCard(c)
                }}
                marker={getMarker(card)}
                isFoil={foilIdSet.has(card.id)}
              />
            ))}
          </div>
        </div>
      )}

      <h3 className="section-heading">Basic Lands</h3>
      <div className="basic-land-row">
        {visibleBasicLandNames.map((name) => {
          const count = basicLandCounts.get(name)?.count ?? 0
          const color = BASIC_LAND_COLOR[name]
          return (
            <div key={name} className="record-control">
              <button
                className="record-button record-button--minus"
                onClick={() => removeBasicLand(name)}
                disabled={count === 0}
              >
                −
              </button>
              <div className="record-control__value">
                <span className="record-control__count">{count}</span>
                <ColorPips colors={color ? [color] : []} size={18} />
              </div>
              <button className="record-button record-button--plus" onClick={() => addBasicLand(name)}>
                +
              </button>
            </div>
          )
        })}
      </div>

      <h3 className="section-heading">Add Cards</h3>
      <input
        className="app__search"
        type="text"
        placeholder="Search cards to add — click a result to add or remove it…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      {trimmedSearch && (
        <CardResults
          query={searchQueryFull}
          sort={SORT_OPTIONS[0]}
          emptyHint="No cards found."
          onSelect={handleToggleCard}
          isInDeck={(card) => deckOracleIds.has(card.oracle_id)}
          getMarker={getMarker}
          rawText={trimmedSearch}
        />
      )}
      </div>

      <div className="deck-builder__deck-heading-row">
        <h3 className="section-heading" ref={deckSidebar.topRef}>
          Deck ({totalDeckSize} card{totalDeckSize === 1 ? '' : 's'})
        </h3>
        <button className="secondary-button" onClick={() => setHotSwapOpen(true)} disabled={deckCards.length === 0}>
          🔄 Hot Swap
        </button>
      </div>
      {deckCards.length === 0 && <p className="app__hint">No cards added yet.</p>}
      {deckCards.length > 0 && (
        <div className="commander-view__body">
          <nav className="commander-view__toc">
            <button className="commander-view__toc-top" onClick={deckSidebar.scrollToTop}>
              ↑ Back to Top
            </button>
            {categoryGroups.map(({ category, cards }) => (
              <button
                key={category}
                className="commander-view__toc-item"
                onClick={() => deckSidebar.scrollToSection(category)}
              >
                <span
                  className="commander-view__section-dash"
                  style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                />
                {DECK_CATEGORY_LABELS[category] ?? category} ({cards.length})
              </button>
            ))}
          </nav>

          <div className="commander-view__sections">
            {categoryGroups.map(({ category, cards }) => {
              const isCollapsed = deckSidebar.collapsed.has(category)
              return (
                <section
                  key={category}
                  ref={(el) => {
                    if (el) deckSidebar.sectionRefs.current.set(category, el)
                  }}
                  className="commander-view__section"
                >
                  <button
                    className={`commander-view__section-heading commander-view__section-heading--toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                    onClick={() => deckSidebar.toggleCollapsed(category)}
                  >
                    <span
                      className="commander-view__section-dash"
                      style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                    />
                    {DECK_CATEGORY_LABELS[category] ?? category}
                    {` (${cards.length})`}
                    <span className="commander-view__section-chevron">▾</span>
                  </button>
                  {!isCollapsed && (
                    <div className="card-grid">
                      {cards.map((card, index) => {
                        // Same-id duplicates (basic lands) stay in their original relative
                        // order through categorization/sorting, so counting same-id cards
                        // before this one here matches this card's occurrence in
                        // storedDeck.cardIds.
                        const occurrence = cards.slice(0, index).filter((other) => other.id === card.id).length
                        const slotKey = `${card.id}-${index}`
                        return (
                          <div
                            key={slotKey}
                            className={`deck-card-slot ${draggedId === card.id ? 'is-dragging' : ''} ${dragOverId === slotKey ? 'is-drag-over' : ''}`}
                            draggable
                            onDragStart={(e) => {
                              setDraggedId(card.id)
                              e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragEnd={() => {
                              setDraggedId(null)
                              setDragOverId(null)
                            }}
                            onDragEnter={() => setDragOverId(slotKey)}
                            onDragLeave={() => setDragOverId((prev) => (prev === slotKey ? null : prev))}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              if (draggedId) handleReorder(draggedId, card.id)
                              setDraggedId(null)
                              setDragOverId(null)
                            }}
                            title="Drag to reorder"
                          >
                            <CardTile
                              card={card}
                              onSelect={(c) => {
                                setViewingKind('card')
                                setViewingSlotId(c.id)
                                setViewingSlotOccurrence(occurrence)
                                setViewingCard(c)
                              }}
                              isFoil={foilIdSet.has(foilKeyFor(card.id, occurrence))}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <>
          <h3 className="section-heading">Tokens Needed</h3>
          <div className="token-grid">
            {tokens.map((token) => (
              <button
                key={token.id}
                className="token-tile"
                title={`${token.type_line} — click to change printing`}
                onClick={() => handleViewToken(token)}
              >
                <img src={scryfallImageUrl(token.id)} alt={token.name} loading="lazy" />
                <span>{token.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
        </>
      )}

      {view === 'cardPool' && (
        <>
          <h3 className="section-heading">Card Pool</h3>
          <p className="app__hint">
            Cards you have that could slot into this deck. Search to mark a card as owned — click it again
            to remove it from the pool. This is just a reference list; cards don't count toward the deck
            until you add them from the Deck tab.
          </p>
          <input
            className="app__search"
            type="text"
            placeholder="Search your cards…"
            value={cardPoolQuery}
            onChange={(e) => setCardPoolQuery(e.target.value)}
          />
          {cardPoolQuery.trim() && (
            <CardResults
              query={[...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, cardPoolQuery.trim()].join(' ')}
              sort={SORT_OPTIONS[0]}
              emptyHint="No cards found."
              onSelect={toggleCardPool}
              isInDeck={(card) => deckOracleIds.has(card.oracle_id)}
              badgeLabel="✓ In Deck"
              rawText={cardPoolQuery.trim()}
            />
          )}
          <h3 className="section-heading" ref={poolSidebar.topRef}>
            In Your Pool ({cardPoolCards.length})
          </h3>
          <p className="app__hint">Click a card to inspect it or change printing — right-click for more options.</p>
          {cardPoolCards.length === 0 && <p className="app__hint">No cards marked as owned yet.</p>}
          {cardPoolCards.length > 0 && (
            <div className="commander-view__body">
              <nav className="commander-view__toc">
                <button className="commander-view__toc-top" onClick={poolSidebar.scrollToTop}>
                  ↑ Back to Top
                </button>
                {poolCategoryGroups.map(({ category, cards }) => (
                  <button
                    key={category}
                    className="commander-view__toc-item"
                    onClick={() => poolSidebar.scrollToSection(category)}
                  >
                    <span
                      className="commander-view__section-dash"
                      style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                    />
                    {DECK_CATEGORY_LABELS[category] ?? category} ({cards.length})
                  </button>
                ))}
              </nav>

              <div className="commander-view__sections">
                {poolCategoryGroups.map(({ category, cards }) => {
                  const isCollapsed = poolSidebar.collapsed.has(category)
                  return (
                    <section
                      key={category}
                      ref={(el) => {
                        if (el) poolSidebar.sectionRefs.current.set(category, el)
                      }}
                      className="commander-view__section"
                    >
                      <button
                        className={`commander-view__section-heading commander-view__section-heading--toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                        onClick={() => poolSidebar.toggleCollapsed(category)}
                      >
                        <span
                          className="commander-view__section-dash"
                          style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                        />
                        {DECK_CATEGORY_LABELS[category] ?? category}
                        {` (${cards.length})`}
                        <span className="commander-view__section-chevron">▾</span>
                      </button>
                      {!isCollapsed && (
                        <div className="card-grid">
                          {cards.map((card) => (
                            <CardTile
                              key={card.id}
                              card={card}
                              onSelect={(c) => {
                                setViewingKind('poolCard')
                                setViewingSlotId(c.id)
                                setViewingCard(c)
                              }}
                              onContextMenu={(c, e) => handlePoolWantContextMenu('pool', c, e)}
                              inDeck={deckOracleIds.has(card.oracle_id)}
                              badgeLabel="✓ In Deck"
                              isFoil={foilIdSet.has(card.id)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'want' && (
        <>
          <h3 className="section-heading">Want</h3>
          <p className="app__hint">
            Cards you want to find for this deck. Search to add one to the list — click it again to remove
            it. Just a reference list, same as Card Pool.
          </p>
          <input
            className="app__search"
            type="text"
            placeholder="Search for cards you want…"
            value={wantQuery}
            onChange={(e) => setWantQuery(e.target.value)}
          />
          {wantQuery.trim() && (
            <CardResults
              query={[...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, wantQuery.trim()].join(' ')}
              sort={SORT_OPTIONS[0]}
              emptyHint="No cards found."
              onSelect={toggleWant}
              badgeLabel="✓ Wanted"
              // Want never gets an outline — just the badge, driven independently of isInDeck.
              getBadge={(card) => storedDeck.wantIds.includes(card.id)}
              rawText={wantQuery.trim()}
            />
          )}
          <h3 className="section-heading" ref={wantSidebar.topRef}>
            Wanted ({wantCards.length})
          </h3>
          <p className="app__hint">Click a card to inspect it or change printing — right-click for more options.</p>
          {wantCards.length === 0 && <p className="app__hint">Nothing on the want list yet.</p>}
          {wantCards.length > 0 && (
            <div className="commander-view__body">
              <nav className="commander-view__toc">
                <button className="commander-view__toc-top" onClick={wantSidebar.scrollToTop}>
                  ↑ Back to Top
                </button>
                {wantCategoryGroups.map(({ category, cards }) => (
                  <button
                    key={category}
                    className="commander-view__toc-item"
                    onClick={() => wantSidebar.scrollToSection(category)}
                  >
                    <span
                      className="commander-view__section-dash"
                      style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                    />
                    {DECK_CATEGORY_LABELS[category] ?? category} ({cards.length})
                  </button>
                ))}
              </nav>

              <div className="commander-view__sections">
                {wantCategoryGroups.map(({ category, cards }) => {
                  const isCollapsed = wantSidebar.collapsed.has(category)
                  return (
                    <section
                      key={category}
                      ref={(el) => {
                        if (el) wantSidebar.sectionRefs.current.set(category, el)
                      }}
                      className="commander-view__section"
                    >
                      <button
                        className={`commander-view__section-heading commander-view__section-heading--toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                        onClick={() => wantSidebar.toggleCollapsed(category)}
                      >
                        <span
                          className="commander-view__section-dash"
                          style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                        />
                        {DECK_CATEGORY_LABELS[category] ?? category}
                        {` (${cards.length})`}
                        <span className="commander-view__section-chevron">▾</span>
                      </button>
                      {!isCollapsed && (
                        <div className="card-grid">
                          {cards.map((card) => (
                            <CardTile
                              key={card.id}
                              card={card}
                              onSelect={(c) => {
                                setViewingKind('wantCard')
                                setViewingSlotId(c.id)
                                setViewingCard(c)
                              }}
                              onContextMenu={(c, e) => handlePoolWantContextMenu('want', c, e)}
                              isFoil={foilIdSet.has(card.id)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'analytics' && (
        <DeckAnalyticsView
          deckCards={deckCards}
          deckColorIdentity={deckColorIdentity}
          basicLandCounts={basicLandCounts}
          deckCardTagCounts={deckCardTagCounts}
          totalDeckSize={totalDeckSize}
          commanderCount={1 + (storedDeck?.partnerCommanderId ? 1 : 0)}
          commander={commander}
          cardTagOverrides={cardTagOverrides}
          onAddToDeck={handleToggleCard}
          onAddToPool={toggleCardPool}
          onAddToWant={toggleWant}
        />
      )}

      {view === 'score' && (
        <DeckScoreView
          deckCards={deckCards}
          deckColorIdentity={deckColorIdentity}
          deckCardTagCounts={deckCardTagCounts}
          totalDeckSize={totalDeckSize}
          synergyOracleIds={synergyOracleIds}
          synergyWeights={synergyWeights}
          synergyLoading={synergyLoading}
          commanderTags={commanderTagIndex?.tags.map((t) => ({ slug: t.slug, count: t.count })) ?? []}
          cardTagOverrides={cardTagOverrides}
          onScoreComputed={(overall, grade) =>
            persist({ lastScore: { overall, grade, recordedAt: new Date().toISOString() } })
          }
        />
      )}

      {view === 'combos' && (
        <DeckCombosView
          deckCards={deckCards}
          commanderNames={[commander?.name, partnerCommander?.name].filter((n): n is string => Boolean(n))}
        />
      )}

      {viewingCard && viewingKind === 'token' && (
        <CardDetail
          card={viewingCard}
          onClose={() => {
            setViewingCard(null)
            setViewingTokenName(null)
          }}
          deckMode={{
            onPrintingChange: (newCard) => handleTokenPrintingChange(newCard)
          }}
        />
      )}

      {viewingCard && viewingKind === 'commander' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          deckMode={{
            onPrintingChange: (newCard) => handleCommanderPrintingChange(newCard),
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            }
          }}
        />
      )}

      {viewingCard && viewingKind === 'partner' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          deckMode={{
            onPrintingChange: (newCard) => handlePartnerPrintingChange(newCard),
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            }
          }}
        />
      )}

      {viewingCard && viewingKind === 'card' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          deckMode={{
            onRemove: () => {
              if (viewingSlotId) handleRemoveId(viewingSlotId)
            },
            onPrintingChange: (newCard) => {
              if (viewingSlotId) handlePrintingChange(viewingSlotId, newCard)
            },
            isFoil: viewingSlotId ? foilIdSet.has(foilKeyFor(viewingSlotId, viewingSlotOccurrence)) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(foilKeyFor(viewingSlotId, viewingSlotOccurrence))
            }
          }}
        />
      )}

      {viewingCard && viewingKind === 'poolCard' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          deckMode={{
            onRemove: () => {
              if (viewingSlotId) toggleCardPool({ ...viewingCard, id: viewingSlotId })
            },
            removeLabel: 'Remove from Pool',
            onPrintingChange: (newCard) => {
              if (viewingSlotId) handlePoolPrintingChange(viewingSlotId, newCard)
            },
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            }
          }}
        />
      )}

      {viewingCard && viewingKind === 'wantCard' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          deckMode={{
            onRemove: () => {
              if (viewingSlotId) toggleWant({ ...viewingCard, id: viewingSlotId })
            },
            removeLabel: 'Remove from Want',
            onPrintingChange: (newCard) => {
              if (viewingSlotId) handleWantPrintingChange(viewingSlotId, newCard)
            },
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            }
          }}
        />
      )}

      {poolWantContextMenu && (
        <CardContextMenu
          x={poolWantContextMenu.x}
          y={poolWantContextMenu.y}
          onClose={() => setPoolWantContextMenu(null)}
          actions={[
            {
              label: 'Add to Deck',
              onSelect: () => {
                handleToggleCard(poolWantContextMenu.card)
                setPoolWantContextMenu(null)
              }
            },
            poolWantContextMenu.list === 'pool'
              ? {
                  label: 'Move to Want',
                  onSelect: () => {
                    moveToWant(poolWantContextMenu.card)
                    setPoolWantContextMenu(null)
                  }
                }
              : {
                  label: 'Move to Pool',
                  onSelect: () => {
                    moveToPool(poolWantContextMenu.card)
                    setPoolWantContextMenu(null)
                  }
                },
            poolWantContextMenu.list === 'pool'
              ? {
                  label: 'Remove from Pool',
                  onSelect: () => {
                    toggleCardPool(poolWantContextMenu.card)
                    setPoolWantContextMenu(null)
                  }
                }
              : {
                  label: 'Remove from Want',
                  onSelect: () => {
                    toggleWant(poolWantContextMenu.card)
                    setPoolWantContextMenu(null)
                  }
                }
          ]}
        />
      )}

      {hotSwapOpen && (
        <div className="hot-swap-overlay" onClick={() => setHotSwapOpen(false)}>
          <div className="hot-swap-modal" onClick={(e) => e.stopPropagation()}>
            <div className="deck-tag-filter__header">
              <h3 className="section-heading">Hot Swap</h3>
              <button className="deck-tag-filter__close" onClick={() => setHotSwapOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <p className="app__hint">
              Drag a card to the other column to swap it in or out of the deck — the Pool side only shows cards
              you aren't already running.
            </p>
            <div className="hot-swap-columns">
              <div
                className={`hot-swap-column ${hotSwapDragOverSide === 'deck' ? 'is-drag-over' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={() => setHotSwapDragOverSide('deck')}
                onDragLeave={() => setHotSwapDragOverSide((prev) => (prev === 'deck' ? null : prev))}
                onDrop={() => handleHotSwapDrop('deck')}
              >
                <div className="hot-swap-column__header">
                  <span className="hot-swap-column__label">Deck</span>
                  <select
                    value={hotSwapDeckCategory}
                    onChange={(e) => setHotSwapDeckCategory(e.target.value as CardCategory)}
                  >
                    {ALL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {DECK_CATEGORY_LABELS[cat] ?? cat}
                      </option>
                    ))}
                  </select>
                </div>
                {hotSwapDeckCards.length === 0 && (
                  <p className="app__hint">
                    No {(DECK_CATEGORY_LABELS[hotSwapDeckCategory] ?? hotSwapDeckCategory).toLowerCase()} in the
                    deck.
                  </p>
                )}
                <div className="card-grid card-grid--hotswap">
                  {hotSwapDeckCards.map((card) => (
                    <div
                      key={card.id}
                      className={`hot-swap-card ${
                        hotSwapDragCard?.id === card.id && hotSwapDragSource === 'deck' ? 'is-dragging' : ''
                      } ${hotSwapHoverTargetId === card.id ? 'is-swap-target' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        setHotSwapDragCard(card)
                        setHotSwapDragSource('deck')
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        clearHotSwapHoverTimer()
                        setHotSwapDragCard(null)
                        setHotSwapDragSource(null)
                        setHotSwapDragOverSide(null)
                      }}
                      onDragEnter={(e) => {
                        e.stopPropagation()
                        handleHotSwapHoverStart(card, 'deck')
                      }}
                      onDragLeave={() => handleHotSwapHoverEnd(card.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleHotSwapCardDrop(card, 'deck', e)}
                    >
                      <CardTile
                        card={card}
                        onSelect={(c) => {
                          setViewingKind('card')
                          setViewingSlotId(c.id)
                          setViewingCard(c)
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div
                className={`hot-swap-column ${hotSwapDragOverSide === 'pool' ? 'is-drag-over' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={() => setHotSwapDragOverSide('pool')}
                onDragLeave={() => setHotSwapDragOverSide((prev) => (prev === 'pool' ? null : prev))}
                onDrop={() => handleHotSwapDrop('pool')}
              >
                <div className="hot-swap-column__header">
                  <span className="hot-swap-column__label">Pool</span>
                  <select
                    value={hotSwapPoolCategory}
                    onChange={(e) => setHotSwapPoolCategory(e.target.value as CardCategory)}
                  >
                    {ALL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {DECK_CATEGORY_LABELS[cat] ?? cat}
                      </option>
                    ))}
                  </select>
                </div>
                {hotSwapPoolCards.length === 0 && (
                  <p className="app__hint">
                    No {(DECK_CATEGORY_LABELS[hotSwapPoolCategory] ?? hotSwapPoolCategory).toLowerCase()} available
                    in your pool.
                  </p>
                )}
                <div className="card-grid card-grid--hotswap">
                  {hotSwapPoolCards.map((card) => (
                    <div
                      key={card.id}
                      className={`hot-swap-card ${
                        hotSwapDragCard?.id === card.id && hotSwapDragSource === 'pool' ? 'is-dragging' : ''
                      } ${hotSwapHoverTargetId === card.id ? 'is-swap-target' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        setHotSwapDragCard(card)
                        setHotSwapDragSource('pool')
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        clearHotSwapHoverTimer()
                        setHotSwapDragCard(null)
                        setHotSwapDragSource(null)
                        setHotSwapDragOverSide(null)
                      }}
                      onDragEnter={(e) => {
                        e.stopPropagation()
                        handleHotSwapHoverStart(card, 'pool')
                      }}
                      onDragLeave={() => handleHotSwapHoverEnd(card.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleHotSwapCardDrop(card, 'pool', e)}
                    >
                      <CardTile
                        card={card}
                        onSelect={(c) => {
                          setViewingKind('poolCard')
                          setViewingSlotId(c.id)
                          setViewingCard(c)
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
