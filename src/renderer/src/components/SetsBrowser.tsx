import { useEffect, useMemo, useState } from 'react'
import type { ScryfallSet, ScryfallSetList } from '../types'
import { isError } from '../types'

interface Props {
  mode?: 'sets' | 'tokens'
  onSelectSet: (set: ScryfallSet) => void
}

// Scryfall has no distinct set_type for Art Series or Front Cards — both are filed under
// the mixed-bag "memorabilia" set_type alongside unrelated things (Scene Boxes, etc). Every
// such set Wizards has released is named "<Product> Art Series" / "<Product> Front Cards",
// so that's the reliable, cheap signal (checking card layouts per-set would mean one API
// call per set).
function isHiddenMemorabiliaSet(set: ScryfallSet): boolean {
  return set.set_type === 'memorabilia' && /(art series|front cards)/i.test(set.name)
}

// A curated palette for the set_types that actually show up once digital/funny/token/hidden-
// memorabilia sets are excluded — kept deliberate rather than hashed, so the common cases
// (expansion, core, commander) read as consistent choices instead of arbitrary ones. Anything
// not listed (a new set_type Scryfall introduces later, or a rare one like "vanguard") falls
// back to a hashed hue rather than going unstyled.
const SET_TYPE_COLORS: Record<string, string> = {
  expansion: '#7ee787',
  core: '#4fd8c4',
  commander: '#e6c229',
  masters: '#b388ff',
  draft_innovation: '#f0824f',
  starter: '#9fb8d9',
  box: '#c9a876',
  premium_deck: '#e08fd0',
  duel_deck: '#e08fd0',
  from_the_vault: '#e08fd0',
  spellbook: '#e08fd0',
  arsenal: '#f0824f',
  planechase: '#5fb8e0',
  archenemy: '#5fb8e0',
  vanguard: '#5fb8e0',
  treasure_chest: '#c9a876',
  minigame: '#8b95a8',
  memorabilia: '#8b95a8',
  promo: '#8b95a8'
}

function hashHue(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  return h
}

function setTypeColor(setType: string): string {
  return SET_TYPE_COLORS[setType] ?? `hsl(${hashHue(setType)}, 55%, 65%)`
}

function setTypeLabel(setType: string): string {
  return setType
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

export default function SetsBrowser({ mode = 'sets', onSelectSet }: Props) {
  const [sets, setSets] = useState<ScryfallSet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filterType, setFilterType] = useState('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFilterType('all')
    window.api
      .getSets()
      .then((result: unknown) => {
        if (cancelled) return
        if (isError(result)) {
          setError(result.details)
          return
        }
        const list = result as ScryfallSetList
        // Physical TCG only — hide Arena/MTGO-only sets (Alchemy sets, Arena Cube, etc) and
        // joke/playtest sets (Unglued, Unfinity, Heroes of the Realm, Unknown Event, etc).
        // Token sets live in their own tab, and Art Series / Front Cards sets are hidden
        // entirely.
        const paperOnly = list.data.filter(
          (s) =>
            !s.digital &&
            s.set_type !== 'funny' &&
            !isHiddenMemorabiliaSet(s) &&
            (mode === 'tokens' ? s.set_type === 'token' : s.set_type !== 'token')
        )
        const sorted = paperOnly.sort((a, b) => ((a.released_at ?? '') < (b.released_at ?? '') ? 1 : -1))
        setSets(sorted)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [mode])

  // Built from whatever set_types are actually present in this mode's data, rather than a
  // hardcoded list — Tokens mode only ever has one type, Sets mode has a couple dozen.
  const availableTypes = useMemo(() => {
    const types = new Set(sets.map((s) => s.set_type))
    return [...types].sort((a, b) => setTypeLabel(a).localeCompare(setTypeLabel(b)))
  }, [sets])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return sets.filter((s) => {
      if (filterType !== 'all' && s.set_type !== filterType) return false
      if (q && !s.name.toLowerCase().includes(q) && !s.code.toLowerCase().includes(q)) return false
      return true
    })
  }, [sets, filter, filterType])

  // Sets are already sorted newest-first, so grouping by year on top of that is just carving
  // the existing order into sections — never a re-sort of its own.
  const groups = useMemo(() => {
    const byYear = new Map<string, ScryfallSet[]>()
    for (const s of filtered) {
      const year = s.released_at ? s.released_at.slice(0, 4) : 'Unknown'
      const list = byYear.get(year)
      if (list) list.push(s)
      else byYear.set(year, [s])
    }
    return [...byYear.entries()]
  }, [filtered])

  return (
    <div className="sets-browser">
      <div className="sets-browser__controls">
        <input
          className="app__search"
          type="text"
          placeholder="Filter sets by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {availableTypes.length > 1 && (
          <div className="filter-chip-row sets-browser__type-row">
            <button
              className={`filter-chip filter-chip--text ${filterType === 'all' ? 'is-active' : ''}`}
              onClick={() => setFilterType('all')}
            >
              All
            </button>
            {availableTypes.map((t) => (
              <button
                key={t}
                className={`filter-chip filter-chip--text ${filterType === t ? 'is-active' : ''}`}
                style={filterType === t ? { borderColor: setTypeColor(t), color: setTypeColor(t) } : undefined}
                onClick={() => setFilterType(t)}
              >
                {setTypeLabel(t)}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <p className="app__hint">Loading sets…</p>}
      {error && <p className="app__error">{error}</p>}
      {!loading && !error && filtered.length === 0 && <p className="app__hint">No sets match your filters.</p>}

      {!loading &&
        !error &&
        groups.map(([year, yearSets]) => (
          <section key={year} className="set-year-group">
            <h3 className="set-year-group__heading">
              {year} <span className="set-year-group__count">({yearSets.length})</span>
            </h3>
            <div className="set-grid">
              {yearSets.map((set) => (
                <button key={set.id} className="set-tile" onClick={() => onSelectSet(set)}>
                  <span
                    className="set-tile__icon-badge"
                    style={{ background: `color-mix(in srgb, ${setTypeColor(set.set_type)} 22%, var(--panel))` }}
                  >
                    <img className="set-tile__icon" src={set.icon_svg_uri} alt="" loading="lazy" decoding="async" />
                  </span>
                  <span className="set-tile__body">
                    <span className="set-tile__name">{set.name}</span>
                    <span className="set-tile__meta">
                      {set.code.toUpperCase()} · {set.released_at ?? '—'} · {set.card_count} cards
                    </span>
                    <span
                      className="set-tile__type-pill"
                      style={{
                        color: setTypeColor(set.set_type),
                        background: `color-mix(in srgb, ${setTypeColor(set.set_type)} 16%, transparent)`
                      }}
                    >
                      {setTypeLabel(set.set_type)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  )
}
