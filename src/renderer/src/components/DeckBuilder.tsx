import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import CardTile from './CardTile'
import CardResults from './CardResults'
import CardDetail from './CardDetail'
import CommanderView from './CommanderView'
import PlaytestGoldfishView from './PlaytestGoldfishView'
import ColorPips from './ColorPips'
import TagSearchView from './TagSearchView'
import TypeSearchView from './TypeSearchView'
import BasicLandModal from './BasicLandModal'
import DeckAnalyticsView from './DeckAnalyticsView'
import DeckScoreView from './DeckScoreView'
import DeckCombosView from './DeckCombosView'
import { SORT_OPTIONS } from './SortControl'
import { useCardResults } from '../useCardResults'
import { useCardNameAutocomplete } from '../useCardNameAutocomplete'
import { BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM } from '../queryBuilder'
import {
  addIdToList,
  BASIC_LAND_COLOR,
  basicLandNamesForIdentity,
  buildDecklistPdfGroups,
  CARD_CATEGORIES,
  categorizeCard,
  countBasicLands,
  DECK_GROUP_MODE_LABELS,
  deriveTokens,
  getIllegalReason,
  groupDeckCards,
  isBasicLand,
  primarySubtype,
  snowNameFor,
  swapPrinting,
  swapPrintingAtOccurrence,
  toggleCardInDeck,
  toggleIdInList,
  type CardCategory,
  type DeckGroupMode,
  type DerivedToken
} from '../deckLogic'
import CardContextMenu from './CardContextMenu'
import { scryfallImageUrl } from '../scryfallImage'
import { colorIdentityName } from '../colorIdentityName'
import { winRate, winRateColor } from '../winRate'
import { bracketColor } from '../bracketColor'
import { detectSecondCommanderMode, secondCommanderQuery } from '../partnerEligibility'
import { playSwapSound } from '../clickSound'
import { resolveCardTags, resolveDetailedCardTags, type CardTagOverride, type TaggerCardData } from '../cardTagging'
import { ARCHETYPE_OPTIONS } from '../deckScore'
import {
  isError,
  type Bracket,
  type CommanderTagIndex,
  type LogicRule,
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

type ImportMode = 'plaintext' | 'moxfield' | 'arena' | 'mtgo'

const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  plaintext: 'Plain Text',
  moxfield: 'Moxfield',
  arena: 'Arena',
  mtgo: 'MTGO'
}

const IMPORT_MODE_HINTS: Record<ImportMode, string> = {
  plaintext: 'Paste a plain decklist ("count name" per line, commander included — the same format Copy Plain Text produces).',
  moxfield:
    'Paste a Moxfield decklist ("count name (SET) number", with an optional trailing *F* for foil — the same format Copy for Moxfield produces).',
  arena:
    'Paste an Arena decklist (the "About" / "Commander" / "Deck" sections Arena\'s own export produces — the header lines are ignored).',
  mtgo: 'Paste an MTGO decklist ("count name" per line, main deck first, then a blank line, then the commander).'
}

const IMPORT_MODE_PLACEHOLDERS: Record<ImportMode, string> = {
  plaintext: '1 Doctor Doom, King of Latveria\n1 Sol Ring\n1 Command Tower\n9 Island\n…',
  moxfield: '1 Doctor Doom, King of Latveria (MSC) 880 *F*\n1 Sol Ring (LTC) 15\n9 Island (LTC) 314\n…',
  arena: 'About\nName Doctor Doom, King of Latveria\n\nCommander\n1 Doctor Doom, King of Latveria\n\nDeck\n1 Sol Ring\n9 Island\n…',
  mtgo: '1 Sol Ring\n9 Island\n…\n\n1 Doctor Doom, King of Latveria'
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
// pageTopRef is shared across all three instances (see DeckBuilder's own pageTopRef, attached to
// the outermost .app__results div) — "Back to Top" used to scroll to this section's OWN heading
// (e.g. "Deck (N cards)"), which sits well below the tab bar and "← My Decks" back link. That
// read as "back to top" only taking you to the first category, not actually to the top of the
// page — scrolling to the true shared top instead is what was asked for.
function useCategorySidebar(pageTopRef: RefObject<HTMLElement | null>, initiallyCollapsed: string[] = []) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(initiallyCollapsed))
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map())

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
    // pageTopRef points at .app__results itself — the actual scrolling element (overflow-y:
    // auto), not a child of it. scrollIntoView scrolls the nearest scrollable ANCESTOR of its
    // target, so calling it here tried to scroll whatever's above .app__results (nothing
    // actually scrolls there), which is why this silently did nothing. Scrolling the container
    // directly is the correct call when the ref IS the scroller, not content inside it.
    pageTopRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return { collapsed, toggleCollapsed, sectionRefs, scrollToSection, scrollToTop }
}

interface Props {
  deckId: string
  onBack: () => void
}

type View =
  | 'deck'
  | 'cardPool'
  | 'want'
  | 'analytics'
  | 'score'
  | 'combos'
  | 'recommendations'
  | 'tagSearch'
  | 'typeSearch'
  | 'goldfish'

// Global, not per-deck — same "plain localStorage flag" convention as DecksBrowser's own
// simplified-view toggle. Blurring the price is a screen-share/streaming concern more than a
// per-deck preference, so one flag covering every deck you open is the more useful default.
const DECK_PRICE_HIDDEN_KEY = 'mtgplatform.deckPriceHidden'

