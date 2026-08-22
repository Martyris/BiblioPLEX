import type { EdhrecCardEntry } from '../types'
import { scryfallImageUrl } from '../scryfallImage'

// Priority: being in the deck always wins — a deck card is also always in the pool (added
// there automatically), so showing a separate pool badge on top would just be noise.
type CardStatus = 'deck' | 'want' | 'pool'

const STATUS_LABEL: Record<CardStatus, string> = {
  deck: '✓ In Deck',
  want: '✓ Wanted',
  pool: '✓ In Pool'
}

const STATUS_BADGE_CLASS: Record<CardStatus, string> = {
  deck: '',
  want: 'card-tile__badge--want',
  pool: 'card-tile__badge--pool'
}

const STATUS_OUTLINE_CLASS: Record<CardStatus, string> = {
  deck: 'is-in-deck',
  want: 'is-wanted',
  pool: 'is-pooled'
}

interface Props {
  entry: EdhrecCardEntry
  loading?: boolean
  status?: CardStatus
  onSelect: (entry: EdhrecCardEntry) => void
  onContextMenu?: (entry: EdhrecCardEntry, e: React.MouseEvent) => void
}

export default function EdhrecCardTile({ entry, loading, status, onSelect, onContextMenu }: Props) {
  const inclusionPct =
    entry.potential_decks > 0 ? Math.round((entry.num_decks / entry.potential_decks) * 100) : 0
  const synergyPct = Math.round(entry.synergy * 100)

  return (
    <button
      className={`edhrec-tile ${loading ? 'is-loading' : ''} ${status ? STATUS_OUTLINE_CLASS[status] : ''}`}
      onClick={() => onSelect(entry)}
      onContextMenu={(e) => onContextMenu?.(entry, e)}
      title={entry.name}
      disabled={loading}
    >
      <div className="edhrec-tile__image-wrap">
        <img src={scryfallImageUrl(entry.id)} alt={entry.name} loading="lazy" />
        {status && (
          <span className={`card-tile__badge ${STATUS_BADGE_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
        )}
      </div>
      <div className="edhrec-tile__stats">
        <span>{inclusionPct}% of decks</span>
        {synergyPct !== 0 && (
          <span className={synergyPct > 0 ? 'is-positive' : 'is-negative'}>
            {synergyPct > 0 ? '+' : ''}
            {synergyPct}% synergy
          </span>
        )}
      </div>
    </button>
  )
}
