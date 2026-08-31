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
import PreconsBrowser from './components/PreconsBrowser'
import PreconDeckView from './components/PreconDeckView'
import PlaytestTabView from './components/PlaytestTabView'
import AccountPanel from './components/AccountPanel'
import HomeView from './components/HomeView'
import Logo from './components/Logo'
import SplashScreen from './components/SplashScreen'
import IndexBuildStatusBar from './components/IndexBuildStatusBar'
import WindowControls from './components/WindowControls'
import LanguagePicker from './components/LanguagePicker'
import { attachGlobalButtonSounds } from './clickSound'
import { onAccountChanged } from './accountEvents'
import { t, useLocale, getLocale } from './i18n'
import {
  BASE_EXCLUSION_TERMS,
  buildFilterTerms,
  buildQuery,
  EMPTY_FILTERS,
  EXCLUDE_TOKENS_TERM,
  type FilterState
} from './queryBuilder'
import type { ScryfallCard, ScryfallSet } from './types'
import { setComboHeavyOracleIds } from './cardTagging'

type Tab = 'home' | 'search' | 'sets' | 'tokens' | 'commander' | 'precons' | 'decks' | 'playtest'

interface SetsTabViewProps {
  mode: 'sets' | 'tokens'
  onSelectCard: (card: ScryfallCard) => void
}