export default function DeckBuilder({ deckId, onBack }: Props) {
  const [storedDeck, setStoredDeck] = useState<StoredDeck | null>(null)
  // Mirrors storedDeck, but updated synchronously the instant persist() computes a new deck —
  // not on the next render like the state variable is. Clicking through several basic lands
  // in a row (or anything else calling persist() back-to-back) could otherwise have a second
  // call still reading the pre-first-click storedDeck from its own stale render closure,
  // building its own cardIds off that stale array, and silently clobbering the first click's
  // change when it saved. Every cardIds-mutating function below reads this ref, not the state
  // variable, as its base.
  const storedDeckRef = useRef<StoredDeck | null>(null)
  const [cardsById, setCardsById] = useState<Record<string, ScryfallCard>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('deck')
  const [initialTag, setInitialTag] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [addCardsDropdownOpen, setAddCardsDropdownOpen] = useState(false)
  const addCardsInputRef = useRef<HTMLInputElement>(null)
  const trimmedSearch = searchQuery.trim()
  const searchQueryFull = trimmedSearch
    ? [...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, trimmedSearch].join(' ')
    : ''
  // Lifted out of CardResults so the "Add Cards" search box can drive both the results grid
  // below and (for thumbnails only — see addCardByName) the typeahead dropdown off one
  // Scryfall call instead of two — see CardResults' `results` prop.
  const addCardsResults = useCardResults(searchQueryFull, SORT_OPTIONS[0], trimmedSearch)
  // The dropdown's name list comes from this instead — an in-memory card-name catalog filtered
  // locally with zero network round-trip, unlike addCardsResults above which fetches full card
  // objects (images included) from Scryfall and needs a debounce to stay usable.
  const addCardsAutocomplete = useCardNameAutocomplete(trimmedSearch)
  const DROPDOWN_CARD_CAP = 4
  const visibleAddCardsNames = addCardsAutocomplete.names.slice(0, DROPDOWN_CARD_CAP)
  // Once there are few enough matches to all fit in the grid below AND their images have
  // already loaded there, the dropdown is just a redundant, image-less copy of the same
  // handful of results — hide it and let the (now equally fast) grid take over.
  const addCardsFewMatchesLoaded =
    addCardsAutocomplete.names.length > 0 &&
    addCardsAutocomplete.names.length <= DROPDOWN_CARD_CAP &&
    addCardsAutocomplete.names.every((name) =>
      addCardsResults.cards.some((c) => c.name.toLowerCase() === name.toLowerCase())
    )
  const showAddCardsDropdown =
    addCardsDropdownOpen && Boolean(trimmedSearch) && addCardsAutocomplete.names.length > 0 && !addCardsFewMatchesLoaded
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
  const [deckCardContextMenu, setDeckCardContextMenu] = useState<{ card: ScryfallCard; x: number; y: number } | null>(
    null
  )
  const [viewingTokenName, setViewingTokenName] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  // Which slot is currently being dragged over — separate from draggedId (the card being
  // lifted) so the drop target itself can get a distinct highlight, not just the dragged card
  // dimming. Native HTML5 drag-and-drop gives no feedback at all otherwise.
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Shared "Back to Top" target for all three category sidebars below — see the outermost
  // <div className="app__results" ref={pageTopRef}> in the JSX, which holds the tab bar and
  // "← My Decks" back link.
  const pageTopRef = useRef<HTMLDivElement>(null)
  const deckSidebar = useCategorySidebar(pageTopRef)
  const poolSidebar = useCategorySidebar(pageTopRef, ['OnDeck'])
  const wantSidebar = useCategorySidebar(pageTopRef)
  const [hotSwapOpen, setHotSwapOpen] = useState(false)
  const [hotSwapDeckCategory, setHotSwapDeckCategory] = useState<CardCategory | 'Considering'>('Creature')
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
  // Scryfall Tagger data for every card in the deck, batch-fetched alongside the overrides
  // above — see resolveCardTags in cardTagging.ts for how this combines with the regex
  // fallback and this deck's own userCardTags additions.
  const [taggerDataByOracleId, setTaggerDataByOracleId] = useState<Map<string, TaggerCardData>>(new Map())
  const [activeSearchTags, setActiveSearchTags] = useState<string[]>([])
  const [activeSearchTerms, setActiveSearchTerms] = useState<string[]>([])
  // "Show More" opens a popup listing every tag in the deck, rather than expanding the inline
  // row in place — with the full specific+rollup tag list now shown (not just umbrella
  // categories), the inline row could otherwise grow long enough to push the rest of the page
  // down awkwardly.
  const [tagsModalOpen, setTagsModalOpen] = useState(false)
  // Carries the trigger chip's own screen position so the menu can be position:fixed
  // (viewport-anchored, like CardContextMenu) instead of position:absolute nested inside
  // .tag-row — the nested version kept losing stacking fights against later sibling sections
  // (.basic-land-row etc.) no matter how the z-indexes were tuned, since it was still bound by
  // every ancestor's own stacking context. Fixed positioning escapes all of that.
  const [openTagMenu, setOpenTagMenu] = useState<{ tag: string; x: number; y: number } | null>(null)

  // A fixed-position element tracks the viewport, not the scrollable panel it's opened from —
  // so once that panel scrolls, the menu stays glued to its old screen coordinates while the
  // chip that opened it moves away underneath. A capture-phase listener on document catches
  // scroll events from any scrollable ancestor (scroll doesn't bubble, but capture still sees
  // it), so this closes the menu the moment that happens rather than let it drift somewhere
  // that no longer corresponds to the chip it belongs to.
  useEffect(() => {
    if (!openTagMenu) return
    function handleScroll(): void {
      setOpenTagMenu(null)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [openTagMenu])

  const [deckTagFilter, setDeckTagFilter] = useState<string | null>(null)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>('plaintext')
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importingPdf, setImportingPdf] = useState(false)
  const [importMenuAnchor, setImportMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [importResult, setImportResult] = useState<{
    added: number
    removed: string[]
    outsideIdentity: string[]
    banned: string[]
    skippedCommander: string[]
    notFound: string[]
  } | null>(null)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [exportMenuAnchor, setExportMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [showCopyCheck, setShowCopyCheck] = useState(false)
  const [infoModal, setInfoModal] = useState<{ title: string; message: string } | null>(null)
  const [logicModalOpen, setLogicModalOpen] = useState(false)
  const [logicText, setLogicText] = useState('')
  const [logicError, setLogicError] = useState<string | null>(null)
  const [logicWarnings, setLogicWarnings] = useState<string[]>([])
  const [logicImporting, setLogicImporting] = useState(false)
  const [logicImportedCount, setLogicImportedCount] = useState<number | null>(null)

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
      storedDeckRef.current = deck
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
  // Deliberately NOT persisted (no localStorage, unlike DecksBrowser's simplified-view toggle) —
  // opening a deck should always start from the default Type grouping, not whatever mode was
  // last used somewhere else.
  const [deckGroupMode, setDeckGroupMode] = useState<DeckGroupMode>('type')
  const [poolGroupMode, setPoolGroupMode] = useState<DeckGroupMode>('type')
  const [wantGroupMode, setWantGroupMode] = useState<DeckGroupMode>('type')
  const [groupMenuAnchor, setGroupMenuAnchor] = useState<{ for: 'deck' | 'cardPool' | 'want'; x: number; y: number } | null>(
    null
  )
  const categoryGroups = useMemo(() => groupDeckCards(deckCards, deckGroupMode), [deckCards, deckGroupMode])
  const basicLandCounts = useMemo(() => countBasicLands(deckCards), [deckCards])
  const [basicPipMenu, setBasicPipMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  const [basicLandModal, setBasicLandModal] = useState<
    { mode: 'snow'; name: string } | { mode: 'printing'; name: string; printingTarget: 'regular' | 'snow' } | null
  >(null)
  const deckColorIdentity = useMemo(() => {
    const colors = new Set<string>()
    for (const c of commander?.color_identity ?? []) colors.add(c)
    for (const c of partnerCommander?.color_identity ?? []) colors.add(c)
    return [...colors]
  }, [commander, partnerCommander])
  const visibleBasicLandNames = useMemo(() => basicLandNamesForIdentity(deckColorIdentity), [deckColorIdentity])
  // Resolved default printing per exact card name (regular AND Snow-Covered, for every color in
  // the deck's identity) — the same commander-set / sibling-set / closest-release-date search
  // addBasicLand already used, just run for every relevant name up front instead of only the
  // one the user happens to click. Converting to Snow for the first time then reads straight
  // from here instead of waiting on a live search at click time.
  const [preloadedBasicPrintings, setPreloadedBasicPrintings] = useState<Record<string, ScryfallCard>>({})

  useEffect(() => {
    if (!commander) return
    let cancelled = false

    async function preload(): Promise<void> {
      const names = visibleBasicLandNames.flatMap((name) => [name, snowNameFor(name)])
      const results = await Promise.all(
        names.map(async (name) => {
          // A copy already in the deck (whatever art it happens to be) beats spending a search
          // resolving a "default" that would just be overridden by that existing sample anyway.
          const existing = storedDeckRef.current?.cardIds.map((id) => cardsById[id]).find((c) => c?.name === name)
          return existing ?? findDefaultBasicPrinting(name)
        })
      )
      if (cancelled) return
      const found = results.filter((c): c is ScryfallCard => Boolean(c))
      if (found.length === 0) return
      setPreloadedBasicPrintings((prev) => {
        const next = { ...prev }
        for (const c of found) next[c.name] = c
        return next
      })
      setCardsById((prev) => {
        const next = { ...prev }
        for (const c of found) if (!next[c.id]) next[c.id] = c
        return next
      })
    }

    preload()
    return () => {
      cancelled = true
    }
    // Deliberately keyed off just the commander and the set of relevant names — re-running this
    // on every cardsById/storedDeck change (which the lookups inside DO read) would mean firing
    // it again after every single card add/remove in the deck, not just once per deck opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commander?.oracle_id, visibleBasicLandNames])

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
  const flippedIdSet = useMemo(() => new Set(storedDeck?.flippedIds ?? []), [storedDeck?.flippedIds])
  const consideringIdSet = useMemo(() => new Set(storedDeck?.consideringIds ?? []), [storedDeck?.consideringIds])

  // The deck's own 100 cards only — Card Pool and Want are reference lists of cards that don't
  // count toward the deck (see their own "Just a reference list" hints), so they're deliberately
  // left out here even though the same cardsById cache covers them too. Foil-aware (a foiled
  // copy prices differently), using the same occurrence-keyed foilKeyFor scheme as the rest of
  // the deck grid so a duplicate basic's later copies aren't all priced as the first one's foil
  // status.
  const deckPrice = useMemo(() => {
    if (!storedDeck) return null
    let total = 0
    function addPrice(id: string, isFoil: boolean): void {
      const card = cardsById[id]
      if (!card) return
      const priceStr = (isFoil ? card.prices?.usd_foil : card.prices?.usd) ?? card.prices?.usd ?? card.prices?.usd_foil
      if (priceStr) total += parseFloat(priceStr)
    }
    addPrice(storedDeck.commanderId, foilIdSet.has(storedDeck.commanderId))
    if (storedDeck.partnerCommanderId) {
      addPrice(storedDeck.partnerCommanderId, foilIdSet.has(storedDeck.partnerCommanderId))
    }
    const occurrenceCount = new Map<string, number>()
    for (const id of storedDeck.cardIds) {
      const occurrence = occurrenceCount.get(id) ?? 0
      occurrenceCount.set(id, occurrence + 1)
      addPrice(id, foilIdSet.has(foilKeyFor(id, occurrence)))
    }
    return total
  }, [storedDeck, cardsById, foilIdSet])

  const [priceHidden, setPriceHidden] = useState(() => localStorage.getItem(DECK_PRICE_HIDDEN_KEY) === '1')

  function toggleDeckPriceHidden(): void {
    setPriceHidden((prev) => {
      const next = !prev
      localStorage.setItem(DECK_PRICE_HIDDEN_KEY, next ? '1' : '0')
      return next
    })
  }

  // "On Deck" is its own bucket ahead of the type categories — a pool card already in the
  // deck has nothing left to do with it, so it's worth calling out separately rather than
  // mixed in among the cards still worth considering.
  const poolCategoryGroups = useMemo(() => {
    const onDeck = cardPoolCards.filter((c) => deckOracleIds.has(c.oracle_id))
    const rest = cardPoolCards.filter((c) => !deckOracleIds.has(c.oracle_id))
    const groups = [...groupDeckCards(rest, poolGroupMode)]
    if (onDeck.length > 0) {
      groups.push({
        category: 'OnDeck',
        label: DECK_CATEGORY_LABELS.OnDeck,
        dashColor: DECK_CATEGORY_DASH_COLORS.OnDeck,
        cards: onDeck
      })
    }
    return groups
  }, [cardPoolCards, deckOracleIds, poolGroupMode])

  const wantCategoryGroups = useMemo(() => groupDeckCards(wantCards, wantGroupMode), [wantCards, wantGroupMode])

  // Hot Swap's two columns: the deck side is just "cards of this type currently in the deck";
  // the pool side deliberately excludes cards already in the deck (same "on deck" cards the
  // Card Pool tab carves out) — nothing to swap in for a card you're already running.
  // "Considering" is a synthetic category only the deck side offers — it cuts across the real
  // type categories to surface exactly the cards flagged for possible removal, which is the
  // whole point of pairing them up against the Pool side to find a replacement.
  const hotSwapDeckCards = useMemo(
    () =>
      hotSwapDeckCategory === 'Considering'
        ? deckCards.filter((c) => consideringIdSet.has(c.id))
        : deckCards.filter((c) => categorizeCard(c) === hotSwapDeckCategory),
    [deckCards, hotSwapDeckCategory, consideringIdSet]
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

  // Same key scheme as foilKeyFor — remembers which face (front/back) a deck slot was last
  // showing, for transform/modal_dfc/reversible_card printings.
  async function toggleFlipped(key: string): Promise<void> {
    if (!storedDeck) return
    await persist({ flippedIds: toggleIdInList(storedDeck.flippedIds, key) })
  }

  // Keyed by plain card id, not by occurrence — unlike foil status, "considering this for
  // removal" is about the card itself; a duplicate basic land sharing that id gets flagged as a
  // set together, which is the rare case that only matters for lands anyway.
  async function toggleConsidering(id: string): Promise<void> {
    if (!storedDeck) return
    await persist({ consideringIds: toggleIdInList(storedDeck.consideringIds, id) })
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

  // Same batch-fetch shape as the overrides above, for Scryfall Tagger's own data.
  useEffect(() => {
    let cancelled = false
    const oracleIds = [...new Set(deckCards.map((c) => c.oracle_id))]
    if (oracleIds.length === 0) {
      setTaggerDataByOracleId(new Map())
      return
    }
    window.api.getTaggerDataBatch(oracleIds).then((map) => {
      if (cancelled) return
      setTaggerDataByOracleId(new Map(Object.entries(map)))
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
      // Full specific+rollup list, not resolveCardTags' umbrella-only summary — an umbrella-only
      // Card Tags list lost too much useful detail (every removal spell just read "Removal",
      // with no way to tell a board wipe from a one-for-one apart at a glance).
      const tags = resolveDetailedCardTags(
        card,
        cardTagOverrides.get(card.oracle_id),
        taggerDataByOracleId.get(card.oracle_id),
        storedDeck?.userCardTags?.[card.oracle_id]
      ).map((t) => t.label)
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  }, [deckCards, cardTagOverrides, taggerDataByOracleId, storedDeck?.userCardTags])

  const deckTagFilterCards = useMemo(() => {
    if (!deckTagFilter) return []
    return deckCards.filter((card) =>
      resolveDetailedCardTags(
        card,
        cardTagOverrides.get(card.oracle_id),
        taggerDataByOracleId.get(card.oracle_id),
        storedDeck?.userCardTags?.[card.oracle_id]
      ).some((t) => t.label === deckTagFilter)
    )
  }, [deckTagFilter, deckCards, cardTagOverrides, taggerDataByOracleId, storedDeck?.userCardTags])

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
    flippedIds?: string[]
    consideringIds?: string[]
    lastScore?: StoredDeck['lastScore']
    archetypeKey?: string
    logicFile?: StoredDeck['logicFile']
    userCardTags?: Record<string, string[]>
    proxyArtByKey?: Record<string, { front: string; back?: string }>
  }): Promise<void> {
    const base = storedDeckRef.current
    if (!base) return
    const updated = { ...base, ...patch }
    storedDeckRef.current = updated
    setStoredDeck(updated)
    await window.api.updateDeck(updated.id, patch)
  }

  // Per-deck card tag additions (see StoredDeck.userCardTags) — a card can function differently
  // in different decks, so a user-added tag only ever applies to this one deck's copy of it,
  // never the card globally. Purely additive: there's no removed-tags list, since the only tag
  // a user can ever take back off here is one they themselves added.
  function addUserCardTag(oracleId: string, tag: string): void {
    if (!storedDeck) return
    const current = storedDeck.userCardTags?.[oracleId] ?? []
    if (current.includes(tag)) return
    persist({ userCardTags: { ...storedDeck.userCardTags, [oracleId]: [...current, tag] } })
  }

  function removeUserCardTag(oracleId: string, tag: string): void {
    if (!storedDeck) return
    const current = storedDeck.userCardTags?.[oracleId] ?? []
    persist({ userCardTags: { ...storedDeck.userCardTags, [oracleId]: current.filter((t) => t !== tag) } })
  }

  // Spread into a CardDetail deckMode object so its Tags panel can show/edit this deck's own
  // additions for whichever card is being inspected.
  function userTagDeckModeProps(oracleId: string): {
    userTags: string[]
    onAddUserTag: (tag: string) => void
    onRemoveUserTag: (tag: string) => void
  } {
    return {
      userTags: storedDeck?.userCardTags?.[oracleId] ?? [],
      onAddUserTag: (tag: string) => addUserCardTag(oracleId, tag),
      onRemoveUserTag: (tag: string) => removeUserCardTag(oracleId, tag)
    }
  }

  // Per-deck art override (see StoredDeck.proxyArtByKey) — a cosmetic "skin" over a card's real
  // art, scoped to this deck only, keyed by oracle id (same convention as userCardTags above:
  // survives a later printing change for free, and Goldfish can resolve it from a shuffled
  // card's printing id without needing occurrence/positional tracking). `face` lets a
  // transform/MDFC card carry independent art on each side, flipped between the same way the
  // real printing's own two faces are.
  function setProxyArt(oracleId: string, face: 'front' | 'back', dataUrl: string | null): void {
    if (!storedDeck) return
    const next = { ...storedDeck.proxyArtByKey }
    const updatedEntry = { ...next[oracleId], [face]: dataUrl ?? undefined }
    // Drop the whole entry once neither side has anything left, rather than leaving an
    // empty {} sitting in the record forever.
    if (!updatedEntry.front && !updatedEntry.back) delete next[oracleId]
    else next[oracleId] = updatedEntry as { front: string; back?: string }
    persist({ proxyArtByKey: next })
  }

  // Spread into a CardDetail deckMode object, same pattern as userTagDeckModeProps above.
  function proxyArtDeckModeProps(oracleId: string): {
    proxyArt: { front: string; back?: string } | undefined
    onSetProxyArt: (face: 'front' | 'back', dataUrl: string | null) => void
  } {
    return {
      proxyArt: storedDeck?.proxyArtByKey?.[oracleId],
      onSetProxyArt: (face: 'front' | 'back', dataUrl: string | null) => setProxyArt(oracleId, face, dataUrl)
    }
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
      // Clicking an in-deck search result to take it back out is a full removal too (see
      // handleRemoveId's comment) — only "Move to Pool" is meant to keep a card tracked as owned
      // after it leaves the deck. toggleCardInDeck never reaches this branch for a basic land
      // (its own branch always adds), so no isBasicLand guard is needed here.
      await persist({ cardIds: newIds, cardPoolIds: storedDeck.cardPoolIds.filter((id) => id !== card.id) })
    }
  }

  // Resolves an exact card name (from the fast autocomplete dropdown) to a full card object
  // and adds/removes it — without waiting on addCardsResults' slower debounced full search.
  // Prefers a card already sitting in addCardsResults if that debounce happened to catch up,
  // to skip an extra Scryfall round-trip.
  async function addCardByName(name: string): Promise<void> {
    const cached = addCardsResults.cards.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (cached) {
      handleToggleCard(cached)
      return
    }
    const exclusion = BASE_EXCLUSION_TERMS.join(' ')
    const result = await window.api.searchCards(`!"${name}" ${exclusion}`, {
      order: 'released',
      dir: 'desc',
      page: 1
    })
    if (isError(result)) return
    const match = (result as ScryfallSearchResult).data?.[0]
    if (match) handleToggleCard(match)
  }

  // "2 Sol Ring" / "2x Sol Ring" / a bare "Sol Ring" (implicit count 1) — matches the format
  // Export Deck List (Simplified) produces, so a round-trip export→import just works.
  function parseImportLines(text: string): { count: number; name: string }[] {
    const entries: { count: number; name: string }[] = []
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const match = line.match(/^(\d+)\s*x?\s+(.+)$/i)
      entries.push(match ? { count: Math.max(1, parseInt(match[1], 10)), name: match[2].trim() } : { count: 1, name: line })
    }
    return entries
  }

  interface ParsedDetailedLine {
    count: number
    name: string
    set: string
    collectorNumber: string
    foil: boolean
  }

  // "1 Doctor Doom, King of Latveria (MSC) 880 *F*" — the format Export Deck List (Detailed)
  // produces. Every line Export Deck List (PDF) prints is this exact same text, so this one
  // parser also underlies Import Deck List (PDF) (see handleImportDeckPdf) — extract the PDF's
  // text and run it through here unchanged. Foil marker and the "x" after count are optional.
  const DETAILED_LINE_RE = /^(\d+)\s*x?\s+(.+?)\s+\(([A-Za-z0-9]+)\)\s+(\S+?)(\s*\*F\*)?$/i

  function parseDetailedLines(text: string): ParsedDetailedLine[] {
    const entries: ParsedDetailedLine[] = []
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const match = line.match(DETAILED_LINE_RE)
      if (!match) continue
      entries.push({
        count: Math.max(1, parseInt(match[1], 10)),
        name: match[2].trim(),
        set: match[3].toLowerCase(),
        collectorNumber: match[4],
        foil: Boolean(match[5])
      })
    }
    return entries
  }

  interface ResolvedImportSlot {
    card: ScryfallCard
    foil: boolean
  }

  // The imported list is treated as the deck's new target state, not an addition to it — shared
  // by every import source (simplified paste, detailed paste, PDF):
  // - a non-basic already in the deck stays exactly as it is (its printing untouched);
  // - a non-basic in the deck but NOT in the imported list is pulled out and moved to the
  //   Card Pool (not deleted — you still own it, it just isn't in this build anymore);
  // - a non-basic in the imported list but not currently in the deck is added, using whichever
  //   printing the caller already resolved for it (most-recent-by-name for simplified, the
  //   exact printing named in the list for detailed/PDF);
  // - basics are re-synced by name+count from scratch (any basic name the import doesn't
  //   mention is zeroed out), reusing whichever printing id the deck already had for that name
  //   so an alt-art basic isn't silently swapped back to a default one; a name with no existing
  //   copy uses the caller-resolved printing when explicitPrinting is set, else the same themed
  //   "+"-stepper lookup simplified import always used.
  // - when applyFoil is set (detailed/PDF only — the simplified format carries no foil info),
  //   every slot's foil flag is written to foilIds, including for cards that were already in
  //   the deck — editing a detailed export's "*F*" markers and reimporting is how foil status
  //   gets toggled from outside the app.
  // Cards matching this deck's own commander/partner are skipped as main-deck slots — a common
  // case when re-importing this deck's own export, which lists the commander as its own line —
  // but still update the commander's own foil status when applyFoil is set.
  async function applyImportedSlots(
    slots: ResolvedImportSlot[],
    notFound: string[],
    options: { explicitPrinting: boolean; applyFoil: boolean }
  ): Promise<NonNullable<typeof importResult>> {
    if (!storedDeck) throw new Error('applyImportedSlots called with no deck loaded')
    const deck = storedDeck
    const commanderNamesLower = new Set(
      [deck.commanderName, deck.partnerCommanderName].filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase())
    )

    const importedBasicSlots = new Map<string, boolean[]>()
    const importedBasicExplicitCard = new Map<string, ScryfallCard>()
    const importedOracleIds = new Set<string>()
    const importedNonBasicByOracleId = new Map<string, ScryfallCard>()
    const importedNonBasicFoilByOracleId = new Map<string, boolean>()

    const outsideIdentity: string[] = []
    const banned: string[] = []
    const skippedCommander: string[] = []
    const foilKeysToSet = new Map<string, boolean>()

    for (const { card, foil } of slots) {
      if (commanderNamesLower.has(card.name.toLowerCase())) {
        if (!skippedCommander.includes(card.name)) skippedCommander.push(card.name)
        if (options.applyFoil) {
          if (card.name.toLowerCase() === deck.commanderName.toLowerCase()) {
            foilKeysToSet.set(deck.commanderId, foil)
          } else if (deck.partnerCommanderId) {
            foilKeysToSet.set(deck.partnerCommanderId, foil)
          }
        }
        continue
      }

      if (isBasicLand(card)) {
        importedBasicSlots.set(card.name, [...(importedBasicSlots.get(card.name) ?? []), foil])
        if (!importedBasicExplicitCard.has(card.name)) importedBasicExplicitCard.set(card.name, card)
      } else {
        importedOracleIds.add(card.oracle_id)
        if (!importedNonBasicByOracleId.has(card.oracle_id)) {
          importedNonBasicByOracleId.set(card.oracle_id, card)
          importedNonBasicFoilByOracleId.set(card.oracle_id, foil)
        }
      }

      const reason = getIllegalReason(card, deckColorIdentity)
      if (reason === 'banned' && !banned.includes(card.name)) banned.push(card.name)
      else if (reason === 'color-identity' && !outsideIdentity.includes(card.name)) outsideIdentity.push(card.name)
    }

    const currentNonBasics = deckCards.filter((c) => !isBasicLand(c))
    const keptNonBasics = currentNonBasics.filter((c) => importedOracleIds.has(c.oracle_id))
    const removedNonBasics = currentNonBasics.filter((c) => !importedOracleIds.has(c.oracle_id))
    const keptOracleIds = new Set(keptNonBasics.map((c) => c.oracle_id))
    const addedNonBasics = [...importedNonBasicByOracleId.values()].filter((c) => !keptOracleIds.has(c.oracle_id))

    const currentBasicIdsByName = new Map<string, string[]>()
    for (const c of deckCards.filter(isBasicLand)) {
      currentBasicIdsByName.set(c.name, [...(currentBasicIdsByName.get(c.name) ?? []), c.id])
    }
    const finalBasicIds: string[] = []
    const newlyResolvedBasics: ScryfallCard[] = []

    for (const [name, foilFlags] of importedBasicSlots) {
      const existingIds = currentBasicIdsByName.get(name) ?? []
      let fallbackId = existingIds[0]
      if (!fallbackId) {
        // No copy of this basic already in the deck to reuse the printing from. Detailed/PDF
        // imports already named an exact printing — honor it. Simplified import never carries
        // one, so fall back to the same themed lookup the "+" stepper under Basic Lands uses
        // (commander's own set, else its sibling main set, else nearest release date).
        if (options.explicitPrinting) {
          const explicit = importedBasicExplicitCard.get(name)
          if (explicit) {
            fallbackId = explicit.id
            newlyResolvedBasics.push(explicit)
          }
        }
        if (!fallbackId) {
          const themed = await findDefaultBasicPrinting(name)
          const resolved = themed ?? importedBasicExplicitCard.get(name) ?? null
          if (resolved) {
            fallbackId = resolved.id
            newlyResolvedBasics.push(resolved)
          }
        }
      }
      const idOccurrence = new Map<string, number>()
      for (let i = 0; i < foilFlags.length; i++) {
        const id = existingIds[i] ?? fallbackId
        if (!id) continue
        finalBasicIds.push(id)
        if (options.applyFoil) {
          const occ = idOccurrence.get(id) ?? 0
          idOccurrence.set(id, occ + 1)
          foilKeysToSet.set(foilKeyFor(id, occ), foilFlags[i])
        }
      }
    }

    const nextCardIds = [...keptNonBasics.map((c) => c.id), ...addedNonBasics.map((c) => c.id), ...finalBasicIds]

    if (options.applyFoil) {
      // A non-basic can't have more than one copy (singleton), so occurrence 0 is always right.
      for (const c of [...keptNonBasics, ...addedNonBasics]) {
        const foil = importedNonBasicFoilByOracleId.get(c.oracle_id)
        if (foil !== undefined) foilKeysToSet.set(foilKeyFor(c.id, 0), foil)
      }
    }

    // Removed non-basics move to the Card Pool rather than vanishing; newly added ones fold
    // in too (and drop off Want) — both match how a normal single-card add already behaves.
    const cardPoolIds = new Set(deck.cardPoolIds)
    for (const c of removedNonBasics) cardPoolIds.add(c.id)
    for (const c of addedNonBasics) cardPoolIds.add(c.id)
    const addedIds = new Set(addedNonBasics.map((c) => c.id))
    const wantIds = deck.wantIds.filter((id) => !addedIds.has(id))

    // deckCards resolves every id in cardIds through this map and drops anything missing —
    // the newly-picked basic land printings need to be cached here too, or they're written
    // into cardIds correctly but silently fail to render until the deck is reopened.
    setCardsById((prev) => {
      const next = { ...prev }
      for (const { card } of slots) next[card.id] = card
      for (const c of newlyResolvedBasics) next[c.id] = c
      return next
    })

    const patch: Parameters<typeof persist>[0] = { cardIds: nextCardIds, cardPoolIds: [...cardPoolIds], wantIds }
    if (options.applyFoil) {
      const nextFoilIds = new Set(deck.foilIds)
      for (const [key, foil] of foilKeysToSet) {
        if (foil) nextFoilIds.add(key)
        else nextFoilIds.delete(key)
      }
      patch.foilIds = [...nextFoilIds]
    }
    await persist(patch)

    const outcome = {
      added: addedNonBasics.length,
      removed: removedNonBasics.map((c) => c.name),
      outsideIdentity,
      banned,
      skippedCommander,
      notFound
    }
    setImportResult(outcome)
    return outcome
  }

  // Shared by Plain Text and MTGO (and Arena, after stripArenaHeaders below) — all three
  // exchange bare "count name" lines; applyImportedSlots already recognizes the commander by
  // name regardless of where its line sits, so no format needs to mark it specially here.
  async function resolveNameOnlyLines(text: string): Promise<{ slots: ResolvedImportSlot[]; notFound: string[] } | null> {
    const entries = parseImportLines(text)
    if (entries.length === 0) return { slots: [], notFound: [] }

    const uniqueNames = [...new Set(entries.map((e) => e.name))]
    const result = await window.api.getCardsByNames(uniqueNames)
    if (isError(result)) {
      showInfo('Import Failed', `Could not resolve cards: ${result.details}`)
      return null
    }
    const { data, not_found } = result as { data: ScryfallCard[]; not_found?: string[] }
    const cardByLowerName = new Map(data.map((c) => [c.name.toLowerCase(), c]))

    const slots: ResolvedImportSlot[] = []
    for (const entry of entries) {
      const card = cardByLowerName.get(entry.name.toLowerCase())
      if (!card) continue
      for (let i = 0; i < entry.count; i++) slots.push({ card, foil: false })
    }
    return { slots, notFound: not_found ?? [] }
  }

  async function handleImportNameOnly(): Promise<void> {
    if (!storedDeck) return
    setImporting(true)
    try {
      const resolved = await resolveNameOnlyLines(importText)
      if (!resolved) return
      await applyImportedSlots(resolved.slots, resolved.notFound, { explicitPrinting: false, applyFoil: false })
    } finally {
      setImporting(false)
    }
  }

  // Arena's "About / Name <deck>", "Commander", and "Deck" section headers carry no card data
  // of their own — strip them down to the bare "count name" lines resolveNameOnlyLines expects.
  function stripArenaHeaders(text: string): string {
    const HEADERS = new Set(['about', 'commander', 'deck', 'sideboard', 'companion'])
    const lines: string[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || HEADERS.has(line.toLowerCase()) || /^name\s+/i.test(line)) continue
      lines.push(line)
    }
    return lines.join('\n')
  }

  async function handleImportArena(): Promise<void> {
    if (!storedDeck) return
    setImporting(true)
    try {
      const resolved = await resolveNameOnlyLines(stripArenaHeaders(importText))
      if (!resolved) return
      await applyImportedSlots(resolved.slots, resolved.notFound, { explicitPrinting: false, applyFoil: false })
    } finally {
      setImporting(false)
    }
  }

  // Resolves each parsed line to its exact printing via (set, collector number) rather than by
  // name — see getCardsBySetAndNumber, also used by the Precons library for the same "this
  // specific printing, not just this card name" reason. Shared by both the paste-in detailed
  // text flow and Import Deck List (PDF), which produces the identical ParsedDetailedLine shape
  // from a PDF's extracted text.
  async function resolveDetailedLines(
    parsedLines: ParsedDetailedLine[]
  ): Promise<{ slots: ResolvedImportSlot[]; notFound: string[] } | null> {
    const pairs = parsedLines.map((l) => ({ set: l.set, collectorNumber: l.collectorNumber }))
    const result = await window.api.getCardsBySetAndNumber(pairs)
    if (isError(result)) {
      showInfo('Import Failed', `Could not resolve cards: ${result.details}`)
      return null
    }
    const { data, not_found } = result as { data: ScryfallCard[]; not_found?: string[] }
    const notFoundKeys = new Set(not_found ?? [])
    const slots: ResolvedImportSlot[] = []
    const notFoundLabels: string[] = []
    let dataIndex = 0
    for (const line of parsedLines) {
      const key = `${line.set}/${line.collectorNumber}`
      if (notFoundKeys.has(key)) {
        notFoundLabels.push(`${line.name} (${line.set.toUpperCase()}) ${line.collectorNumber}`)
        continue
      }
      const card = data[dataIndex++]
      if (!card) continue
      for (let i = 0; i < line.count; i++) slots.push({ card, foil: line.foil })
    }
    return { slots, notFound: notFoundLabels }
  }

  async function handleImportMoxfield(): Promise<void> {
    if (!storedDeck) return
    const parsedLines = parseDetailedLines(importText)
    if (parsedLines.length === 0) return

    setImporting(true)
    try {
      const resolved = await resolveDetailedLines(parsedLines)
      if (!resolved) return
      await applyImportedSlots(resolved.slots, resolved.notFound, { explicitPrinting: true, applyFoil: true })
    } finally {
      setImporting(false)
    }
  }

  function importResultSummary(r: NonNullable<typeof importResult>): string {
    const lines = [`Added ${r.added} card(s).`]
    if (r.removed.length > 0) lines.push(`Moved to Card Pool: ${r.removed.join(', ')}`)
    if (r.outsideIdentity.length > 0) lines.push(`Outside color identity: ${r.outsideIdentity.join(', ')}`)
    if (r.banned.length > 0) lines.push(`Banned in Commander: ${r.banned.join(', ')}`)
    if (r.skippedCommander.length > 0) lines.push(`Commander (skipped): ${r.skippedCommander.join(', ')}`)
    if (r.notFound.length > 0) lines.push(`Could not find: ${r.notFound.join(', ')}`)
    return lines.join('\n')
  }

  // The "really unique feature" — a decklist PDF only this app's own Export Deck List (PDF)
  // could have produced round-trips straight back into the deck, since every line it prints is
  // in the exact format parseDetailedLines expects (see generateDecklistPdf in main/deckExport.ts).
  async function handleImportDeckPdf(): Promise<void> {
    if (!storedDeck) return
    setImportingPdf(true)
    try {
      let text: string | null
      try {
        text = await window.api.pickAndExtractImportPdf()
      } catch (err) {
        showInfo('Import Failed', `Could not read that PDF: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (text === null) return // user canceled the file picker

      const parsedLines = parseDetailedLines(text)
      if (parsedLines.length === 0) {
        showInfo(
          'Import Failed',
          'Could not find a recognizable decklist in that PDF — it needs to be one produced by BiblioPLEX\'s own "Export Deck List (PDF)".'
        )
        return
      }

      const resolved = await resolveDetailedLines(parsedLines)
      if (!resolved) return
      const outcome = await applyImportedSlots(resolved.slots, resolved.notFound, { explicitPrinting: true, applyFoil: true })
      showInfo('Import Complete', importResultSummary(outcome))
    } finally {
      setImportingPdf(false)
    }
  }

  function closeImportModal(): void {
    setImportModalOpen(false)
    setImportText('')
    setImportResult(null)
  }

  const KNOWN_LOGIC_RULE_TYPES = new Set(['holdInstantUntilAttackTrigger'])

  function closeLogicModal(): void {
    setLogicModalOpen(false)
    setLogicText('')
    setLogicError(null)
    setLogicWarnings([])
    setLogicImportedCount(null)
  }

  // Validates and saves a Logic file (see docs/logic-file-guide.md) — the app only ever reads
  // these, never generates them; validation is deliberately strict on shape (unknown rule
  // "type" is a hard error, not silently ignored, so an authoring mistake in an external Claude
  // conversation surfaces immediately) but only warns (doesn't block) on a permanentNames entry
  // that isn't actually in this deck, since that's just as likely a stale note as a typo.
  async function handleImportLogic(): Promise<void> {
    if (!storedDeck) return
    setLogicError(null)
    setLogicWarnings([])

    let parsed: unknown
    try {
      parsed = JSON.parse(logicText)
    } catch {
      setLogicError('Not valid JSON.')
      return
    }
    const obj = parsed as Record<string, unknown>
    if (obj.biblioplexLogicFile !== true || typeof obj.version !== 'number' || !Array.isArray(obj.rules)) {
      setLogicError(
        'Not a recognized Logic file — expected "biblioplexLogicFile": true, a numeric "version", and a "rules" array. See docs/logic-file-guide.md.'
      )
      return
    }

    const rules: LogicRule[] = []
    for (const [i, entry] of (obj.rules as unknown[]).entries()) {
      const rule = entry as Record<string, unknown>
      if (typeof rule.type !== 'string' || !KNOWN_LOGIC_RULE_TYPES.has(rule.type)) {
        setLogicError(`Rule ${i + 1} has an unrecognized "type": ${String(rule.type)}. Supported: ${[...KNOWN_LOGIC_RULE_TYPES].join(', ')}.`)
        return
      }
      if (
        !Array.isArray(rule.permanentNames) ||
        rule.permanentNames.length === 0 ||
        !rule.permanentNames.every((n) => typeof n === 'string')
      ) {
        setLogicError(`Rule ${i + 1} needs a non-empty "permanentNames" array of card names.`)
        return
      }
      rules.push({
        type: rule.type as LogicRule['type'],
        permanentNames: rule.permanentNames as string[],
        ...(typeof rule.note === 'string' ? { note: rule.note } : {})
      })
    }

    const deckCardNames = new Set(
      [storedDeck.commanderName, storedDeck.partnerCommanderName, ...deckCards.map((c) => c.name)]
        .filter((n): n is string => Boolean(n))
        .map((n) => n.toLowerCase())
    )
    const unknownNames = [...new Set(rules.flatMap((r) => r.permanentNames))].filter(
      (n) => !deckCardNames.has(n.toLowerCase())
    )

    setLogicImporting(true)
    try {
      await persist({ logicFile: { version: obj.version as number, rules } })
      setLogicWarnings(unknownNames.length > 0 ? [`Not found in this deck: ${unknownNames.join(', ')}`] : [])
      setLogicImportedCount(rules.length)
    } finally {
      setLogicImporting(false)
    }
  }

  function handleRemoveLogic(): void {
    void persist({ logicFile: null })
  }

  function foilOf(card: ScryfallCard, occurrence: number): boolean {
    return foilIdSet.has(foilKeyFor(card.id, occurrence))
  }

  function commanderSlots(): { card: ScryfallCard; foil: boolean }[] {
    if (!storedDeck || !commander) return []
    const slots: { card: ScryfallCard; foil: boolean }[] = [{ card: commander, foil: foilIdSet.has(storedDeck.commanderId) }]
    if (partnerCommander && storedDeck.partnerCommanderId) {
      slots.push({ card: partnerCommander, foil: foilIdSet.has(storedDeck.partnerCommanderId) })
    }
    return slots
  }

  function mainDeckSlots(): { card: ScryfallCard; foil: boolean }[] {
    const occurrenceCount = new Map<string, number>()
    return deckCards.map((card) => {
      const occurrence = occurrenceCount.get(card.id) ?? 0
      occurrenceCount.set(card.id, occurrence + 1)
      return { card, foil: foilOf(card, occurrence) }
    })
  }

  // Collapses same-printing+foil copies into "<count> <name>" lines, alphabetical — the shared
  // building block behind Plain Text, Arena, and MTGO, which all exchange bare card names
  // (unlike Moxfield's format, which also carries set/collector/foil — see formatDetailedLines).
  function formatNameOnlyLines(entries: { card: ScryfallCard }[]): string[] {
    const counts = new Map<string, number>()
    for (const { card } of entries) counts.set(card.name, (counts.get(card.name) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => `${count} ${name}`)
  }

  // "<count> <name> (<SET>) <number> [*F*]" — Moxfield's own paste format, and the one
  // Import Deck List (PDF)/(Moxfield) both parse back (see DETAILED_LINE_RE).
  function formatDetailedLines(entries: { card: ScryfallCard; foil: boolean }[]): string[] {
    const counts = new Map<string, { card: ScryfallCard; foil: boolean; count: number }>()
    for (const { card, foil } of entries) {
      const key = `${card.name}|||${card.set}|||${card.collector_number}|||${foil}`
      const existing = counts.get(key)
      if (existing) existing.count++
      else counts.set(key, { card, foil, count: 1 })
    }
    return [...counts.values()]
      .sort((a, b) => a.card.name.localeCompare(b.card.name))
      .map(({ card, foil, count }) => `${count} ${card.name} (${card.set.toUpperCase()}) ${card.collector_number}${foil ? ' *F*' : ''}`)
  }

  async function copyToClipboard(text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    setShowCopyCheck(true)
    window.setTimeout(() => setShowCopyCheck(false), 1800)
  }

  function showInfo(title: string, message: string): void {
    setInfoModal({ title, message })
  }

  // The no-assumptions format: every card (commander included) merged into one flat alphabetical
  // list, name+count only, no sections and no special commander placement — what distinguishes
  // it from Moxfield (commander-first), Arena (sectioned), and MTGO (commander-last) below.
  function handleCopyPlainText(): void {
    if (!storedDeck) return
    void copyToClipboard(formatNameOnlyLines([...commanderSlots(), ...mainDeckSlots()]).join('\n'))
  }

  // Commander (and partner) lead, immediately followed by the alphabetical rest — no blank line,
  // no header — matching Moxfield's own paste format exactly (see the "1 Doctor Doom, King of
  // Latveria (MSC) 880 *F*" example this was built from).
  function handleCopyMoxfield(): void {
    if (!storedDeck || !commander) return
    const lines = [...formatDetailedLines(commanderSlots()), ...formatDetailedLines(mainDeckSlots())]
    void copyToClipboard(lines.join('\n'))
  }

  // Arena's own sectioned format: "About"/"Name <deck>", then "Commander", then "Deck" — no
  // set/collector info, name-only lines exactly like Plain Text within each section.
  function handleCopyArena(): void {
    if (!storedDeck || !commander) return
    const text = [
      'About',
      `Name ${storedDeck.name}`,
      '',
      'Commander',
      ...formatNameOnlyLines(commanderSlots()),
      '',
      'Deck',
      ...formatNameOnlyLines(mainDeckSlots())
    ].join('\n')
    void copyToClipboard(text)
  }

  // MTGO's own convention: the main deck first (alphabetical, name-only), then a blank line,
  // then the commander last — the mirror image of Moxfield's commander-first ordering.
  function handleCopyMtgo(): void {
    if (!storedDeck || !commander) return
    const text = [...formatNameOnlyLines(mainDeckSlots()), '', ...formatNameOnlyLines(commanderSlots())].join('\n')
    void copyToClipboard(text)
  }

  async function handleExportDeckPdf(): Promise<void> {
    if (!storedDeck || !commander) return
    // 'normal' (488x680), not 'small' — the thumbnails are big enough on the page that a low-res
    // source image turns to mush as soon as a PDF viewer is zoomed in on it. The main process
    // re-encodes down toward the actual draw size before embedding (see resizeForEmbed in
    // deckExport.ts), so fetching a higher-res source here doesn't bloat the resulting file.
    const groups = buildDecklistPdfGroups(commanderSlots(), deckCards, foilOf, (card) => scryfallImageUrl(card.id, 'normal'))
    const commanderArtUrl = commander.image_uris?.art_crop ?? null
    const account = (await window.api.getCurrentAccount()) as { username: string } | null

    setExportingPdf(true)
    try {
      const savedPath = await window.api.exportDeckPdf({
        deckName: storedDeck.name,
        commanderArtUrl,
        colorIdentity: deckColorIdentity,
        identityName: colorIdentityName(deckColorIdentity),
        bracket: storedDeck.bracket,
        accountName: account?.username ?? null,
        groups
      })
      if (savedPath) showInfo('Export Complete', `Saved to ${savedPath}`)
    } finally {
      setExportingPdf(false)
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

  function handleDeckCardContextMenu(card: ScryfallCard, e: React.MouseEvent): void {
    e.preventDefault()
    setDeckCardContextMenu({ card, x: e.clientX, y: e.clientY })
  }

  // A full removal — the card only stays tracked as owned via Card Pool if the user explicitly
  // chose "Move to Pool" instead (see moveDeckCardToPool). Used by the deck grid's own "Remove
  // from Deck" (context menu + card-inspect button) and the Add Cards search's toggle-off;
  // Hot Swap's plain drag-to-Pool-column gesture is its own "move to pool" action and calls
  // moveDeckCardToPool directly instead of this.
  async function handleRemoveId(id: string): Promise<void> {
    if (!storedDeck) return
    const idx = storedDeck.cardIds.indexOf(id)
    if (idx === -1) return
    const newIds = [...storedDeck.cardIds.slice(0, idx), ...storedDeck.cardIds.slice(idx + 1)]
    // Only drop the Considering flag (and Pool membership) once every copy of this id is gone —
    // a duplicate basic land shares one id, and removing just one copy shouldn't un-flag/unpool
    // the rest.
    const stillInDeck = newIds.includes(id)
    await persist({
      cardIds: newIds,
      cardPoolIds: stillInDeck ? storedDeck.cardPoolIds : storedDeck.cardPoolIds.filter((cid) => cid !== id),
      consideringIds: stillInDeck ? storedDeck.consideringIds : storedDeck.consideringIds.filter((cid) => cid !== id)
    })
  }

  // "Move to Pool" from the deck grid: leaves the deck's 99 but stays tracked as owned via the
  // Card Pool list, rather than vanishing entirely the way a plain removal does. Basic lands
  // skip pooling same as everywhere else (toggleCardPool/moveToPool) — they're not meaningfully
  // "owned" in a way the pool list is for.
  async function moveDeckCardToPool(card: ScryfallCard): Promise<void> {
    if (!storedDeck || isBasicLand(card)) return
    const idx = storedDeck.cardIds.indexOf(card.id)
    if (idx === -1) return
    const newIds = [...storedDeck.cardIds.slice(0, idx), ...storedDeck.cardIds.slice(idx + 1)]
    const stillInDeck = newIds.includes(card.id)
    await persist({
      cardIds: newIds,
      cardPoolIds: addIdToList(storedDeck.cardPoolIds, card.id),
      consideringIds: stillInDeck ? storedDeck.consideringIds : storedDeck.consideringIds.filter((cid) => cid !== card.id)
    })
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
    if (!storedDeckRef.current) return
    await persist({ cardIds: [...storedDeckRef.current.cardIds, id] })
  }

  // First copy of a given basic land name in this deck: prefer a printing from the
  // commander's own set (matches the deck's "flavor"), falling back to whichever printing
  // released closest to the commander's release date if that set never printed this basic.
  async function findBasicInSet(name: string, setCode: string, exclusion: string): Promise<ScryfallCard | null> {
    const result = await window.api.searchCards(`!"${name}" set:${setCode} ${exclusion}`, {
      order: 'released',
      dir: 'desc'
    })
    if (isError(result)) return null
    return (result as ScryfallSearchResult).data?.[0] ?? null
  }

  async function findDefaultBasicPrinting(name: string): Promise<ScryfallCard | null> {
    const exclusion = BASE_EXCLUSION_TERMS.join(' ')
    if (commander?.set) {
      const setMatch = await findBasicInSet(name, commander.set, exclusion)
      if (setMatch) return setMatch
    }

    // Commander precon sets (e.g. "Secrets of Strixhaven Commander") routinely print zero
    // basic lands of their own — they're meant to draw on the accompanying main set (e.g.
    // "Secrets of Strixhaven", released the same day). Try that sibling set by name before
    // falling back to "closest release date across all of Magic", which can land on a
    // same-day but completely unrelated product (a Universes Beyond crossover, say) purely
    // by date coincidence — which is what happened before this fix.
    if (commander?.set_name) {
      const siblingName = commander.set_name.replace(/\s+Commander$/i, '').trim()
      if (siblingName.toLowerCase() !== commander.set_name.toLowerCase()) {
        const setsResult = await window.api.getSets()
        if (!isError(setsResult)) {
          const sets = (setsResult as { data: { code: string; name: string }[] }).data ?? []
          const sibling = sets.find((s) => s.name.toLowerCase() === siblingName.toLowerCase())
          if (sibling) {
            const siblingMatch = await findBasicInSet(name, sibling.code, exclusion)
            if (siblingMatch) return siblingMatch
          }
        }
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
    if (!storedDeckRef.current) return
    const existing = basicLandCounts.get(name)
    if (existing) {
      await addCardIdToDeck(existing.sampleId)
      return
    }
    const found = preloadedBasicPrintings[name] ?? (await findDefaultBasicPrinting(name))
    if (!found) return
    setCardsById((prev) => ({ ...prev, [found.id]: found }))
    await addCardIdToDeck(found.id)
  }

  async function removeBasicLand(name: string): Promise<void> {
    if (!storedDeckRef.current) return
    // The stepper's own count is regular+snow combined (see combinedBasicCount) — "-" removes
    // whichever flavor is actually there, snow included, rather than only ever matching the
    // plain name and silently refusing to go below however many snow copies happen to exist.
    const snowName = snowNameFor(name)
    const ids = [...storedDeckRef.current.cardIds]
    for (let i = ids.length - 1; i >= 0; i--) {
      const card = cardsById[ids[i]]
      if (card && (card.name === name || card.name === snowName)) {
        ids.splice(i, 1)
        break
      }
    }
    await persist({ cardIds: ids })
  }

  // Flips one specific copy (by its index in cardIds, not by id — several copies can share the
  // same printing id) between a basic land and its Snow-Covered counterpart. Reuses whichever
  // printing is already in the deck for the target flavor (so every Snow-Covered Island this
  // deck has shares the same art) before falling back to a fresh search, the same optimization
  // addBasicLand already relies on for the very first copy of a name. Reads/writes cardIds via
  // storedDeckRef (not the storedDeck state variable) so clicking through several conversions
  // in a row — each one calling this again before React has re-rendered from the previous
  // call's persist() — builds each new array on top of the PREVIOUS click's result instead of
  // a shared stale snapshot, which was silently rolling earlier clicks back.
  async function toggleBasicSnowAt(index: number, targetName: string): Promise<void> {
    if (!storedDeckRef.current) return
    const existing =
      storedDeckRef.current.cardIds.map((id) => cardsById[id]).find((c) => c?.name === targetName) ??
      preloadedBasicPrintings[targetName]
    const target = existing ?? (await findDefaultBasicPrinting(targetName))
    if (!target) return
    if (!cardsById[target.id]) setCardsById((prev) => ({ ...prev, [target.id]: target }))
    if (!storedDeckRef.current) return
    const ids = [...storedDeckRef.current.cardIds]
    ids[index] = target.id
    await persist({ cardIds: ids })
  }

  // Replaces every copy sharing this exact name (regardless of which printing each one
  // currently is) with one chosen printing — "changing printings should change all printings,"
  // not just the first copy the way a normal per-card printing swap would.
  async function changeAllBasicPrintings(name: string, newPrinting: ScryfallCard): Promise<void> {
    if (!storedDeckRef.current) return
    if (!cardsById[newPrinting.id]) setCardsById((prev) => ({ ...prev, [newPrinting.id]: newPrinting }))
    const ids = storedDeckRef.current.cardIds.map((id) => (cardsById[id]?.name === name ? newPrinting.id : id))
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

  function openTagSearch(tag?: string): void {
    setActiveSearchTags(tag ? [tag] : [])
    setView('tagSearch')
  }

  function openTypeSearch(term?: string): void {
    setViewingCard(null)
    setActiveSearchTerms(term ? [term] : [])
    setView('typeSearch')
  }

  // Shared between the inline top-10 row and the "Show More" popup's full list — same chip,
  // same right-click-free dropdown menu (search / filter this deck), just rendered in two
  // different places. `fromModal` also closes the popup itself whenever one of the menu actions
  // is chosen, so picking e.g. "Search more cards" from inside it doesn't leave the modal
  // sitting open behind the view it just navigated away to.
  function renderTagChip(tag: string, count: number, maxCount: number, fromModal: boolean) {
    // Most-used tags read as vivid/accent-colored; less-represented tags fade toward the
    // neutral chip look, so the eye lands on the deck's dominant themes first.
    const pct = Math.round(15 + (count / maxCount) * 85)
    function closeMenus(): void {
      setOpenTagMenu(null)
      if (fromModal) setTagsModalOpen(false)
    }
    return (
      <div key={tag} className="tag-menu-wrapper">
        <button
          className="tag-chip"
          style={{
            background: `color-mix(in srgb, var(--accent) ${pct}%, var(--panel))`,
            borderColor: `color-mix(in srgb, var(--accent) ${pct}%, var(--border))`,
            color: pct >= 60 ? '#fff' : 'var(--muted)'
          }}
          onClick={(e) => {
            if (openTagMenu?.tag === tag) {
              setOpenTagMenu(null)
              return
            }
            const rect = e.currentTarget.getBoundingClientRect()
            setOpenTagMenu({ tag, x: rect.left, y: rect.bottom + 4 })
          }}
          title={`${count} card(s) in this deck`}
        >
          {tag} <span className="tag-chip__weight">{count}</span>
        </button>
        {openTagMenu?.tag === tag &&
          createPortal(
            <>
              <div className="tag-menu-backdrop" onClick={() => setOpenTagMenu(null)} />
              <div className="tag-menu" style={{ top: openTagMenu.y, left: openTagMenu.x }}>
                <button
                  onClick={() => {
                    closeMenus()
                    openTagSearch(tag)
                  }}
                >
                  Search more cards
                </button>
                <button
                  onClick={() => {
                    closeMenus()
                    setDeckTagFilter(tag)
                  }}
                >
                  See cards in this deck
                </button>
              </div>
            </>,
            document.body
          )}
      </div>
    )
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
    playSwapSound()
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
    // Dropping onto the Pool column is the drag equivalent of "Move to Pool" (see that
    // action's own comment) — the card stays tracked as owned, unlike a plain removal.
    if (target === 'deck') handleToggleCard(hotSwapDragCard)
    else moveDeckCardToPool(hotSwapDragCard)
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
    playSwapSound()
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
      // Same "drag to Pool column = Move to Pool" treatment as handleHotSwapDrop above.
      moveDeckCardToPool(dragged)
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

  if (view === 'goldfish') {
    return <PlaytestGoldfishView storedDeck={storedDeck} cardDataById={cardsById} onBack={() => setView('deck')} />
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

  if (view === 'typeSearch') {
    return (
      <TypeSearchView
        initialTerms={activeSearchTerms}
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

  return (
    <div className="app__results" ref={pageTopRef}>
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
          <h3 className="section-heading">
            Import / Export
            <span className={`copy-check ${showCopyCheck ? 'is-visible' : ''}`}>✓</span>
          </h3>
          <div className="deck-builder__import-export-row">
            <button
              className="secondary-button"
              onClick={(e) => setImportMenuAnchor({ x: e.clientX, y: e.clientY })}
              disabled={importingPdf}
            >
              {importingPdf ? 'Importing…' : 'Import'}
            </button>
            <button
              className="secondary-button"
              onClick={(e) => setExportMenuAnchor({ x: e.clientX, y: e.clientY })}
              disabled={exportingPdf}
            >
              {exportingPdf ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>

        <div className="deck-builder__header-block">
          <h3 className="section-heading">Logic</h3>
          {storedDeck.logicFile ? (
            <div className="deck-builder__import-export-row">
              <button className="secondary-button" onClick={() => setLogicModalOpen(true)}>
                Replace
              </button>
              <button className="secondary-button" onClick={handleRemoveLogic}>
                Remove
              </button>
            </div>
          ) : (
            <div className="deck-builder__import-export-row">
              <button className="secondary-button" onClick={() => setLogicModalOpen(true)}>
                Import Logic
              </button>
            </div>
          )}
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
                {Math.round(deckWinRate * 100)}%
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
        {deckCardTagCounts.slice(0, 10).map(({ tag, count }) => renderTagChip(tag, count, deckCardTagCounts[0]?.count ?? 1, false))}
        {deckCardTagCounts.length > 10 && (
          <button className="tag-chip tag-chip--edit" onClick={() => setTagsModalOpen(true)}>
            Show More ({deckCardTagCounts.length - 10})
          </button>
        )}
      </div>

      {tagsModalOpen &&
        createPortal(
          // Portaled to document.body — .deck-builder__mid-section's own art-background layer
          // establishes a stacking/containing-block context that trapped this modal's
          // position:fixed, rendering it inline right after the tag row instead of as a real
          // full-screen overlay (same class of bug the tag-menu dropdown below already portals
          // around).
          <div className="card-detail-overlay" onClick={() => setTagsModalOpen(false)}>
            <div className="playtest-analysis-modal" onClick={(e) => e.stopPropagation()}>
              <button className="card-detail__close" onClick={() => setTagsModalOpen(false)}>
                ×
              </button>
              <h3 className="section-heading" style={{ marginTop: 0 }}>
                All Card Tags ({deckCardTagCounts.length})
              </h3>
              <div className="tag-row">
                {deckCardTagCounts.map(({ tag, count }) => renderTagChip(tag, count, deckCardTagCounts[0]?.count ?? 1, true))}
              </div>
            </div>
          </div>,
          document.body
        )}

      {deckTagFilter && (
        <div className="deck-tag-filter">
          <div className="deck-tag-filter__header">
            <h3 className="section-heading">Cards in this deck tagged "{deckTagFilter}"</h3>
            <button className="deck-tag-filter__close" onClick={() => setDeckTagFilter(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="card-grid card-grid--tag-filter">
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
                proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
              />
            ))}
          </div>
        </div>
      )}

      <div className="deck-builder__basic-lands-heading-row">
        <h3 className="section-heading">Basic Lands</h3>
        <span className="app__hint">Click color symbol to change land settings.</span>
      </div>
      <div className="basic-land-row">
        {visibleBasicLandNames.map((name) => {
          // Regular + Snow-Covered combined — converting a copy to snow (or back) shouldn't
          // make it vanish from this count, just change which flavor it's counted as.
          const count = (basicLandCounts.get(name)?.count ?? 0) + (basicLandCounts.get(snowNameFor(name))?.count ?? 0)
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
                <button
                  type="button"
                  className="record-control__pip-button"
                  title="Click to change land settings"
                  onClick={(e) => setBasicPipMenu({ name, x: e.clientX, y: e.clientY })}
                >
                  <ColorPips colors={color ? [color] : []} size={18} />
                </button>
              </div>
              <button className="record-button record-button--plus" onClick={() => addBasicLand(name)}>
                +
              </button>
            </div>
          )
        })}

        <div className="deck-builder__archetype-picker">
          <label htmlFor="deck-archetype">Archetype</label>
          <select
            id="deck-archetype"
            value={storedDeck?.archetypeKey ?? 'auto'}
            onChange={(e) => persist({ archetypeKey: e.target.value })}
          >
            <option value="auto">Auto (best EDHREC match)</option>
            <option value="none">None (baseline targets)</option>
            {ARCHETYPE_OPTIONS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="deck-builder__basic-lands-heading-row">
        <h3 className="section-heading">Add Cards</h3>
        <span className="app__hint">Cards outside your color identity are grayed out, sorted after the rest.</span>
      </div>
      <div className="deck-builder__add-cards-row">
      <div className="add-cards-search">
        <input
          ref={addCardsInputRef}
          className="app__search"
          type="text"
          placeholder="Search cards to add — press Enter on a single match, or click a result…"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value)
            setAddCardsDropdownOpen(true)
          }}
          onFocus={() => setAddCardsDropdownOpen(true)}
          onBlur={() => {
            // Delay so a click on a dropdown row registers before the row unmounts.
            window.setTimeout(() => setAddCardsDropdownOpen(false), 150)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (addCardsAutocomplete.names.length !== 1) return
            const onlyName = addCardsAutocomplete.names[0]
            addCardByName(onlyName)
            // Leaves the typed text in place but selected, so the next keystroke overwrites it
            // and the user can go straight on to the next card without touching the mouse.
            addCardsInputRef.current?.select()
          }}
        />
        {showAddCardsDropdown && (
          <div className="add-cards-dropdown">
            {visibleAddCardsNames.map((name) => {
              // The names list resolves instantly from the local catalog; the matching full
              // card object (for its thumbnail) comes from the slower full search and may not
              // have arrived yet — show a placeholder swatch until it does rather than
              // waiting on it.
              const card = addCardsResults.cards.find((c) => c.name.toLowerCase() === name.toLowerCase())
              const thumb = card?.image_uris?.small ?? card?.card_faces?.[0]?.image_uris?.small
              const inDeck = card ? deckOracleIds.has(card.oracle_id) : false
              return (
                <button
                  key={name}
                  className={`add-cards-dropdown__item ${inDeck ? 'is-in-deck' : ''}`}
                  // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addCardByName(name)
                    addCardsInputRef.current?.focus()
                    addCardsInputRef.current?.select()
                  }}
                >
                  {thumb ? <img src={thumb} alt="" /> : <span className="add-cards-dropdown__no-art" />}
                  <span className="add-cards-dropdown__name">{name}</span>
                  {inDeck && <span className="add-cards-dropdown__badge">✓ In Deck</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <button className="secondary-button" onClick={() => openTagSearch()}>
        Search by Tag
      </button>
      <button className="secondary-button" onClick={() => openTypeSearch()}>
        Search by Type
      </button>
      </div>
      {trimmedSearch && (
        <CardResults
          query={searchQueryFull}
          sort={SORT_OPTIONS[0]}
          emptyHint="No cards found."
          onSelect={(card) => {
            handleToggleCard(card)
            // Same "ready for the next card" behavior as the dropdown/Enter path below.
            addCardsInputRef.current?.focus()
            addCardsInputRef.current?.select()
          }}
          isInDeck={(card) => deckOracleIds.has(card.oracle_id)}
          getMarker={getMarker}
          colorIdentity={deckColorIdentity}
          rawText={trimmedSearch}
          results={addCardsResults}
        />
      )}
      </div>

      <div className="deck-builder__deck-heading-row">
        <h3 className="section-heading">
          Deck ({totalDeckSize} card{totalDeckSize === 1 ? '' : 's'})
        </h3>
        <div className="deck-builder__deck-heading-actions">
          {deckPrice !== null && (
            <button
              type="button"
              className={`deck-price ${priceHidden ? 'is-hidden' : ''}`}
              onClick={toggleDeckPriceHidden}
              title={priceHidden ? 'Click to reveal the deck price' : 'Click to hide the deck price'}
            >
              ${deckPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </button>
          )}
          <button
            className="secondary-button"
            onClick={(e) => setGroupMenuAnchor({ for: 'deck', x: e.clientX, y: e.clientY })}
            disabled={deckCards.length === 0}
          >
            Group By: {DECK_GROUP_MODE_LABELS[deckGroupMode]} ▾
          </button>
          <button className="secondary-button" onClick={() => setView('goldfish')} disabled={deckCards.length === 0}>
            🎲 Playtest
          </button>
          <button className="secondary-button" onClick={() => setHotSwapOpen(true)} disabled={deckCards.length === 0}>
            🔄 Hot Swap
          </button>
        </div>
      </div>
      {deckCards.length === 0 && <p className="app__hint">No cards added yet.</p>}
      {deckCards.length > 0 && (
        <div className="commander-view__body">
          <nav className="commander-view__toc">
            <button className="commander-view__toc-top" onClick={deckSidebar.scrollToTop}>
              ↑ Back to Top
            </button>
            {categoryGroups.map(({ category, label, dashColor, cards }) => (
              <button
                key={category}
                className="commander-view__toc-item"
                onClick={() => deckSidebar.scrollToSection(category)}
              >
                <span className="commander-view__section-dash" style={{ background: dashColor }} />
                {label} ({cards.length})
              </button>
            ))}
          </nav>

          <div className="commander-view__sections">
            {categoryGroups.map(({ category, label, dashColor, cards }) => {
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
                    <span className="commander-view__section-dash" style={{ background: dashColor }} />
                    {label}
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
                        // Group By Subtype shows a multi-subtype card (Hydroid Krasis: Hydra
                        // Jellyfish) in every one of its subtype sections, not just its primary
                        // one — see groupCardsBySubtype/primarySubtype in deckLogic.ts. A
                        // secondary ("ghost") appearance is view-only: no drag-to-reorder (it
                        // isn't really "this section's" card to reorder), just click-to-inspect.
                        const isGhost = deckGroupMode === 'subtype' && primarySubtype(card) !== category
                        if (isGhost) {
                          return (
                            <div key={slotKey} className="deck-card-slot">
                              <CardTile
                                card={card}
                                onSelect={(c) => {
                                  setViewingKind('card')
                                  setViewingSlotId(c.id)
                                  setViewingSlotOccurrence(occurrence)
                                  setViewingCard(c)
                                }}
                                onContextMenu={handleDeckCardContextMenu}
                                isFoil={foilIdSet.has(foilKeyFor(card.id, occurrence))}
                                illegalReason={getIllegalReason(card, deckColorIdentity)}
                                isConsidering={consideringIdSet.has(card.id)}
                                proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
                                isGhost
                              />
                            </div>
                          )
                        }
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
                              onContextMenu={handleDeckCardContextMenu}
                              isFoil={foilIdSet.has(foilKeyFor(card.id, occurrence))}
                              illegalReason={getIllegalReason(card, deckColorIdentity)}
                              isConsidering={consideringIdSet.has(card.id)}
                              proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
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
                <img src={scryfallImageUrl(token.id)} alt={token.name} loading="lazy" decoding="async" />
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
          <div className="deck-builder__basic-lands-heading-row">
            <h3 className="section-heading">Card Pool</h3>
            <span className="app__hint">Cards outside your color identity are grayed out, sorted after the rest.</span>
          </div>
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
              getMarker={getMarker}
              colorIdentity={deckColorIdentity}
              rawText={cardPoolQuery.trim()}
            />
          )}
          <div className="deck-builder__deck-heading-row">
            <h3 className="section-heading">In Your Pool ({cardPoolCards.length})</h3>
            <div className="deck-builder__deck-heading-actions">
              <button
                className="secondary-button"
                onClick={(e) => setGroupMenuAnchor({ for: 'cardPool', x: e.clientX, y: e.clientY })}
                disabled={cardPoolCards.length === 0}
              >
                Group By: {DECK_GROUP_MODE_LABELS[poolGroupMode]} ▾
              </button>
            </div>
          </div>
          <p className="app__hint">Click a card to inspect it or change printing — right-click for more options.</p>
          {cardPoolCards.length === 0 && <p className="app__hint">No cards marked as owned yet.</p>}
          {cardPoolCards.length > 0 && (
            <div className="commander-view__body">
              <nav className="commander-view__toc">
                <button className="commander-view__toc-top" onClick={poolSidebar.scrollToTop}>
                  ↑ Back to Top
                </button>
                {poolCategoryGroups.map(({ category, label, dashColor, cards }) => (
                  <button
                    key={category}
                    className="commander-view__toc-item"
                    onClick={() => poolSidebar.scrollToSection(category)}
                  >
                    <span className="commander-view__section-dash" style={{ background: dashColor }} />
                    {label} ({cards.length})
                  </button>
                ))}
              </nav>

              <div className="commander-view__sections">
                {poolCategoryGroups.map(({ category, label, dashColor, cards }) => {
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
                        <span className="commander-view__section-dash" style={{ background: dashColor }} />
                        {label}
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
                              proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
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
          <div className="deck-builder__basic-lands-heading-row">
            <h3 className="section-heading">Want</h3>
            <span className="app__hint">Cards outside your color identity are grayed out, sorted after the rest.</span>
          </div>
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
              isInDeck={(card) => deckOracleIds.has(card.oracle_id)}
              getMarker={getMarker}
              colorIdentity={deckColorIdentity}
              rawText={wantQuery.trim()}
            />
          )}
          <div className="deck-builder__deck-heading-row">
            <h3 className="section-heading">Wanted ({wantCards.length})</h3>
            <div className="deck-builder__deck-heading-actions">
              <button
                className="secondary-button"
                onClick={(e) => setGroupMenuAnchor({ for: 'want', x: e.clientX, y: e.clientY })}
                disabled={wantCards.length === 0}
              >
                Group By: {DECK_GROUP_MODE_LABELS[wantGroupMode]} ▾
              </button>
            </div>
          </div>
          <p className="app__hint">Click a card to inspect it or change printing — right-click for more options.</p>
          {wantCards.length === 0 && <p className="app__hint">Nothing on the want list yet.</p>}
          {wantCards.length > 0 && (
            <div className="commander-view__body">
              <nav className="commander-view__toc">
                <button className="commander-view__toc-top" onClick={wantSidebar.scrollToTop}>
                  ↑ Back to Top
                </button>
                {wantCategoryGroups.map(({ category, label, dashColor, cards }) => (
                  <button
                    key={category}
                    className="commander-view__toc-item"
                    onClick={() => wantSidebar.scrollToSection(category)}
                  >
                    <span className="commander-view__section-dash" style={{ background: dashColor }} />
                    {label} ({cards.length})
                  </button>
                ))}
              </nav>

              <div className="commander-view__sections">
                {wantCategoryGroups.map(({ category, label, dashColor, cards }) => {
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
                        <span className="commander-view__section-dash" style={{ background: dashColor }} />
                        {label}
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
                              proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
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
          taggerDataByOracleId={taggerDataByOracleId}
          userCardTags={storedDeck?.userCardTags}
          onAddToDeck={handleToggleCard}
          onAddToPool={toggleCardPool}
          onAddToWant={toggleWant}
          onTypeSearch={openTypeSearch}
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
          commanderNames={[commander?.name, partnerCommander?.name].filter((n): n is string => Boolean(n))}
          cardTagOverrides={cardTagOverrides}
          taggerDataByOracleId={taggerDataByOracleId}
          userCardTags={storedDeck?.userCardTags}
          archetypeKey={storedDeck?.archetypeKey ?? 'auto'}
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

      {groupMenuAnchor && (
        <CardContextMenu
          x={groupMenuAnchor.x}
          y={groupMenuAnchor.y}
          onClose={() => setGroupMenuAnchor(null)}
          actions={(Object.entries(DECK_GROUP_MODE_LABELS) as [DeckGroupMode, string][]).map(([mode, label]) => ({
            label,
            onSelect: () => {
              const setMode =
                groupMenuAnchor.for === 'deck'
                  ? setDeckGroupMode
                  : groupMenuAnchor.for === 'cardPool'
                    ? setPoolGroupMode
                    : setWantGroupMode
              setMode(mode)
              setGroupMenuAnchor(null)
            }
          }))}
        />
      )}

      {importMenuAnchor && (
        <CardContextMenu
          x={importMenuAnchor.x}
          y={importMenuAnchor.y}
          onClose={() => setImportMenuAnchor(null)}
          actions={[
            {
              label: 'Import from Moxfield',
              onSelect: () => {
                setImportMenuAnchor(null)
                setImportMode('moxfield')
                setImportModalOpen(true)
              }
            },
            {
              label: 'Import from Arena',
              onSelect: () => {
                setImportMenuAnchor(null)
                setImportMode('arena')
                setImportModalOpen(true)
              }
            },
            {
              label: 'Import from MTGO',
              onSelect: () => {
                setImportMenuAnchor(null)
                setImportMode('mtgo')
                setImportModalOpen(true)
              }
            },
            {
              label: 'Import Plain Text',
              onSelect: () => {
                setImportMenuAnchor(null)
                setImportMode('plaintext')
                setImportModalOpen(true)
              }
            },
            {
              label: 'Import from PDF',
              onSelect: () => {
                setImportMenuAnchor(null)
                void handleImportDeckPdf()
              }
            }
          ]}
        />
      )}

      {exportMenuAnchor && (
        <CardContextMenu
          x={exportMenuAnchor.x}
          y={exportMenuAnchor.y}
          onClose={() => setExportMenuAnchor(null)}
          actions={[
            {
              label: 'Copy for Moxfield',
              onSelect: () => {
                setExportMenuAnchor(null)
                handleCopyMoxfield()
              }
            },
            {
              label: 'Copy for Arena',
              onSelect: () => {
                setExportMenuAnchor(null)
                handleCopyArena()
              }
            },
            {
              label: 'Copy for MTGO',
              onSelect: () => {
                setExportMenuAnchor(null)
                handleCopyMtgo()
              }
            },
            {
              label: 'Copy Plain Text',
              onSelect: () => {
                setExportMenuAnchor(null)
                handleCopyPlainText()
              }
            },
            {
              label: 'Export to PDF',
              onSelect: () => {
                setExportMenuAnchor(null)
                void handleExportDeckPdf()
              }
            }
          ]}
        />
      )}

      {basicPipMenu &&
        (() => {
          const snowName = snowNameFor(basicPipMenu.name)
          const regularCount = basicLandCounts.get(basicPipMenu.name)?.count ?? 0
          const snowCount = basicLandCounts.get(snowName)?.count ?? 0
          return (
            <CardContextMenu
              x={basicPipMenu.x}
              y={basicPipMenu.y}
              onClose={() => setBasicPipMenu(null)}
              actions={[
                {
                  label: 'Change for Snow Lands',
                  onSelect: () => {
                    setBasicLandModal({ mode: 'snow', name: basicPipMenu.name })
                    setBasicPipMenu(null)
                  }
                },
                {
                  label: 'Change Printings for All Basics',
                  disabled: regularCount === 0,
                  title: regularCount === 0 ? `No ${basicPipMenu.name} in this deck yet` : undefined,
                  onSelect: () => {
                    setBasicLandModal({ mode: 'printing', name: basicPipMenu.name, printingTarget: 'regular' })
                    setBasicPipMenu(null)
                  }
                },
                {
                  label: 'Change Printings for All Snow Basics',
                  disabled: snowCount === 0,
                  title: snowCount === 0 ? `No Snow-Covered ${basicPipMenu.name} in this deck yet` : undefined,
                  onSelect: () => {
                    setBasicLandModal({ mode: 'printing', name: basicPipMenu.name, printingTarget: 'snow' })
                    setBasicPipMenu(null)
                  }
                }
              ]}
            />
          )
        })()}

      {basicLandModal && storedDeck && (
        <BasicLandModal
          mode={basicLandModal.mode}
          name={basicLandModal.name}
          printingTarget={basicLandModal.mode === 'printing' ? basicLandModal.printingTarget : undefined}
          deckCardIds={storedDeck.cardIds}
          cardsById={cardsById}
          onToggleInstance={(index) => {
            const current = cardsById[storedDeck.cardIds[index]]
            if (!current) return
            const target = current.name === basicLandModal.name ? snowNameFor(basicLandModal.name) : basicLandModal.name
            toggleBasicSnowAt(index, target)
          }}
          onApplyPrinting={(card) => {
            if (basicLandModal.mode !== 'printing') return
            const name = basicLandModal.printingTarget === 'snow' ? snowNameFor(basicLandModal.name) : basicLandModal.name
            changeAllBasicPrintings(name, card)
            setBasicLandModal(null)
          }}
          onClose={() => setBasicLandModal(null)}
        />
      )}

      {viewingCard && viewingKind === 'token' && (
        <CardDetail
          card={viewingCard}
          onClose={() => {
            setViewingCard(null)
            setViewingTokenName(null)
          }}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            setViewingTokenName(null)
            openTagSearch(tag)
          }}
          deckMode={{
            onPrintingChange: (newCard) => handleTokenPrintingChange(newCard),
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {viewingCard && viewingKind === 'commander' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            openTagSearch(tag)
          }}
          deckMode={{
            onPrintingChange: (newCard) => handleCommanderPrintingChange(newCard),
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            },
            isFlipped: viewingSlotId ? flippedIdSet.has(viewingSlotId) : false,
            onToggleFlip: () => {
              if (viewingSlotId) toggleFlipped(viewingSlotId)
            },
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {viewingCard && viewingKind === 'partner' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            openTagSearch(tag)
          }}
          deckMode={{
            onPrintingChange: (newCard) => handlePartnerPrintingChange(newCard),
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            },
            isFlipped: viewingSlotId ? flippedIdSet.has(viewingSlotId) : false,
            onToggleFlip: () => {
              if (viewingSlotId) toggleFlipped(viewingSlotId)
            },
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {viewingCard && viewingKind === 'card' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            openTagSearch(tag)
          }}
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
            },
            isFlipped: viewingSlotId ? flippedIdSet.has(foilKeyFor(viewingSlotId, viewingSlotOccurrence)) : false,
            onToggleFlip: () => {
              if (viewingSlotId) toggleFlipped(foilKeyFor(viewingSlotId, viewingSlotOccurrence))
            },
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {viewingCard && viewingKind === 'poolCard' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            openTagSearch(tag)
          }}
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
            },
            isFlipped: viewingSlotId ? flippedIdSet.has(viewingSlotId) : false,
            onToggleFlip: () => {
              if (viewingSlotId) toggleFlipped(viewingSlotId)
            },
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {viewingCard && viewingKind === 'wantCard' && (
        <CardDetail
          card={viewingCard}
          onClose={() => setViewingCard(null)}
          onTypeClick={openTypeSearch}
          onTagClick={(tag) => {
            setViewingCard(null)
            openTagSearch(tag)
          }}
          deckMode={{
            onRemove: () => {
              if (viewingSlotId) toggleWant({ ...viewingCard, id: viewingSlotId })
            },
            removeLabel: 'Remove from Want',
            onPrintingChange: (newCard) => {
              if (viewingSlotId) handleWantPrintingChange(viewingSlotId, newCard)
            },
            isFlipped: viewingSlotId ? flippedIdSet.has(viewingSlotId) : false,
            onToggleFlip: () => {
              if (viewingSlotId) toggleFlipped(viewingSlotId)
            },
            isFoil: viewingSlotId ? foilIdSet.has(viewingSlotId) : false,
            onToggleFoil: () => {
              if (viewingSlotId) toggleFoil(viewingSlotId)
            },
            ...userTagDeckModeProps(viewingCard.oracle_id),
            ...proxyArtDeckModeProps(viewingCard.oracle_id)
          }}
        />
      )}

      {importModalOpen && (
        <div className="card-detail-overlay" onClick={closeImportModal}>
          <div className="export-deck-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={closeImportModal}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Import from {IMPORT_MODE_LABELS[importMode]}
            </h3>
            <p className="app__hint">
              {IMPORT_MODE_HINTS[importMode]} This becomes the deck's new list — cards already here that aren't in
              it move to the Card Pool instead of being deleted; everything else is added.
            </p>
            <textarea
              className="export-deck-modal__textarea"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={IMPORT_MODE_PLACEHOLDERS[importMode]}
              spellCheck={false}
            />
            {importResult && (
              <div className="import-deck-modal__summary">
                <p className="app__hint">
                  Added {importResult.added} card(s)
                  {importResult.removed.length > 0 && `, moved ${importResult.removed.length} to the Card Pool`}.
                </p>
                {importResult.removed.length > 0 && (
                  <p className="app__hint">Moved to Card Pool (not in the imported list): {importResult.removed.join(', ')}</p>
                )}
                {importResult.outsideIdentity.length > 0 && (
                  <p className="import-deck-modal__warning">
                    ⚠ Outside color identity: {importResult.outsideIdentity.join(', ')}
                  </p>
                )}
                {importResult.banned.length > 0 && (
                  <p className="import-deck-modal__warning">
                    ⚠ Banned in Commander: {importResult.banned.join(', ')}
                  </p>
                )}
                {importResult.skippedCommander.length > 0 && (
                  <p className="app__hint">
                    This deck's own commander (skipped): {importResult.skippedCommander.join(', ')}
                  </p>
                )}
                {importResult.notFound.length > 0 && (
                  <p className="import-deck-modal__warning">Could not find: {importResult.notFound.join(', ')}</p>
                )}
              </div>
            )}
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={closeImportModal}>
                Close
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  if (importMode === 'moxfield') void handleImportMoxfield()
                  else if (importMode === 'arena') void handleImportArena()
                  else void handleImportNameOnly()
                }}
                disabled={importing || !importText.trim()}
              >
                {importing ? 'Importing…' : 'Confirm Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {infoModal && (
        <div className="card-detail-overlay" onClick={() => setInfoModal(null)}>
          <div className="export-deck-modal info-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={() => setInfoModal(null)}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              {infoModal.title}
            </h3>
            {infoModal.message.split('\n').map((line, i) => (
              <p className="app__hint" key={i}>
                {line}
              </p>
            ))}
            <div className="export-deck-modal__actions">
              <button className="primary-button" onClick={() => setInfoModal(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {logicModalOpen && (
        <div className="card-detail-overlay" onClick={closeLogicModal}>
          <div className="export-deck-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={closeLogicModal}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Import Logic
            </h3>
            <p className="app__hint">
              Paste a Logic file — deck-specific strategic guidance for the Playtest bot AI, written outside the app
              (see docs/logic-file-guide.md for the format and how to generate one for this deck).
            </p>
            <textarea
              className="export-deck-modal__textarea"
              value={logicText}
              onChange={(e) => setLogicText(e.target.value)}
              placeholder={'{\n  "biblioplexLogicFile": true,\n  "version": 1,\n  "rules": [...]\n}'}
              spellCheck={false}
            />
            {logicError && <p className="import-deck-modal__warning">⚠ {logicError}</p>}
            {logicWarnings.map((w) => (
              <p className="import-deck-modal__warning" key={w}>
                ⚠ {w}
              </p>
            ))}
            {logicImportedCount !== null && (
              <p className="app__hint">
                Saved {logicImportedCount} rule{logicImportedCount === 1 ? '' : 's'}.
              </p>
            )}
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={closeLogicModal}>
                Close
              </button>
              <button className="primary-button" onClick={handleImportLogic} disabled={logicImporting || !logicText.trim()}>
                {logicImporting ? 'Importing…' : 'Confirm Import'}
              </button>
            </div>
          </div>
        </div>
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

      {deckCardContextMenu && (
        <CardContextMenu
          x={deckCardContextMenu.x}
          y={deckCardContextMenu.y}
          onClose={() => setDeckCardContextMenu(null)}
          actions={[
            {
              label: consideringIdSet.has(deckCardContextMenu.card.id)
                ? 'Unmark as Considering'
                : 'Mark as Considering',
              onSelect: () => {
                toggleConsidering(deckCardContextMenu.card.id)
                setDeckCardContextMenu(null)
              }
            },
            ...(isBasicLand(deckCardContextMenu.card)
              ? []
              : [
                  {
                    label: 'Move to Pool',
                    onSelect: () => {
                      moveDeckCardToPool(deckCardContextMenu.card)
                      setDeckCardContextMenu(null)
                    }
                  }
                ]),
            {
              label: 'Remove from Deck',
              onSelect: () => {
                handleRemoveId(deckCardContextMenu.card.id)
                setDeckCardContextMenu(null)
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
                    onChange={(e) => setHotSwapDeckCategory(e.target.value as CardCategory | 'Considering')}
                  >
                    <option value="Considering">Considering</option>
                    {ALL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {DECK_CATEGORY_LABELS[cat] ?? cat}
                      </option>
                    ))}
                  </select>
                </div>
                {hotSwapDeckCards.length === 0 && (
                  <p className="app__hint">
                    {hotSwapDeckCategory === 'Considering'
                      ? 'No cards marked as Considering yet — right-click a card in the deck to flag it.'
                      : `No ${(DECK_CATEGORY_LABELS[hotSwapDeckCategory] ?? hotSwapDeckCategory).toLowerCase()} in the deck.`}
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
                        isConsidering={consideringIdSet.has(card.id)}
                        proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
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
                        proxyArtUrl={storedDeck?.proxyArtByKey?.[card.oracle_id]?.front}
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
