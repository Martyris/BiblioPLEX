import { useEffect, useState, type MouseEvent } from 'react'
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
  const [createStep, setCreateStep] = useState<CreateStep>('primary')
  const [primaryCommander, setPrimaryCommander] = useState<ScryfallCard | null>(null)
  const [secondMode, setSecondMode] = useState<SecondCommanderMode>(null)
  const [secondQuery, setSecondQuery] = useState('')
  const [simplified, setSimplified] = useState(() => localStorage.getItem(SIMPLIFIED_VIEW_KEY) === '1')

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

  async function handleDelete(id: string, e: MouseEvent): Promise<void> {
    e.stopPropagation()
    if (!window.confirm('Delete this deck? This cannot be undone.')) return
    await window.api.deleteDeck(id)
    refresh()
  }

  async function handleReorder(draggedDeckId: string, targetDeckId: string): Promise<void> {
    if (draggedDeckId === targetDeckId) return
    const ids = decks.map((d) => d.id)
    const fromIdx = ids.indexOf(draggedDeckId)
    if (fromIdx === -1) return
    ids.splice(fromIdx, 1)
    const toIdx = ids.indexOf(targetDeckId)
    if (toIdx === -1) return
    ids.splice(toIdx, 0, draggedDeckId)

    // Optimistic reorder so the UI responds instantly, then persist.
    const byId = new Map(decks.map((d) => [d.id, d]))
    setDecks(ids.map((id) => byId.get(id)).filter((d): d is StoredDeck => Boolean(d)))
    await window.api.reorderDecks(ids)
  }

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

      <div className="deck-list">
        {decks.map((deck) => {
          const commander = commanders[deck.commanderId]
          const partner = deck.partnerCommanderId ? commanders[deck.partnerCommanderId] : undefined
          const colorIdentity = [
            ...new Set([...(commander?.color_identity ?? []), ...(partner?.color_identity ?? [])])
          ]
          const rate = winRate(deck.wins, deck.losses)
          return (
            <button
              key={deck.id}
              className={`deck-card ${draggedId === deck.id ? 'is-dragging' : ''} ${simplified ? 'deck-card--simplified' : ''}`}
              onClick={() => onOpenDeck(deck.id)}
              draggable
              onDragStart={() => setDraggedId(deck.id)}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (draggedId) handleReorder(draggedId, deck.id)
                setDraggedId(null)
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
              <span className="deck-card__delete" onClick={(e) => handleDelete(deck.id, e)}>
                ×
              </span>

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
    </div>
  )
}
