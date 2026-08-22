import CardTile from './CardTile'
import type { SortOption } from './SortControl'
import { useCardResults } from '../useCardResults'
import type { ScryfallCard } from '../types'

interface Props {
  query: string
  sort: SortOption
  emptyHint: string
  onSelect: (card: ScryfallCard) => void
  // Drives the green "in deck" outline.
  isInDeck?: (card: ScryfallCard) => boolean
  badgeLabel?: string
  // Drives the badge text's visibility independent of the outline — defaults to isInDeck
  // when omitted. Lets a view show a badge (e.g. "✓ Wanted") without the deck outline.
  getBadge?: (card: ScryfallCard) => boolean
  // Marks a result already on the Card Pool or Want list, independent of the deck badge.
  getMarker?: (card: ScryfallCard) => 'want' | 'pool' | undefined
  // The plain free-text the user typed, before filters/exclusion terms were mixed in —
  // enables the foreign-language-name fallback (see useCardResults). Omit where there's no
  // free-text box (e.g. a set browser with no search input).
  rawText?: string
}

export default function CardResults({
  query,
  sort,
  emptyHint,
  onSelect,
  isInDeck,
  badgeLabel,
  getBadge,
  getMarker,
  rawText
}: Props) {
  const { cards, total, hasMore, loading, loadingMore, error, loadMore } = useCardResults(query, sort, rawText)
  const isEmpty = query.trim() === ''

  return (
    <>
      {loading && <p className="app__hint">Searching…</p>}
      {error && <p className="app__error">{error}</p>}
      {!error && !loading && isEmpty && <p className="app__hint">{emptyHint}</p>}
      {!error && !loading && !isEmpty && total !== null && (
        <p className="app__hint">{total} card(s)</p>
      )}
      <div className="card-grid">
        {cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            onSelect={onSelect}
            inDeck={isInDeck?.(card)}
            badgeLabel={badgeLabel}
            showBadge={getBadge?.(card)}
            marker={getMarker?.(card)}
          />
        ))}
      </div>
      {hasMore && (
        <button className="load-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}
