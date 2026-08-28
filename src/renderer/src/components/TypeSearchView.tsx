import { useEffect, useMemo, useState } from 'react'
import CardTile from './CardTile'
import CardContextMenu from './CardContextMenu'
import FilterPanel from './FilterPanel'
import TagAutocomplete from './TagAutocomplete'
import SortControl, { SORT_OPTIONS, type SortOption } from './SortControl'
import { useCardResults } from '../useCardResults'
import { BASE_EXCLUSION_TERMS, cardMatchesFilters, EMPTY_FILTERS, EXCLUDE_TOKENS_TERM, type FilterState } from '../queryBuilder'
import type { ScryfallCard } from '../types'

interface Props {
  // The type/subtype words already picked (e.g. from clicking one in Card Inspect) — same
  // division of responsibility as TagSearchView's initialTags, empty when opened fresh via the
  // "Search by Type" button.
  initialTerms: string[]
  onBack: () => void
  onSelectCard: (card: ScryfallCard) => void
  // Right-click menu actions — "Add to Deck" reuses onSelectCard; omit Pool/Want to leave them
  // out of the menu (e.g. when this view isn't opened from within a deck).
  onAddToPool?: (card: ScryfallCard) => void
  onAddToWant?: (card: ScryfallCard) => void
  getMarker?: (card: ScryfallCard) => 'want' | 'pool' | undefined
  deckOracleIds?: Set<string>
  // The deck's (commander + partner) color identity — same reasoning as TagSearchView: without
  // this, a type/subtype search surfaces plenty of cards the deck could never actually run.
  colorIdentity?: string[]
}

const DEFAULT_SORT = SORT_OPTIONS.find((o) => o.order === 'edhrec') ?? SORT_OPTIONS[0]

/** Live Scryfall search for one or more clicked type/subtype words (see CardDetail's
 *  onTypeClick) — same shape as TagSearchView (back button, chip row you can keep narrowing,
 *  right-click "Add to Deck/Pool/Want"), but backed by a real Scryfall type-line query instead
 *  of the local Card Tag index, since types/subtypes aren't part of that tag vocabulary at all. */
export default function TypeSearchView({
  initialTerms,
  onBack,
  onSelectCard,
  onAddToPool,
  onAddToWant,
  getMarker,
  deckOracleIds,
  colorIdentity
}: Props) {
  const [terms, setTerms] = useState<string[]>(initialTerms)
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [contextMenu, setContextMenu] = useState<{ card: ScryfallCard; x: number; y: number } | null>(null)
  const [availableTypes, setAvailableTypes] = useState<string[]>([])

  useEffect(() => {
    window.api.getCardTypeCatalog().then((result) => {
      setAvailableTypes((result as { data?: string[] })?.data ?? [])
    })
  }, [])

  // Each selected term becomes its own t:"..." clause — Scryfall ANDs separate query terms
  // together, same narrowing behavior as TagSearchView adding more tags.
  const query =
    terms.length > 0
      ? [...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, ...terms.map((term) => `t:"${term}"`)].join(' ')
      : ''
  const { cards, loading, hasMore, loadingMore, error, loadMore } = useCardResults(query, sort)

  const filteredResults = useMemo(() => {
    const identitySet = colorIdentity ? new Set(colorIdentity) : null
    return cards.filter((card) => {
      if (identitySet && !(card.color_identity ?? []).every((c) => identitySet.has(c))) return false
      return cardMatchesFilters(card, filters)
    })
  }, [cards, colorIdentity, filters])

  function addTerm(term: string): void {
    if (terms.includes(term)) return
    setTerms((prev) => [...prev, term])
  }

  function removeTerm(term: string): void {
    setTerms((prev) => prev.filter((t) => t !== term))
  }

  function handleContextMenu(card: ScryfallCard, e: React.MouseEvent): void {
    if (!onAddToPool && !onAddToWant) return
    e.preventDefault()
    setContextMenu({ card, x: e.clientX, y: e.clientY })
  }

  function runContextAction(action: (card: ScryfallCard) => void): void {
    if (!contextMenu) return
    action(contextMenu.card)
    setContextMenu(null)
  }

  return (
    <div className="app__results">
      <div className="app__results-toolbar">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← Back to deck
        </button>
        <h2 className="set-detail__title tag-search__title">Search by Type</h2>
        <SortControl value={sort} onChange={setSort} />
      </div>

      <ul className="tag-row card-tags__draft-row">
        {terms.map((term) => (
          <li key={term} className="tag-chip is-active card-tags__chip">
            {term}
            <button
              type="button"
              className="card-tags__chip-remove"
              onClick={() => removeTerm(term)}
              aria-label={`Remove ${term}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <TagAutocomplete
        availableTags={availableTypes}
        excludeTags={terms}
        onAdd={addTerm}
        placeholder="Add another type or subtype to narrow the search…"
      />

      <div className="tag-search__body">
        <aside className="app__sidebar">
          <FilterPanel filters={filters} onChange={setFilters} />
        </aside>
        <div className="tag-search__results">
          {terms.length === 0 && <p className="app__hint">Add a type or subtype above to start searching.</p>}
          {loading && <p className="app__hint">Searching…</p>}
          {error && <p className="app__error">{error}</p>}
          {!loading && !error && terms.length > 0 && filteredResults.length === 0 && (
            <p className="app__hint">No cards match all selected types.</p>
          )}

          <div className="card-grid">
            {filteredResults.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                onSelect={onSelectCard}
                inDeck={deckOracleIds?.has(card.oracle_id)}
                onContextMenu={handleContextMenu}
                marker={getMarker?.(card)}
              />
            ))}
          </div>
          {hasMore && (
            <button className="load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>

      {contextMenu && (
        <CardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={[
            { label: 'Add to Deck', onSelect: () => runContextAction(onSelectCard) },
            ...(onAddToPool ? [{ label: 'Add to Pool', onSelect: () => runContextAction(onAddToPool) }] : []),
            ...(onAddToWant ? [{ label: 'Add to Want', onSelect: () => runContextAction(onAddToWant) }] : [])
          ]}
        />
      )}
    </div>
  )
}
