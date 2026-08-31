import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { isError, type ScryfallCard, type ScryfallSearchResult } from '../types'
import { BASE_EXCLUSION_TERMS } from '../queryBuilder'
import { snowNameFor } from '../deckLogic'

interface Props {
  // 'snow' lets the user click individual copies of this basic land (in the deck right now,
  // regular or already-snow) one at a time to flip each between the two — see onToggleInstance.
  // 'printing' picks ONE printing and applies it to every copy at once — see onApplyPrinting.
  mode: 'snow' | 'printing'
  name: string
  // Only meaningful for mode 'printing' — whether to fetch/apply printings of the plain name
  // or its Snow-Covered counterpart.
  printingTarget?: 'regular' | 'snow'
  deckCardIds: string[]
  cardsById: Record<string, ScryfallCard>
  onToggleInstance: (index: number) => void
  onApplyPrinting: (card: ScryfallCard) => void
  onClose: () => void
}

/** Opened from the pip on a Basic Lands stepper (see DeckBuilder's "Click color symbol to
 *  change land settings" hint) — the stepper itself only ever tracks copies matching its exact
 *  base name, so converting to/from Snow-Covered or bulk-changing art needed a real UI of its
 *  own rather than another +/- control. */
export default function BasicLandModal({
  mode,
  name,
  printingTarget,
  deckCardIds,
  cardsById,
  onToggleInstance,
  onApplyPrinting,
  onClose
}: Props) {
  const snowName = snowNameFor(name)
  const targetName = printingTarget === 'snow' ? snowName : name

  // A toggle round-trips through a full deck save (and the deck's tag/synergy data re-fetching
  // off the back of that) before the real props here catch up — clicking through several
  // copies in a row felt like each click was doing nothing for a beat. This overrides just the
  // clicked index's displayed name the instant it's clicked, then clears itself once the real
  // data reflects it, so the grid flips instantly regardless of how long the save takes.
  const [pendingOverrides, setPendingOverrides] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    if (pendingOverrides.size === 0) return
    setPendingOverrides((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [index, expectedName] of prev) {
        if (cardsById[deckCardIds[index]]?.name === expectedName) {
          next.delete(index)
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckCardIds, cardsById])

  const instances =
    mode === 'snow'
      ? deckCardIds
          .map((id, index) => {
            const card = cardsById[id]
            if (!card) return null
            const displayName = pendingOverrides.get(index) ?? card.name
            if (displayName !== name && displayName !== snowName) return null
            return { index, card, displayName }
          })
          .filter((entry): entry is { index: number; card: ScryfallCard; displayName: string } => entry !== null)
      : []
  const snowCount = instances.filter((i) => i.displayName === snowName).length

  function handleToggleInstance(index: number, currentDisplayName: string): void {
    setPendingOverrides((prev) => new Map(prev).set(index, currentDisplayName === name ? snowName : name))
    onToggleInstance(index)
  }

  const [printings, setPrintings] = useState<ScryfallCard[]>([])
  const [loadingPrintings, setLoadingPrintings] = useState(mode === 'printing')
  const [printingsError, setPrintingsError] = useState<string | null>(null)
  const [printingFilter, setPrintingFilter] = useState('')

  useEffect(() => {
    if (mode !== 'printing') return
    let cancelled = false
    setLoadingPrintings(true)
    setPrintingsError(null)

    async function load(): Promise<void> {
      const exclusion = BASE_EXCLUSION_TERMS.join(' ')
      let all: ScryfallCard[] = []
      let page = 1
      for (;;) {
        // unique:prints is required here — Scryfall's search API defaults to unique:cards,
        // which collapses every reprint down to just its one "preferred" printing (that's why
        // this was only ever showing a single result before).
        const result = await window.api.searchCards(`!"${targetName}" ${exclusion} unique:prints`, {
          order: 'released',
          dir: 'desc',
          page
        })
        if (cancelled) return
        if (isError(result)) {
          setPrintingsError(result.details)
          break
        }
        const r = result as ScryfallSearchResult
        all = all.concat(r.data ?? [])
        setPrintings(all)
        if (!r.has_more) break
        page++
      }
      if (!cancelled) setLoadingPrintings(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [mode, targetName])

  const filter = printingFilter.trim().toLowerCase()
  // Same filter fields as the per-card printing switcher in Card Inspect (set name, code, or
  // release year/date) — same idea here, just applied to every copy at once instead of one.
  const filteredPrintings = filter
    ? printings.filter(
        (p) => p.set_name.toLowerCase().includes(filter) || p.set.toLowerCase().includes(filter) || p.released_at.includes(filter)
      )
    : printings

  return createPortal(
    <div className="card-detail-overlay" onClick={onClose}>
      <div className="export-deck-modal basic-land-modal" onClick={(e) => e.stopPropagation()}>
        <button className="card-detail__close" onClick={onClose}>
          ×
        </button>

        {mode === 'snow' ? (
          <>
            <h3>Snow-Covered {name}</h3>
            <p className="app__hint">
              Click a copy to switch it between {name} and Snow-Covered {name} — {snowCount} of {instances.length} are
              currently Snow-Covered.
            </p>
            <div className="printing-select__grid basic-land-modal__grid">
              {instances.length === 0 && <p className="printing-select__grid-empty">No copies of {name} in this deck.</p>}
              {instances.map(({ index, card, displayName }) => {
                const isSnow = displayName === snowName
                const thumb = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small
                return (
                  <button
                    key={index}
                    className={`printing-select__grid-item basic-land-modal__instance ${isSnow ? 'is-snow' : ''}`}
                    title={displayName}
                    onClick={() => handleToggleInstance(index, displayName)}
                  >
                    {thumb && <img src={thumb} alt={card.name} loading="lazy" decoding="async" />}
                    <span className="basic-land-modal__instance-badge">{isSnow ? '❄ Snow' : name}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <h3>Change Printing — All {targetName}</h3>
            <p className="app__hint">Picking a printing here replaces every copy of {targetName} in this deck with it.</p>
            <input
              className="printing-select__filter"
              type="text"
              placeholder="Filter by set name, code, or year…"
              value={printingFilter}
              onChange={(e) => setPrintingFilter(e.target.value)}
              autoFocus
            />
            {loadingPrintings && <p className="app__hint">Loading printings…</p>}
            {printingsError && <p className="app__error">{printingsError}</p>}
            {!loadingPrintings && !printingsError && (
              <div className="printing-select__grid basic-land-modal__grid">
                {filteredPrintings.length === 0 && (
                  <p className="printing-select__grid-empty">No printings match "{printingFilter}".</p>
                )}
                {filteredPrintings.map((p) => (
                  <button
                    key={p.id}
                    className="printing-select__grid-item"
                    title={`${p.set_name} · #${p.collector_number} · ${p.released_at}`}
                    onClick={() => onApplyPrinting(p)}
                  >
                    {p.image_uris?.small && <img src={p.image_uris.small} alt="" loading="lazy" decoding="async" />}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
