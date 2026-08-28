import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ColorPips from './ColorPips'
import { isError, type ScryfallCard } from '../types'
import { colorIdentityGradient } from '../colorIdentityName'

interface PreconDeck {
  id: string
  name: string
  setCode: string
  setHeader: string
  releasedAt: string | null
  commanderId: string
  commanderName: string
  partnerCommanderId: string | null
  partnerCommanderName: string | null
  cardIds: string[]
}

interface PreconStatus {
  builtAt: string | null
  count: number
  skippedCount: number
  stale: boolean
}

interface PreconBuildProgress {
  phase: 'idle' | 'catalog' | 'decks' | 'resolving' | 'done'
  current: number
  total: number
}

interface Props {
  onOpenPrecon: (preconId: string) => void
}

const SIMPLIFIED_VIEW_KEY = 'mtgplatform.preconsSimplifiedView'

// Precon commander/partner card data (color pips + cover art) — module-level so it survives
// switching away from and back to this tab within the same app session, instead of re-fetching
// the exact same ~160-precon-library's worth of Scryfall data (via the rate-limited /cards/
// collection endpoint) on every single mount. The precon library itself only changes via an
// explicit "Build"/"Check for New Precons" action, so this never goes stale mid-session.
const preconCommanderCache = new Map<string, ScryfallCard>()

const PHASE_LABELS: Record<PreconBuildProgress['phase'], string> = {
  idle: 'Starting…',
  catalog: 'Fetching the precon catalog…',
  decks: 'Fetching each precon’s decklist…',
  resolving: 'Resolving exact printings…',
  done: 'Finishing up…'
}

