import { useMemo } from 'react'
import CardTile from './CardTile'
import type { SortOption } from './SortControl'
import { useCardResults, type CardResultsState } from '../useCardResults'
import { isOutsideColorIdentity } from '../deckLogic'
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
  // The deck's commander(s) color identity — when supplied, results within it are shown first
  // (matches outside it follow, in the same relative order the search itself returned them in),
  // and out-of-identity tiles are dimmed/grayscaled (see CardTile's outsideIdentity prop).
  // Omit for a search context with no deck to be "in/out of identity" relative to.
  colorIdentity?: string[]
  // The plain free-text the user typed, before filters/exclusion terms were mixed in —
  // enables the foreign-language-name fallback (see useCardResults). Omit where there's no
  // free-text box (e.g. a set browser with no search input).
  rawText?: string
  // Pre-fetched results (e.g. a parent that also drives a search-as-you-type dropdown off the
  // same query) — supply this to skip this component's own useCardResults call and avoid
  // firing the same Scryfall search twice.
  results?: CardResultsState
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
  colorIdentity,
  rawText,
  results
}: Props) {
  const ownResults = useCardResults(results ? '' : query, sort, results ? '' : rawText)
  const { cards: rawCards, total, hasMore, loading, loadingMore, error, loadMore } = results ?? ownResults
  const isEmpty = query.trim() === ''

  // Stable partition, not a re-sort — within "in identity" and "outside identity" the search's
  // own order (relevance, EDHREC rank, whatever `sort` picked) is preserved; only which of the
  // two groups a card lands in changes anything.
  const cards = useMemo(() => {
    if (!colorIdentity) return rawCards
    const inIdentity: ScryfallCard[] = []
    const outsideIdentity: ScryfallCard[] = []
    for (const card of rawCards) {
      ;(isOutsideColorIdentity(card, colorIdentity) ? outsideIdentity : inIdentity).push(card)
    }
    return [...inIdentity, ...outsideIdentity]
  }, [rawCards, colorIdentity])

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
            outsideIdentity={colorIdentity ? isOutsideColorIdentity(card, colorIdentity) : undefined}
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
