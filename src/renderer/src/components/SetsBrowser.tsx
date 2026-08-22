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

export default function SetsBrowser({ mode = 'sets', onSelectSet }: Props) {
  const [sets, setSets] = useState<ScryfallSet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sets
    return sets.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
  }, [sets, filter])

  return (
    <div className="sets-browser">
      <input
        className="app__search"
        type="text"
        placeholder="Filter sets by name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {loading && <p className="app__hint">Loading sets…</p>}
      {error && <p className="app__error">{error}</p>}
      {!loading && !error && (
        <ul className="set-list">
          {filtered.map((set) => (
            <li key={set.id}>
              <button className="set-list__item" onClick={() => onSelectSet(set)}>
                <img className="set-list__icon" src={set.icon_svg_uri} alt="" />
                <span className="set-list__name">{set.name}</span>
                <span className="set-list__meta">
                  {set.released_at ?? '—'} · {set.card_count} cards
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