function SetsTabView({ mode, onSelectCard }: SetsTabViewProps) {
  const [activeSet, setActiveSet] = useState<ScryfallSet | null>(null)
  const [sort, setSort] = useState<SortOption>(SORT_OPTIONS[0])
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)

  if (!activeSet) {
    return (
      <div className="app__results">
        <SetsBrowser mode={mode} onSelectSet={setActiveSet} />
      </div>
    )
  }

  const queryParts = [...BASE_EXCLUSION_TERMS]
  if (mode === 'sets') queryParts.push(EXCLUDE_TOKENS_TERM)
  queryParts.push(`e:${activeSet.code}`)
  queryParts.push(...buildFilterTerms(filters))

  return (
    <div className="app__body">
      <aside className="app__sidebar">
        <FilterPanel filters={filters} onChange={setFilters} />
      </aside>
      <div className="app__results">
        <div className="app__results-toolbar">
          <button
            className="back-link"
            onClick={() => {
              setActiveSet(null)
              setFilters(EMPTY_FILTERS)
            }}
          >
            ← All {mode === 'tokens' ? 'token sets' : 'sets'}
          </button>
          <h2 className="set-detail__title">{activeSet.name}</h2>
          <SortControl value={sort} onChange={setSort} />
        </div>
        <CardResults
          query={queryParts.join(' ')}
          sort={sort}
          emptyHint="No cards match your filters in this set."
          onSelect={onSelectCard}
        />
      </div>
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

function PreconsTabView({ onTypeSearch }: { onTypeSearch: (term: string) => void }) {
  const [preconId, setPreconId] = useState<string | null>(null)

  if (preconId) {
    return <PreconDeckView preconId={preconId} onBack={() => setPreconId(null)} onTypeSearch={onTypeSearch} />
  }

  return <PreconsBrowser onOpenPrecon={setPreconId} />
}

export default function App() {
  useLocale()
  const [tab, setTab] = useState<Tab>('home')
  const [selected, setSelected] = useState<ScryfallCard | null>(null)

  // The header logo (and the splash screen, on its way out) show the student's chosen school's
  // colors — kept live via onAccountChanged (same pattern HomeView uses) so switching schools
  // updates it immediately rather than only after a reload.
  const [school, setSchool] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    function loadSchool(): void {
      window.api.getCurrentAccount().then((a) => {
        if (!cancelled) setSchool((a as { school: string | null } | null)?.school ?? null)
      })
    }
    loadSchool()
    return onAccountChanged(loadSchool)
  }, [])

  // Search tab state
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortOption>(SORT_OPTIONS[0])
  const searchQuery = buildQuery(query, filters)

  function handleHomeSearch(text: string): void {
    setQuery(text)
    setTab('search')
  }

  // Clicking a type/subtype word in a card's inspect view (CardDetail's onTypeClick) jumps to
  // the Search tab with a query for other cards sharing it — same destination/behavior as the
  // Home tab's search box, just triggered from inside the inspect overlay instead.
  function handleTypeSearch(term: string): void {
    setSelected(null)
    setQuery(`t:"${term}"`)
    setFilters(EMPTY_FILTERS)
    setTab('search')
  }

  // Once per app launch — silently refreshes the bulk card tag index if it was built under
  // older tagging rules, so a fix like "fetch lands are Fixing, not Ramp" actually takes
  // effect without the user needing to remember "Rebuild Index". Never triggers a first-ever
  // build; that stays a deliberate user action.
  useEffect(() => {
    window.api.ensureCardTagIndexFresh()
  }, [])

  // Populates the "Combo" tag's live per-card lookup (see cardTagging.ts) — the bulk card tag
  // index gets this baked in at build time, but a single card viewed outside that index (a
  // fresh search result, a card in a deck before its next index rebuild) needs the same set
  // loaded client-side to show the tag at all.
  useEffect(() => {
    window.api.getComboHeavyOracleIds().then(setComboHeavyOracleIds)
  }, [])

  // The same press/release cue as the Home logo, wired onto every button app-wide from one
  // place — see attachGlobalButtonSounds' own comment for why this beats hand-adding pointer
  // handlers per component.
  useEffect(() => attachGlobalButtonSounds(), [])

  // The main process's locale mirror (localePreference.ts) starts back at its 'en' default on
  // every launch — this pushes the persisted renderer preference over once so a saved pt-BR
  // choice keeps localizing card art immediately, not just after the next language switch.
  useEffect(() => {
    window.api.setAppLocale(getLocale())
  }, [])

  // The Playtest engine's one-time card-database scan (~10-70s depending on whether its H2 db
  // already exists from a prior launch) used to only start once the user actually opened the
  // Playtest tab — fine for the engine itself (idempotent, safe to call again), but it meant
  // Playtest always felt slow the first time regardless of how long the user had already been
  // using the rest of the app. Kicking this off at launch instead, behind a splash screen, means
  // by the time anyone actually reaches Playtest the warm-up is usually already done.
  const [engineReady, setEngineReady] = useState(false)
  const [splashFadingOut, setSplashFadingOut] = useState(false)
  useEffect(() => {
    window.api.warmUpGameSim()
    const poll = window.setInterval(async () => {
      const status = await window.api.getGameSimStatus()
      // A failed engine (e.g. no local JDK) shouldn't trap the user behind the splash forever —
      // only Playtest actually needs it; everything else works fine without it. Playtest's own
      // tab already surfaces the failure via its own status polling.
      if (status.phase === 'ready' || status.phase === 'error') {
        window.clearInterval(poll)
        setSplashFadingOut(true)
        window.setTimeout(() => setEngineReady(true), 350)
      }
    }, 300)
    return () => window.clearInterval(poll)
  }, [])

  if (!engineReady) {
    return <SplashScreen fadingOut={splashFadingOut} school={school} />
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <Logo size={26} school={school} className="app__brand-logo" />
          <h1>BiblioPLEX</h1>
        </div>
        <nav className="app__tabs">
          <button className={tab === 'home' ? 'is-active' : ''} onClick={() => setTab('home')}>
            {t('nav.home')}
          </button>
          <button className={tab === 'search' ? 'is-active' : ''} onClick={() => setTab('search')}>
            {t('nav.search')}
          </button>
          <button className={tab === 'sets' ? 'is-active' : ''} onClick={() => setTab('sets')}>
            {t('nav.sets')}
          </button>
          <button className={tab === 'tokens' ? 'is-active' : ''} onClick={() => setTab('tokens')}>
            {t('nav.tokens')}
          </button>
          <button className={tab === 'commander' ? 'is-active' : ''} onClick={() => setTab('commander')}>
            {t('nav.commander')}
          </button>
          <button className={tab === 'precons' ? 'is-active' : ''} onClick={() => setTab('precons')}>
            {t('nav.precons')}
          </button>
          <button className={tab === 'decks' ? 'is-active' : ''} onClick={() => setTab('decks')}>
            {t('nav.decks')}
          </button>
          <button className={tab === 'playtest' ? 'is-active' : ''} onClick={() => setTab('playtest')}>
            {t('nav.playtest')}
          </button>
        </nav>
        {tab === 'search' && (
          <input
            className="app__search"
            type="text"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}
        <div className="app__header-right">
          {/* Hidden for now — LanguagePicker stays wired up (i18n still active), just not shown. */}
          <AccountPanel />
          <WindowControls />
        </div>
      </header>

      <main className="app__body">
        {tab === 'home' && (
          <div className="app__results app__results--home">
            <HomeView onNavigate={setTab} onSearch={handleHomeSearch} />
          </div>
        )}
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
        {tab === 'precons' && <PreconsTabView onTypeSearch={handleTypeSearch} />}
        {tab === 'decks' && <DecksTabView />}
        {tab === 'playtest' && <PlaytestTabView />}
      </main>

      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} onTypeClick={handleTypeSearch} />}
      <IndexBuildStatusBar />
    </div>
  )
}
