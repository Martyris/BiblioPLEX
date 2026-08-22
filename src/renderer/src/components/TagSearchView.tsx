import { useEffect, useMemo, useState } from 'react'
import CardTile from './CardTile'
import CardContextMenu from './CardContextMenu'
import FilterPanel from './FilterPanel'
import TagAutocomplete from './TagAutocomplete'
import SortControl, { SORT_OPTIONS, type SortOption } from './SortControl'
import { cardMatchesFilters, EMPTY_FILTERS, type FilterState } from '../queryBuilder'
import type { ScryfallCard } from '../types'

interface Props {
  initialTags: string[]
  onBack: () => void
  onSelectCard: (card: ScryfallCard) => void
  // Right-click menu actions — "Add to Deck" reuses onSelectCard; omit Pool/Want to leave
  // them out of the menu (e.g. when this view isn't opened from within a deck).
  onAddToPool?: (card: ScryfallCard) => void
  onAddToWant?: (card: ScryfallCard) => void
  getMarker?: (card: ScryfallCard) => 'want' | 'pool' | undefined
  deckOracleIds?: Set<string>
  // The deck's (commander + partner) color identity — the bulk tag index spans every color of
  // card in Magic, so without this a deck's tag search would surface plenty of cards it could
  // never actually run. Omit to skip filtering (e.g. no commander picked yet).
  colorIdentity?: string[]
}

type IndexedCard = ScryfallCard & { tags: string[] }

interface IndexStatus {
  builtAt: string | null
  count: number
}

const DEFAULT_SORT = SORT_OPTIONS.find((o) => o.order === 'edhrec') ?? SORT_OPTIONS[0]

// Mirrors what SORT_OPTIONS' labels promise, but computed locally — results here come from
// our own bulk index, not a live Scryfall query, so there's no `order=` param to hand off to.
function compareCards(a: ScryfallCard, b: ScryfallCard, sort: SortOption): number {
  const dir = sort.dir === 'desc' ? -1 : 1
  switch (sort.order) {
    case 'name':
      return a.name.localeCompare(b.name) * dir
    case 'edhrec': {
      const ar = a.edhrec_rank ?? Number.MAX_SAFE_INTEGER
      const br = b.edhrec_rank ?? Number.MAX_SAFE_INTEGER
      return (ar - br) * dir
    }
    case 'released':
      return a.released_at.localeCompare(b.released_at) * dir
    case 'cmc':
      return (a.cmc - b.cmc) * dir
    case 'color': {
      const rank = (c: ScryfallCard): number => {
        const colors = c.colors ?? []
        if (colors.length === 0) return 6
        if (colors.length > 1) return 5
        return 'WUBRG'.indexOf(colors[0])
      }
      return (rank(a) - rank(b)) * dir
    }
    case 'rarity': {
      const order = ['common', 'uncommon', 'rare', 'mythic']
      return (order.indexOf(a.rarity) - order.indexOf(b.rarity)) * dir
    }
    case 'usd': {
      const ap = Number(a.prices?.usd ?? Infinity)
      const bp = Number(b.prices?.usd ?? Infinity)
      return (ap - bp) * dir
    }
    default:
      return 0
  }
}

export default function TagSearchView({
  initialTags,
  onBack,
  onSelectCard,
  onAddToPool,
  onAddToWant,
  getMarker,
  deckOracleIds,
  colorIdentity
}: Props) {
  const [tags, setTags] = useState<string[]>(initialTags)
  const [results, setResults] = useState<IndexedCard[]>([])
  const [searching, setSearching] = useState(false)
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ card: ScryfallCard; x: number; y: number } | null>(null)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT)
  const [availableTags, setAvailableTags] = useState<string[]>([])

  useEffect(() => {
    window.api.getCardTagIndexStatus().then(setIndexStatus)
  }, [])

  // Refetch whenever the index is (re)built, since a rebuild can add/remove tag values.
  useEffect(() => {
    if (!indexStatus?.builtAt) return
    window.api.getAllTagValues().then(setAvailableTags)
  }, [indexStatus?.builtAt])

  useEffect(() => {
    if (!indexStatus?.builtAt || tags.length === 0) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    window.api.searchCardsByTags(tags).then((res) => {
      if (cancelled) return
      setResults(res as IndexedCard[])
      setSearching(false)
    })
    return () => {
      cancelled = true
    }
  }, [tags, indexStatus?.builtAt])

  // Color identity (deck legality), the same structured filters as the main Search tab, and
  // sort — all applied locally, since these results come from our own index rather than a
  // live Scryfall query string.
  const filteredResults = useMemo(() => {
    const identitySet = colorIdentity ? new Set(colorIdentity) : null
    const filtered = results.filter((card) => {
      if (identitySet && !(card.color_identity ?? []).every((c) => identitySet.has(c))) return false
      return cardMatchesFilters(card, filters)
    })
    return [...filtered].sort((a, b) => compareCards(a, b, sort))
  }, [results, colorIdentity, filters, sort])

  function addTag(tag: string): void {
    if (tags.includes(tag)) return
    setTags((prev) => [...prev, tag])
  }

  function removeTag(tag: string): void {
    setTags((prev) => prev.filter((t) => t !== tag))
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

  async function handleBuildIndex(): Promise<void> {
    setBuilding(true)
    setBuildError(null)
    try {
      const status = await window.api.buildCardTagIndex()
      setIndexStatus(status)
    } catch (err) {
      console.error('[tag index] build failed:', err)
      setBuildError('Failed to build the index — check your connection and try again.')
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div className="app__results">
      <div className="app__results-toolbar">
        <button className="back-link" onClick={onBack}>
          ← Back to deck
        </button>
        <h2 className="set-detail__title">Search by Tag</h2>
        <SortControl value={sort} onChange={setSort} />
      </div>

      <div className="app__results-toolbar tag-search__index-row">
        {indexStatus?.builtAt ? (
          <p className="app__hint">
            Index built {new Date(indexStatus.builtAt).toLocaleString()} · {indexStatus.count.toLocaleString()} cards
          </p>
        ) : (
          <p className="app__hint">No card tag index yet — build one to search by tag.</p>
        )}
        <button className="back-link" onClick={handleBuildIndex} disabled={building}>
          {building ? 'Building…' : indexStatus?.builtAt ? 'Rebuild Index' : 'Build Card Tag Index'}
        </button>
      </div>
      {buildError && <p className="app__error">{buildError}</p>}
      {!indexStatus?.builtAt && (
        <p className="app__hint">
          This downloads and processes Scryfall's card database once — it can take a few minutes — and stays
          available until you rebuild it later for newer sets.
        </p>
      )}

      <ul className="tag-row card-tags__draft-row">
        {tags.map((tag) => (
          <li key={tag} className="tag-chip is-active card-tags__chip">
            {tag}
            <button
              type="button"
              className="card-tags__chip-remove"
              onClick={() => removeTag(tag)}
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <TagAutocomplete
        availableTags={availableTags}
        excludeTags={tags}
        onAdd={addTag}
        placeholder="Add another tag to narrow the search…"
      />

      <div className="tag-search__body">
        <aside className="app__sidebar">
          <FilterPanel filters={filters} onChange={setFilters} />
        </aside>
        <div className="tag-search__results">
          {searching && <p className="app__hint">Searching…</p>}
          {!searching && indexStatus?.builtAt && tags.length > 0 && filteredResults.length === 0 && (
            <p className="app__hint">No cards match all selected tags.</p>
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
