import type { ScryfallCard } from '../types'

interface Props {
  card: ScryfallCard
  onSelect: (card: ScryfallCard) => void
  // Drives the green "in deck" outline. Badge visibility follows this unless showBadge
  // overrides it (e.g. Want's "✓ Wanted" badge with no outline).
  inDeck?: boolean
  badgeLabel?: string
  showBadge?: boolean
  onContextMenu?: (card: ScryfallCard, e: React.MouseEvent) => void
  // Marks a search-result card that's already on the Card Pool or Want list (independent of
  // whether it's actually in the deck) — a colored outline, distinct from the "in deck" one.
  marker?: 'want' | 'pool'
  // Owned-in-foil, per the card-inspect toggle — renders the same shimmer effect as the
  // inspect view, directly over the thumbnail.
  isFoil?: boolean
  // Set only for cards actually sitting in a deck's own 99 — a search result or Want-list
  // tile isn't part of the deck yet, so legality doesn't apply to it the same way.
  illegalReason?: 'color-identity' | 'banned' | null
}

const ILLEGAL_LABELS: Record<'color-identity' | 'banned', string> = {
  'color-identity': '⚠ Outside Color Identity',
  banned: '⚠ Banned in Commander'
}

export default function CardTile({
  card,
  onSelect,
  inDeck,
  badgeLabel = '✓ In Deck',
  showBadge,
  onContextMenu,
  marker,
  isFoil,
  illegalReason
}: Props) {
  const image = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal
  const markerClass = marker === 'want' ? 'is-wanted' : marker === 'pool' ? 'is-pooled' : ''
  const shouldShowBadge = showBadge ?? inDeck

  return (
    <button
      className={`card-tile ${inDeck ? 'is-in-deck' : ''} ${markerClass} ${isFoil ? 'is-foil' : ''}`}
      onClick={() => onSelect(card)}
      onContextMenu={(e) => onContextMenu?.(card, e)}
      title={card.name}
    >
      {image ? (
        <img src={image} alt={card.name} loading="lazy" />
      ) : (
        <div className="card-tile__placeholder">{card.name}</div>
      )}
      {shouldShowBadge && <span className="card-tile__badge">{badgeLabel}</span>}
      {card.game_changer && (
        <span className="card-tile__gc-badge" title="Game Changer — a Commander Bracket-defining card">
          GC
        </span>
      )}
      {illegalReason && (
        <span className="card-tile__illegal-badge" title={ILLEGAL_LABELS[illegalReason]}>
          {ILLEGAL_LABELS[illegalReason]}
        </span>
      )}
    </button>
  )
}
