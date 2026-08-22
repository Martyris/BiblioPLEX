import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import CommanderPicker from './CommanderPicker'
import CardResults from './CardResults'
import ColorPips from './ColorPips'
import { SORT_OPTIONS } from './SortControl'
import { isError, type ScryfallCard, type StoredDeck } from '../types'
import { winRate, winRateColor } from '../winRate'
import { colorIdentityGradient } from '../colorIdentityName'
import { bracketColor } from '../bracketColor'
import { scoreColor } from '../deckScore'
import { BASE_EXCLUSION_TERMS } from '../queryBuilder'
import { detectSecondCommanderMode, secondCommanderQuery, type SecondCommanderMode } from '../partnerEligibility'

interface Props {
  onOpenDeck: (deckId: string) => void
}

type CreateStep = 'primary' | 'secondary'

const SIMPLIFIED_VIEW_KEY = 'mtgplatform.decksSimplifiedView'
const SCORE_RING_RADIUS = 16
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS

export default function DecksBrowser({ onOpenDeck }: Props) {
  const [decks, setDecks] = useState<StoredDeck[]>([])
  const [commanders, setCommanders] = useState<Record<string, ScryfallCard>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  // Which tile is currently being dragged over — separate from draggedId (the deck being
  // lifted) so the drop target itself gets a distinct highlight, matching the deck editor's
  // card-reorder feedback.
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [createStep, setCreateStep] = useState<CreateStep>('primary')
  const [primaryCommander, setPrimaryCommander] = useState<ScryfallCard | null>(null)
  const [secondMode, setSecondMode] = useState<SecondCommanderMode>(null)
  const [secondQuery, setSecondQuery] = useState('')
  const [simplified, setSimplified] = useState(() => localStorage.getItem(SIMPLIFIED_VIEW_KEY) === '1')
  // Only one of top/bottom is set — whichever direction has room. A tile near the bottom of
  // the (often scrolled) list would otherwise have its menu open downward off the visible
  // area, so it opens upward instead once there isn't roughly enough room below it.
  const [deckMenu, setDeckMenu] = useState<{ deckId: string; right: number; top?: number; bottom?: number } | null>(
    null
  )
  const [exportModal, setExportModal] = useState<{ deckName: string; text: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const [exportCopied, setExportCopied] = useState(false)

  // Purely a display filter — never touches `decks`, `order`, or persists anything, so
  // clearing filters always brings back every deck in exactly the position it was saved in.
  const [filterName, setFilterName] = useState('')
  const [filterColors, setFilterColors] = useState<string[]>([])
  const [filterColorMode, setFilterColorMode] = useState<'atLeast' | 'exactly'>('atLeast')
  const [filterBracket, setFilterBracket] = useState<'any' | 'none' | 1 | 2 | 3 | 4 | 5>('any')
  const [filterCoreMechanics, setFilterCoreMechanics] = useState<string[]>([])

  function toggleSimplified(): void {
    setSimplified((prev) => {
      const next = !prev
      localStorage.setItem(SIMPLIFIED_VIEW_KEY, next ? '1' : '0')
      return next
    })
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result = (await window.api.listDecks()) as StoredDeck[]
      const sorted = [...result].sort((a, b) => a.order - b.order)
      setDecks(sorted)

      const commanderIds = [
        ...new Set(sorted.flatMap((d) => [d.commanderId, d.partnerCommanderId].filter((id): id is string => Boolean(id))))
      ]
      if (commanderIds.length > 0) {
        const cardsResult = await window.api.getCardsByIds(commanderIds)
        if (!isError(cardsResult)) {
          const cards = (cardsResult as { data: ScryfallCard[] }).data ?? []
          setCommanders(Object.fromEntries(cards.map((c) => [c.id, c])))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Same "close rather than let it drift" fix used for the Card Tags menu — a position:fixed
  // menu doesn't track this scrollable list, so a scroll while it's open would leave it
  // hovering over whichever deck tile now happens to be under its old screen coordinates.
  useEffect(() => {
    if (!deckMenu) return
    function handleScroll(): void {
      setDeckMenu(null)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [deckMenu])

  function resetCreateFlow(): void {
    setPicking(false)
    setCreateStep('primary')
    setPrimaryCommander(null)
    setSecondMode(null)
    setSecondQuery('')
  }

  async function finalizeCreate(primary: ScryfallCard, secondary: ScryfallCard | null): Promise<void> {
    setCreating(true)
    try {
      const deck = (await window.api.createDeck(
        `${primary.name} Deck`,
        primary.id,
        primary.name,
        secondary?.id ?? null,
        secondary?.name ?? null
      )) as StoredDeck
      resetCreateFlow()
      onOpenDeck(deck.id)
    } finally {
      setCreating(false)
    }
  }

  async function handlePickPrimary(card: ScryfallCard): Promise<void> {
    const mode = detectSecondCommanderMode(card)
    if (mode) {
      setPrimaryCommander(card)
      setSecondMode(mode)
      setCreateStep('secondary')
      return
    }
    await finalizeCreate(card, null)
  }

  function requestDelete(deck: StoredDeck): void {
    setDeckMenu(null)
    setDeleteConfirm({ id: deck.id, name: deck.name })
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteConfirm) return
    await window.api.deleteDeck(deleteConfirm.id)
    setDeleteConfirm(null)
    refresh()
  }

  async function handleDuplicate(id: string): Promise<void> {
    setDeckMenu(null)
    await window.api.duplicateDeck(id)
    refresh()
  }

  // Builds a plain "<count> <name>" per-line decklist — the widely-supported bulk-import
  // format most other deckbuilding sites (Moxfield, Archidekt, TappedOut, MTGGoldfish, etc.)
  // expect, deliberately without set/collector-number info — and opens it in an editable box
  // to copy from, rather than saving straight to a file, since pasting into another site's
  // import box is the actual common case.
  async function handleExport(deck: StoredDeck): Promise<void> {
    setDeckMenu(null)
    const allIds = [deck.commanderId, ...(deck.partnerCommanderId ? [deck.partnerCommanderId] : []), ...deck.cardIds]
    const result = await window.api.getCardsByIds([...new Set(allIds)])
    if (isError(result)) {
      window.alert(`Could not load card data to export: ${result.details}`)
      return
    }
    const cardsById = new Map((result as { data: ScryfallCard[] }).data.map((c) => [c.id, c]))

    const nameCounts = new Map<string, number>()
    for (const id of deck.cardIds) {
      const name = cardsById.get(id)?.name ?? '(unknown card)'
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
    const mainLines = [...nameCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${count} ${name}`)

    const commanderLines = [`1 ${deck.commanderName}`]
    if (deck.partnerCommanderId && deck.partnerCommanderName) commanderLines.push(`1 ${deck.partnerCommanderName}`)

    const content = [...commanderLines, '', ...mainLines].join('\n')
    setExportCopied(false)
    setExportModal({ deckName: deck.name, text: content })
  }

  async function copyExportText(): Promise<void> {
    if (!exportModal) return
    await navigator.clipboard.writeText(exportModal.text)
    setExportCopied(true)
    window.setTimeout(() => setExportCopied(false), 1500)
  }

  // A true swap — the dragged deck takes the target's exact spot and vice versa, rather than
  // removing the dragged deck first and re-inserting before the target. Same fix as the deck
  // editor's card reorder: "remove then insert" shifts everything between the two positions by
  // one slot, and for the immediate-next-neighbor case it puts the dragged deck right back
  // where it started (removing it shifts the target back into the same index), which looked
  // like dragging onto the very next tile simply did nothing.
  async function handleReorder(draggedDeckId: string, targetDeckId: string): Promise<void> {
    if (draggedDeckId === targetDeckId) return
    const ids = decks.map((d) => d.id)
    const fromIdx = ids.indexOf(draggedDeckId)
    const toIdx = ids.indexOf(targetDeckId)
    if (fromIdx === -1 || toIdx === -1) return
    ;[ids[fromIdx], ids[toIdx]] = [ids[toIdx], ids[fromIdx]]

    // Optimistic reorder so the UI responds instantly, then persist.
    const byId = new Map(decks.map((d) => [d.id, d]))
    setDecks(ids.map((id) => byId.get(id)).filter((d): d is StoredDeck => Boolean(d)))
    await window.api.reorderDecks(ids)
  }

  // Commander/partner art isn't loaded per-deck anywhere else, so each deck's color identity
  // is computed once here (reused by both the filter and the render below) rather than twice.
  const decksWithIdentity = useMemo(() => {
    return decks.map((deck) => {
      const commander = commanders[deck.commanderId]
      const partner = deck.partnerCommanderId ? commanders[deck.partnerCommanderId] : undefined
      const colorIdentity = [
        ...new Set([...(commander?.color_identity ?? []), ...(partner?.color_identity ?? [])])
      ]
      return { deck, commander, partner, colorIdentity }
    })
  }, [decks, commanders])

  const allCoreMechanicTags = useMemo(() => {
    const tags = new Set<string>()
    for (const deck of decks) for (const tag of deck.coreMechanicTags) tags.add(tag)
    return [...tags].sort()
  }, [decks])

  const filtersActive =
    filterName.trim() !== '' || filterColors.length > 0 || filterBracket !== 'any' || filterCoreMechanics.length > 0

  function clearFilters(): void {
    setFilterName('')
    setFilterColors([])
    setFilterColorMode('atLeast')
    setFilterBracket('any')
    setFilterCoreMechanics([])
  }

  function toggleFilterColor(code: string): void {
    setFilterColors((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))
  }

  function toggleFilterCoreMechanic(tag: string): void {
    setFilterCoreMechanics((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  // A pure display filter — it only ever changes what's rendered from `decks`, never `decks`
  // itself, so it can't touch the persisted `order` field. Clearing every filter always shows
  // every deck again in exactly the order it was saved in.
  const visibleDecks = useMemo(() => {
    return decksWithIdentity.filter(({ deck, colorIdentity }) => {
      if (filterName.trim() && !deck.name.toLowerCase().includes(filterName.trim().toLowerCase())) return false

      if (filterColors.length > 0) {
        const identitySet = new Set(colorIdentity)
        if (filterColorMode === 'exactly') {
          if (identitySet.size !== filterColors.length || !filterColors.every((c) => identitySet.has(c))) return false
        } else if (!filterColors.every((c) => identitySet.has(c))) {
          return false
        }
      }

      if (filterBracket === 'none' && deck.bracket !== null) return false
      if (typeof filterBracket === 'number' && deck.bracket !== filterBracket) return false

      if (filterCoreMechanics.length > 0 && !filterCoreMechanics.some((t) => deck.coreMechanicTags.includes(t))) {
        return false
      }

      return true
    })
  }, [decksWithIdentity, filterName, filterColors, filterColorMode, filterBracket, filterCoreMechanics])

  if (picking && createStep === 'secondary' && primaryCommander) {
    const trimmed = secondQuery.trim()
    const query = [...BASE_EXCLUSION_TERMS, secondCommanderQuery(secondMode), trimmed].filter(Boolean).join(' ')
    return (
      <div className="app__results">
        <div className="app__results-toolbar">
          <button
            className="back-link"
            onClick={() => {
              setCreateStep('primary')
              setPrimaryCommander(null)
            }}
          >
            ← Back
          </button>
          <h2 className="set-detail__title">
            {secondMode === 'background' ? 'Choose a Background' : 'Choose a partner'} for{' '}
            {primaryCommander.name}
          </h2>
          <button
            className="primary-button"
            onClick={() => finalizeCreate(primaryCommander, null)}
            disabled={creating}
          >
            Skip — single commander
          </button>
        </div>
        {creating && <p className="app__hint">Creating deck…</p>}
        {!creating && (
          <>
            <input
              className="app__search"
              type="text"
              placeholder={secondMode === 'background' ? 'Search backgrounds…' : 'Search for a partner…'}
              value={secondQuery}
              onChange={(e) => setSecondQuery(e.target.value)}
              autoFocus
            />
            <CardResults
              query={query}
              sort={SORT_OPTIONS[0]}
              emptyHint="No results."
              onSelect={(c) => finalizeCreate(primaryCommander, c)}
              rawText={trimmed}
            />
          </>
        )}
      </div>
    )
  }

  if (picking) {
    return (
      <div className="app__results">
        <div className="app__results-toolbar">
          <button className="back-link" onClick={resetCreateFlow}>
            ← Cancel
          </button>
          <h2 className="set-detail__title">Choose a commander</h2>
        </div>
        {creating && <p className="app__hint">Creating deck…</p>}
        {!creating && <CommanderPicker onSelect={handlePickPrimary} />}
      </div>
    )
  }

  return (
    <div className="app__results">
      <div className="app__results-toolbar">
        <h2 className="set-detail__title">My Decks</h2>
        <button className="secondary-button" onClick={toggleSimplified}>
          {simplified ? 'Show Art' : 'Simplified View'}
        </button>
        <button className="primary-button" onClick={() => setPicking(true)}>
          + New Deck
        </button>
      </div>

      {loading && <p className="app__hint">Loading decks…</p>}
      {error && <p className="app__error">{error}</p>}
      {!loading && !error && decks.length === 0 && (
        <p className="app__hint">No decks yet — create one to get started.</p>
      )}

      {!loading && !error && decks.length > 0 && (
        <div className="deck-filter-bar">
          <div className="filter-group">
            <span className="filter-group__label">Name</span>
            <input
              type="text"
              className="filter-text"
              placeholder="Search decks…"
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
            />
          </div>

          <div className="filter-group">
            <div className="filter-chip-row">
              {['W', 'U', 'B', 'R', 'G'].map((code) => (
                <button
                  key={code}
                  className={`filter-chip filter-chip--${code} ${filterColors.includes(code) ? 'is-active' : ''}`}
                  onClick={() => toggleFilterColor(code)}
                >
                  {code}
                </button>
              ))}
            </div>
            <select
              className="filter-select filter-select--compact"
              value={filterColorMode}
              onChange={(e) => setFilterColorMode(e.target.value as 'atLeast' | 'exactly')}
            >
              <option value="atLeast">Includes colors</option>
              <option value="exactly">Exact combination</option>
            </select>
          </div>

          <div className="filter-group">
            <span className="filter-group__label">Bracket</span>
            <select
              className="filter-select"
              value={filterBracket}
              onChange={(e) => {
                const v = e.target.value
                setFilterBracket(v === 'any' || v === 'none' ? v : (Number(v) as 1 | 2 | 3 | 4 | 5))
              }}
            >
              <option value="any">Any bracket</option>
              <option value="none">No bracket</option>
              <option value="1">Bracket 1</option>
              <option value="2">Bracket 2</option>
              <option value="3">Bracket 3</option>
              <option value="4">Bracket 4</option>
              <option value="5">Bracket 5</option>
            </select>
          </div>

          {allCoreMechanicTags.length > 0 && (
            <div className="filter-group">
              <span className="filter-group__label">Core Mechanics</span>
              <div className="filter-chip-row">
                {allCoreMechanicTags.map((tag) => (
                  <button
                    key={tag}
                    className={`filter-chip filter-chip--text ${filterCoreMechanics.includes(tag) ? 'is-active' : ''}`}
                    onClick={() => toggleFilterCoreMechanic(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filtersActive && (
            <button className="filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {!loading && !error && decks.length > 0 && visibleDecks.length === 0 && (
        <p className="app__hint">No decks match your filters.</p>
      )}

      <div className="deck-list">
        {visibleDecks.map(({ deck, commander, partner, colorIdentity }) => {
          const rate = winRate(deck.wins, deck.losses)
          return (
            <button
              key={deck.id}
              className={`deck-card ${draggedId === deck.id ? 'is-dragging' : ''} ${dragOverId === deck.id ? 'is-drag-over' : ''} ${simplified ? 'deck-card--simplified' : ''}`}
              onClick={() => onOpenDeck(deck.id)}
              draggable
              onDragStart={(e) => {
                setDraggedId(deck.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setDragOverId(null)
              }}
              onDragEnter={() => setDragOverId(deck.id)}
              onDragLeave={(e) => {
                // This tile has a lot of nested children (art background, image stack, stat
                // blocks) — moving the pointer between them fires dragleave on the tile itself
                // before the (bubbled) dragenter for the child re-arrives, which without this
                // check clears the highlight every time the pointer crosses a child boundary
                // instead of only when it actually leaves the tile. relatedTarget is what the
                // pointer is moving INTO; if that's still inside this tile, it hasn't left.
                if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
                setDragOverId((prev) => (prev === deck.id ? null : prev))
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverId(deck.id)
              }}
              onDrop={() => {
                if (draggedId) handleReorder(draggedId, deck.id)
                setDraggedId(null)
                setDragOverId(null)
              }}
            >
              {commander?.image_uris?.art_crop && (
                <span
                  className="deck-card__art-bg"
                  style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
                />
              )}
              <span className="deck-card__accent" style={{ background: colorIdentityGradient(colorIdentity) }} />
              <span className="deck-card__drag-handle" title="Drag to reorder">
                ⠿
              </span>
              <span
                className="deck-card__menu-trigger"
                onClick={(e) => {
                  e.stopPropagation()
                  if (deckMenu?.deckId === deck.id) {
                    setDeckMenu(null)
                    return
                  }
                  const rect = e.currentTarget.getBoundingClientRect()
                  const right = window.innerWidth - rect.right
                  // ~150px covers all three menu rows — an estimate rather than measuring the
                  // real menu is fine here since it hasn't rendered yet at click time.
                  const MENU_HEIGHT_ESTIMATE = 150
                  if (window.innerHeight - rect.bottom < MENU_HEIGHT_ESTIMATE) {
                    setDeckMenu({ deckId: deck.id, right, bottom: window.innerHeight - rect.top + 4 })
                  } else {
                    setDeckMenu({ deckId: deck.id, right, top: rect.bottom + 4 })
                  }
                }}
                title="Deck options"
              >
                ⋮
              </span>
              {deckMenu?.deckId === deck.id &&
                createPortal(
                  <>
                    <div
                      className="tag-menu-backdrop"
                      onClick={(e) => {
                        // Portaled elements still bubble through the React tree they're
                        // written in (not the real DOM tree) — without this, dismissing the
                        // menu also bubbles up to this tile's own onClick and opens the deck.
                        e.stopPropagation()
                        setDeckMenu(null)
                      }}
                    />
                    <div
                      className="tag-menu"
                      style={{
                        right: deckMenu.right,
                        ...(deckMenu.top !== undefined ? { top: deckMenu.top } : { bottom: deckMenu.bottom })
                      }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDuplicate(deck.id)
                        }}
                      >
                        Duplicate Deck
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleExport(deck)
                        }}
                      >
                        Export Deck
                      </button>
                      <button
                        className="tag-menu__destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          requestDelete(deck)
                        }}
                      >
                        Delete Deck
                      </button>
                    </div>
                  </>,
                  document.body
                )}

              <div className="deck-card__content">
                {!simplified && commander?.image_uris?.small && (
                  <div className="deck-card__image-stack">
                    {partner?.image_uris?.small && (
                      <img
                        className="deck-card__image deck-card__image--behind"
                        src={partner.image_uris.small}
                        alt={partner.name}
                      />
                    )}
                    <img
                      className="deck-card__image deck-card__image--front"
                      src={commander.image_uris.small}
                      alt={deck.commanderName}
                    />
                  </div>
                )}

                <div className="deck-card__body">
                  <div className="deck-card__name">{deck.name}</div>
                  {commander && <ColorPips colors={colorIdentity} size={16} showName />}
                  <div className="deck-card__meta-row">
                    <span>
                      {deck.commanderName}
                      {deck.partnerCommanderName ? ` + ${deck.partnerCommanderName}` : ''}
                    </span>
                    <span className="deck-card__dot">·</span>
                    <span>{deck.cardIds.length + 1 + (deck.partnerCommanderId ? 1 : 0)} card(s)</span>
                  </div>
                </div>

                <div className="deck-card__stats">
                  {deck.coreMechanicTags.length > 0 && (
                    <>
                      <div className="deck-card__stat deck-card__stat--core-mechanics">
                        {deck.coreMechanicTags.map((tag) => (
                          <span key={tag} className="deck-card__core-mechanic-badge" title="Core Mechanic">
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="deck-card__stat-divider" />
                    </>
                  )}
                  {deck.lastScore && (
                    <>
                      <div className="deck-card__stat deck-card__stat--score">
                        <div
                          className="deck-card__score-ring"
                          style={{ '--score-color': scoreColor(deck.lastScore.overall) } as React.CSSProperties}
                        >
                          <svg viewBox="0 0 40 40">
                            <circle className="deck-card__score-ring-track" cx="20" cy="20" r={SCORE_RING_RADIUS} />
                            <circle
                              className="deck-card__score-ring-fill"
                              cx="20"
                              cy="20"
                              r={SCORE_RING_RADIUS}
                              style={{
                                stroke: scoreColor(deck.lastScore.overall),
                                strokeDasharray: SCORE_RING_CIRCUMFERENCE,
                                strokeDashoffset:
                                  SCORE_RING_CIRCUMFERENCE * (1 - deck.lastScore.overall / 100)
                              }}
                            />
                          </svg>
                          <span className="deck-card__score-grade">{deck.lastScore.grade}</span>
                        </div>
                      </div>
                      <div className="deck-card__stat-divider" />
                    </>
                  )}
                  <div className="deck-card__stat deck-card__stat--bracket">
                    <span
                      className="deck-card__bracket-text"
                      data-empty={deck.bracket == null}
                      style={deck.bracket ? { color: bracketColor(deck.bracket) } : undefined}
                    >
                      {deck.bracket ? `Bracket ${deck.bracket}` : 'No bracket'}
                    </span>
                  </div>
                  <div className="deck-card__stat-divider" />
                  <div className="deck-card__stat deck-card__stat--record">
                    {rate === null ? (
                      <span className="deck-card__stat-value deck-card__stat-value--muted">No games</span>
                    ) : (
                      <span className="deck-card__record-line">
                        <span className="deck-card__record-wl">
                          {deck.wins}W - {deck.losses}L
                        </span>
                        <span className="deck-card__stat-value" style={{ color: winRateColor(rate) }}>
                          {Math.round(rate * 100)}%
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {exportModal && (
        <div className="card-detail-overlay" onClick={() => setExportModal(null)}>
          <div className="export-deck-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={() => setExportModal(null)}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Export — {exportModal.deckName}
            </h3>
            <p className="app__hint">Edit if needed, then copy and paste into another site's import box.</p>
            <textarea
              className="export-deck-modal__textarea"
              value={exportModal.text}
              onChange={(e) => setExportModal({ ...exportModal, text: e.target.value })}
              spellCheck={false}
            />
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={() => setExportModal(null)}>
                Close
              </button>
              <button className="primary-button" onClick={copyExportText}>
                {exportCopied ? '✓ Copied!' : 'Copy Text'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="card-detail-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Delete Deck
            </h3>
            <p className="app__hint">
              Delete "{deleteConfirm.name}"? This cannot be undone.
            </p>
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button className="primary-button confirm-modal__destructive" onClick={confirmDelete}>
                Delete Deck
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