export default function PreconsBrowser({ onOpenPrecon }: Props) {
  const [precons, setPrecons] = useState<PreconDeck[]>([])
  // Seeded from whatever's already cached (e.g. from an earlier visit this session) so a repeat
  // visit paints with pips/art immediately, not just after refresh()'s fetch resolves.
  const [commanders, setCommanders] = useState<Record<string, ScryfallCard>>(() => Object.fromEntries(preconCommanderCache))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PreconStatus | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [buildProgress, setBuildProgress] = useState<PreconBuildProgress | null>(null)
  const [simplified, setSimplified] = useState(() => localStorage.getItem(SIMPLIFIED_VIEW_KEY) === '1')
  const [deckMenu, setDeckMenu] = useState<{ preconId: string; right: number; top?: number; bottom?: number } | null>(
    null
  )
  const [exportModal, setExportModal] = useState<{ deckName: string; text: string } | null>(null)
  const [exportCopied, setExportCopied] = useState(false)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null)
  const buildPollRef = useRef<number | null>(null)

  // Same pure display filter as DecksBrowser — never touches `precons` or persists anything.
  // Precons have no bracket/core-mechanic fields, so this only covers name and color identity.
  const [filterName, setFilterName] = useState('')
  const [filterColors, setFilterColors] = useState<string[]>([])
  const [filterColorMode, setFilterColorMode] = useState<'atLeast' | 'exactly'>('atLeast')

  function toggleSimplified(): void {
    setSimplified((prev) => {
      const next = !prev
      localStorage.setItem(SIMPLIFIED_VIEW_KEY, next ? '1' : '0')
      return next
    })
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const s = (await window.api.getPreconStatus()) as PreconStatus
      setStatus(s)
      if (!s.builtAt) {
        setPrecons([])
        return
      }
      const list = (await window.api.listPrecons()) as PreconDeck[]
      const sorted = [...list].sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))
      setPrecons(sorted)

      const commanderIds = [
        ...new Set(sorted.flatMap((d) => [d.commanderId, d.partnerCommanderId].filter((id): id is string => Boolean(id))))
      ]
      // Only fetch what a previous visit this session didn't already resolve — see
      // preconCommanderCache's own comment for why this is safe to trust across mounts.
      const uncachedIds = commanderIds.filter((id) => !preconCommanderCache.has(id))
      if (uncachedIds.length > 0) {
        const cardsResult = await window.api.getCardsByIds(uncachedIds)
        if (!isError(cardsResult)) {
          const cards = (cardsResult as { data: ScryfallCard[] }).data ?? []
          for (const card of cards) preconCommanderCache.set(card.id, card)
        }
      }
      setCommanders(Object.fromEntries(commanderIds.map((id) => [id, preconCommanderCache.get(id)]).filter(([, c]) => c) as [string, ScryfallCard][]))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    if (!deckMenu) return
    function handleScroll(): void {
      setDeckMenu(null)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [deckMenu])

  async function handleBuild(): Promise<void> {
    setBuilding(true)
    setBuildError(null)
    setBuildProgress({ phase: 'catalog', current: 0, total: 0 })
    buildPollRef.current = window.setInterval(async () => {
      const p = (await window.api.getPreconBuildProgress()) as PreconBuildProgress
      setBuildProgress(p)
    }, 1000)
    try {
      const s = (await window.api.buildPreconLibrary()) as PreconStatus
      setStatus(s)
      await refresh()
    } catch (err) {
      console.error('[precons] build failed:', err)
      setBuildError('Failed to build the precon library — check your connection and try again.')
    } finally {
      if (buildPollRef.current !== null) window.clearInterval(buildPollRef.current)
      buildPollRef.current = null
      setBuilding(false)
      setBuildProgress(null)
    }
  }

  async function handleCopyToMyDecks(precon: PreconDeck): Promise<void> {
    setDeckMenu(null)
    setCopyingId(precon.id)
    try {
      await window.api.copyPreconToMyDecks(precon.id)
      setCopiedNotice(`"${precon.name}" copied to My Decks.`)
      window.setTimeout(() => setCopiedNotice(null), 3000)
    } finally {
      setCopyingId(null)
    }
  }

  // Same simplified-list export as My Decks' Export Deck — count + name per line, commander
  // first, no set/collector info.
  async function handleExport(precon: PreconDeck): Promise<void> {
    setDeckMenu(null)
    const allIds = [
      precon.commanderId,
      ...(precon.partnerCommanderId ? [precon.partnerCommanderId] : []),
      ...precon.cardIds
    ]
    const result = await window.api.getCardsByIds([...new Set(allIds)])
    if (isError(result)) {
      window.alert(`Could not load card data to export: ${result.details}`)
      return
    }
    const cardsById = new Map((result as { data: ScryfallCard[] }).data.map((c) => [c.id, c]))

    const nameCounts = new Map<string, number>()
    for (const id of precon.cardIds) {
      const name = cardsById.get(id)?.name ?? '(unknown card)'
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
    const mainLines = [...nameCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${count} ${name}`)

    const commanderLines = [`1 ${precon.commanderName}`]
    if (precon.partnerCommanderId && precon.partnerCommanderName) commanderLines.push(`1 ${precon.partnerCommanderName}`)

    const content = [...commanderLines, '', ...mainLines].join('\n')
    setExportCopied(false)
    setExportModal({ deckName: precon.name, text: content })
  }

  async function copyExportText(): Promise<void> {
    if (!exportModal) return
    await navigator.clipboard.writeText(exportModal.text)
    setExportCopied(true)
    window.setTimeout(() => setExportCopied(false), 1500)
  }

  const preconsWithIdentity = useMemo(() => {
    return precons.map((precon) => {
      const commander = commanders[precon.commanderId]
      const partner = precon.partnerCommanderId ? commanders[precon.partnerCommanderId] : undefined
      const colorIdentity = [
        ...new Set([...(commander?.color_identity ?? []), ...(partner?.color_identity ?? [])])
      ]
      return { precon, commander, partner, colorIdentity }
    })
  }, [precons, commanders])

  const filtersActive = filterName.trim() !== '' || filterColors.length > 0

  function clearFilters(): void {
    setFilterName('')
    setFilterColors([])
    setFilterColorMode('atLeast')
  }

  function toggleFilterColor(code: string): void {
    setFilterColors((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))
  }

  const visiblePrecons = useMemo(() => {
    return preconsWithIdentity.filter(({ precon, colorIdentity }) => {
      if (filterName.trim() && !precon.name.toLowerCase().includes(filterName.trim().toLowerCase())) return false

      if (filterColors.length > 0) {
        const identitySet = new Set(colorIdentity)
        if (filterColorMode === 'exactly') {
          if (identitySet.size !== filterColors.length || !filterColors.every((c) => identitySet.has(c))) return false
        } else if (!filterColors.every((c) => identitySet.has(c))) {
          return false
        }
      }

      return true
    })
  }, [preconsWithIdentity, filterName, filterColors, filterColorMode])

  return (
    <div className="app__results">
      <div className="app__results-toolbar">
        <h2 className="set-detail__title">Precons</h2>
        {status?.builtAt && (
          <button className="secondary-button" onClick={toggleSimplified}>
            {simplified ? 'Show Art' : 'Simplified View'}
          </button>
        )}
        <button className="back-link" onClick={handleBuild} disabled={building}>
          {building
            ? 'Building…'
            : status?.builtAt
              ? 'Check for New Precons'
              : 'Build Precon Library'}
        </button>
      </div>

      {status?.builtAt && (
        <p className="app__hint">
          Built {new Date(status.builtAt).toLocaleString()} · {status.count.toLocaleString()} precons
          {status.skippedCount > 0 ? ` · ${status.skippedCount} skipped (couldn't be resolved)` : ''}
        </p>
      )}
      {building && buildProgress && (
        <p className="app__hint">
          {PHASE_LABELS[buildProgress.phase]}
          {buildProgress.total > 0 ? ` (${buildProgress.current}/${buildProgress.total})` : ''}
        </p>
      )}
      {buildError && <p className="app__error">{buildError}</p>}
      {copiedNotice && <p className="app__hint">{copiedNotice}</p>}
      {!status?.builtAt && !building && (
        <p className="app__hint">
          No precon library yet. Building pulls every Commander precon's exact decklist from EDHREC — it can take
          several minutes the first time. After that, "Check for New Precons" only fetches precons that aren't
          already saved, so it's much faster.
        </p>
      )}

      {loading && <p className="app__hint">Loading precons…</p>}
      {error && <p className="app__error">{error}</p>}
      {!loading && !error && status?.builtAt && precons.length === 0 && (
        <p className="app__hint">No precons resolved. Try rebuilding.</p>
      )}

      {!loading && !error && precons.length > 0 && (
        <div className="deck-filter-bar">
          <div className="filter-group">
            <span className="filter-group__label">Name</span>
            <input
              type="text"
              className="filter-text"
              placeholder="Search precons…"
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
            />
          </div>

          <div className="filter-group">
            <div className="filter-chip-row">
              {['W', 'U', 'B', 'R', 'G'].map((code) => (
                <button
                  key={code}
                  className={`filter-chip filter-chip--${code} ${filterColors.includes(code) ? 'is-active' : ''}`}
                  onClick={() => toggleFilterColor(code)}
                >
                  {code}
                </button>
              ))}
            </div>
            <select
              className="filter-select filter-select--compact"
              value={filterColorMode}
              onChange={(e) => setFilterColorMode(e.target.value as 'atLeast' | 'exactly')}
            >
              <option value="atLeast">Includes colors</option>
              <option value="exactly">Exact combination</option>
            </select>
          </div>

          {filtersActive && (
            <button className="filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {!loading && !error && precons.length > 0 && visiblePrecons.length === 0 && (
        <p className="app__hint">No precons match your filters.</p>
      )}

      <div className="deck-list">
        {visiblePrecons.map(({ precon, commander, partner, colorIdentity }) => {
          return (
            <button
              key={precon.id}
              className={`deck-card ${simplified ? 'deck-card--simplified' : ''}`}
              onClick={() => onOpenPrecon(precon.id)}
            >
              {commander?.image_uris?.art_crop && (
                <span
                  className="deck-card__art-bg"
                  style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
                />
              )}
              <span className="deck-card__accent" style={{ background: colorIdentityGradient(colorIdentity) }} />
              <span
                className="deck-card__menu-trigger"
                onClick={(e) => {
                  e.stopPropagation()
                  if (deckMenu?.preconId === precon.id) {
                    setDeckMenu(null)
                    return
                  }
                  const rect = e.currentTarget.getBoundingClientRect()
                  const right = window.innerWidth - rect.right
                  const MENU_HEIGHT_ESTIMATE = 110
                  if (window.innerHeight - rect.bottom < MENU_HEIGHT_ESTIMATE) {
                    setDeckMenu({ preconId: precon.id, right, bottom: window.innerHeight - rect.top + 4 })
                  } else {
                    setDeckMenu({ preconId: precon.id, right, top: rect.bottom + 4 })
                  }
                }}
                title="Precon options"
              >
                ⋮
              </span>
              {deckMenu?.preconId === precon.id &&
                createPortal(
                  <>
                    <div
                      className="tag-menu-backdrop"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeckMenu(null)
                      }}
                    />
                    <div
                      className="tag-menu"
                      style={{
                        right: deckMenu.right,
                        ...(deckMenu.top !== undefined ? { top: deckMenu.top } : { bottom: deckMenu.bottom })
                      }}
                    >
                      <button
                        disabled={copyingId === precon.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleCopyToMyDecks(precon)
                        }}
                      >
                        {copyingId === precon.id ? 'Copying…' : 'Copy to My Decks'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleExport(precon)
                        }}
                      >
                        Export
                      </button>
                    </div>
                  </>,
                  document.body
                )}

              <div className="deck-card__content">
                {!simplified && commander?.image_uris?.small && (
                  <div className="deck-card__image-stack">
                    {partner?.image_uris?.small && (
                      <img
                        className="deck-card__image deck-card__image--behind"
                        src={partner.image_uris.small}
                        alt={partner.name}
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    <img
                      className="deck-card__image deck-card__image--front"
                      src={commander.image_uris.small}
                      alt={precon.commanderName}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                )}

                <div className="deck-card__body">
                  <div className="deck-card__name">{precon.name}</div>
                  {commander && <ColorPips colors={colorIdentity} size={16} showName />}
                  <div className="deck-card__meta-row">
                    <span>
                      {precon.commanderName}
                      {precon.partnerCommanderName ? ` + ${precon.partnerCommanderName}` : ''}
                    </span>
                    <span className="deck-card__dot">·</span>
                    <span>{precon.setHeader}</span>
                  </div>
                </div>

                <div className="deck-card__stats">
                  <div className="deck-card__stat deck-card__stat--record">
                    <span className="deck-card__stat-value deck-card__stat-value--muted">
                      {precon.releasedAt ? new Date(precon.releasedAt).getFullYear() : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {exportModal && (
        <div className="card-detail-overlay" onClick={() => setExportModal(null)}>
          <div className="export-deck-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={() => setExportModal(null)}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Export — {exportModal.deckName}
            </h3>
            <p className="app__hint">Edit if needed, then copy and paste into another site's import box.</p>
            <textarea
              className="export-deck-modal__textarea"
              value={exportModal.text}
              onChange={(e) => setExportModal({ ...exportModal, text: e.target.value })}
              spellCheck={false}
            />
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={() => setExportModal(null)}>
                Close
              </button>
              <button className="primary-button" onClick={copyExportText}>
                {exportCopied ? '✓ Copied!' : 'Copy Text'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
