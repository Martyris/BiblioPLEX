import { useEffect, useState } from 'react'
import CardDetail from './components/CardDetail'
import FilterPanel from './components/FilterPanel'
import SortControl, { SORT_OPTIONS, type SortOption } from './components/SortControl'
import SetsBrowser from './components/SetsBrowser'
import CardResults from './components/CardResults'
import CommanderView from './components/CommanderView'
import CommanderPicker from './components/CommanderPicker'
import DecksBrowser from './components/DecksBrowser'
import DeckBuilder from './components/DeckBuilder'
import { BASE_EXCLUSION_TERMS, buildQuery, EMPTY_FILTERS, EXCLUDE_TOKENS_TERM, type FilterState } from './queryBuilder'
import type { ScryfallCard, ScryfallSet } from './types'

type Tab = 'search' | 'sets' | 'tokens' | 'commander' | 'decks'

interface SetsTabViewProps {
  mode: 'sets' | 'tokens'
  onSelectCard: (card: ScryfallCard) => void
}

function SetsTabView({ mode, onSelectCard }: SetsTabViewProps) {
  const [activeSet, setActiveSet] = useState<ScryfallSet | null>(null)
  const [sort, setSort] = useState<SortOption>(SORT_OPTIONS[0])

  if (!activeSet) {
    return (
      <div className="app__results app__results--full">
        <SetsBrowser mode={mode} onSelectSet={setActiveSet} />
      </div>
    )
  }

  const queryParts = [...BASE_EXCLUSION_TERMS]
  if (mode === 'sets') queryParts.push(EXCLUDE_TOKENS_TERM)
  queryParts.push(`e:${activeSet.code}`)

  return (
    <div className="app__results app__results--full">
      <div className="app__results-toolbar">
        <button className="back-link" onClick={() => setActiveSet(null)}>
          ← All {mode === 'tokens' ? 'token sets' : 'sets'}
        </button>
        <h2 className="set-detail__title">{activeSet.name}</h2>
        <SortControl value={sort} onChange={setSort} />
      </div>
      <CardResults
        query={queryParts.join(' ')}
        sort={sort}
        emptyHint="No cards found in this set."
        onSelect={onSelectCard}
      />
    </div>
  )
}

function CommanderTabView({ onSelectCard }: { onSelectCard: (card: ScryfallCard) => void }) {
  const [commander, setCommander] = useState<ScryfallCard | null>(null)

  if (commander) {
    return (
      <div className="app__results">
        <CommanderView commander={commander} onBack={() => setCommander(null)} onSelectCard={onSelectCard} />
      </div>
    )
  }

  return (
    <div className="app__results">
      <CommanderPicker onSelect={setCommander} />
    </div>
  )
}

function DecksTabView() {
  const [deckId, setDeckId] = useState<string | null>(null)

  if (deckId) {
    return <DeckBuilder deckId={deckId} onBack={() => setDeckId(null)} />
  }

  return <DecksBrowser onOpenDeck={setDeckId} />
}

export default function App() {
  const [tab, setTab] = useState<Tab>('search')
  const [selected, setSelected] = useState<ScryfallCard | null>(null)

  // Search tab state
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortOption>(SORT_OPTIONS[0])
  const searchQuery = buildQuery(query, filters)

  // Once per app launch — silently refreshes the bulk card tag index if it was built under
  // older tagging rules, so a fix like "fetch lands are Fixing, not Ramp" actually takes
  // effect without the user needing to remember "Rebuild Index". Never triggers a first-ever
  // build; that stays a deliberate user action.
  useEffect(() => {
    window.api.ensureCardTagIndexFresh()
  }, [])

  return (
    <div className="app">
      <header className="app__header">
        <h1>BiblioPLEX</h1>
        <nav className="app__tabs">
          <button className={tab === 'search' ? 'is-active' : ''} onClick={() => setTab('search')}>
            Search
          </button>
          <button className={tab === 'sets' ? 'is-active' : ''} onClick={() => setTab('sets')}>
            Sets
          </button>
          <button className={tab === 'tokens' ? 'is-active' : ''} onClick={() => setTab('tokens')}>
            Tokens
          </button>
          <button className={tab === 'commander' ? 'is-active' : ''} onClick={() => setTab('commander')}>
            Commander
          </button>
          <button className={tab === 'decks' ? 'is-active' : ''} onClick={() => setTab('decks')}>
            Decks
          </button>
        </nav>
        {tab === 'search' && (
          <input
            className="app__search"
            type="text"
            placeholder="Search cards (name, or use filters below)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}
      </header>

      <main className="app__body">
        {tab === 'search' && (
          <>
            <aside className="app__sidebar">
              <FilterPanel filters={filters} onChange={setFilters} />
            </aside>
            <div className="app__results">
              <div className="app__results-toolbar">
                <SortControl value={sort} onChange={setSort} />
              </div>
              <CardResults
                query={searchQuery}
                sort={sort}
                emptyHint="Start typing or set a filter to search the Scryfall database."
                onSelect={setSelected}
                rawText={query}
              />
            </div>
          </>
        )}

        {tab === 'sets' && <SetsTabView mode="sets" onSelectCard={setSelected} />}
        {tab === 'tokens' && <SetsTabView mode="tokens" onSelectCard={setSelected} />}
        {tab === 'commander' && <CommanderTabView onSelectCard={setSelected} />}
        {tab === 'decks' && <DecksTabView />}
      </main>

      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
