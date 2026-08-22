import { useEffect, useState } from 'react'
import CardTile from './CardTile'
import CardResults from './CardResults'
import { BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM } from '../queryBuilder'
import { isError, type EdhrecTopCommander, type ScryfallCard } from '../types'

function TopCommandersBrowser({ onSelect }: { onSelect: (card: ScryfallCard) => void }) {
  const [cards, setCards] = useState<ScryfallCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getTopCommanders()
      .then(async (result: unknown) => {
        if (cancelled) return
        if (isError(result)) {
          setError(result.details)
          return
        }
        const top = result as EdhrecTopCommander[]
        const cardsResult = await window.api.getCardsByIds(top.map((c) => c.id))
        if (cancelled) return
        if (isError(cardsResult)) {
          setError(cardsResult.details)
          return
        }
        setCards((cardsResult as { data: ScryfallCard[] }).data ?? [])
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      {loading && <p className="app__hint">Loading top commanders from EDHREC…</p>}
      {error && <p className="app__error">{error}</p>}
      {!loading && !error && <p className="app__hint">Top commanders on EDHREC (past 2 years)</p>}
      <div className="card-grid">
        {cards.map((card) => (
          <CardTile key={card.id} card={card} onSelect={onSelect} />
        ))}
      </div>
    </>
  )
}

interface Props {
  onSelect: (card: ScryfallCard) => void
  placeholder?: string
}

/** Search box + top-commanders browser. Shared by the Commander tab and "New Deck". */
export default function CommanderPicker({ onSelect, placeholder = 'Search for a commander…' }: Props) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const searchQuery = trimmed
    ? [...BASE_EXCLUSION_TERMS, EXCLUDE_TOKENS_TERM, 'is:commander', trimmed].join(' ')
    : ''

  return (
    <div>
      <div className="app__results-toolbar">
        <input
          className="app__search"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      {trimmed ? (
        <CardResults
          query={searchQuery}
          sort={{ order: 'name', dir: 'asc', label: '' }}
          emptyHint="No commanders found."
          onSelect={onSelect}
          rawText={trimmed}
        />
      ) : (
        <TopCommandersBrowser onSelect={onSelect} />
      )}
    </div>
  )
}
