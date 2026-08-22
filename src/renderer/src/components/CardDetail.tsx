import { useEffect, useRef, useState } from 'react'
import { isError, type ScryfallCard, type ScryfallRuling, type ScryfallRulingsResult, type ScryfallSearchResult } from '../types'
import { pickPreferredPrinting } from '../printings'
import PrintingSelect from './PrintingSelect'
import CardTagsPanel from './CardTagsPanel'

export interface DeckMode {
  // Omit for a commander — it can't be removed from the deck, only re-printed.
  onRemove?: () => void
  // Only meaningful alongside onRemove — defaults to "Remove from Deck" for the actual deck
  // list; Card Pool/Want reuse the same component with their own wording.
  removeLabel?: string
  onPrintingChange: (newCard: ScryfallCard) => void
  // Whether *this specific slot* (not the card in general) is marked owned-in-foil. Omit
  // onToggleFoil to hide the toggle entirely (e.g. for a plain, non-deck card view).
  isFoil?: boolean
  onToggleFoil?: () => void
}

interface Props {
  card: ScryfallCard
  onClose: () => void
  deckMode?: DeckMode
}

const LEGALITY_ORDER = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper']
const FLIP_HALF_DURATION_MS = 150

function formatLegality(status: string): string {
  return status.replace('_', ' ')
}

export default function CardDetail({ card, onClose, deckMode }: Props) {
  const [printings, setPrintings] = useState<ScryfallCard[]>([card])
  const [activeId, setActiveId] = useState(card.id)
  const [loadingPrintings, setLoadingPrintings] = useState(false)
  const [faceIndex, setFaceIndex] = useState(0)
  const [isFlipping, setIsFlipping] = useState(false)
  const skipNextPrintingChange = useRef(true)

  useEffect(() => {
    let cancelled = false
    setPrintings([card])
    setActiveId(card.id)
    setLoadingPrintings(true)
    skipNextPrintingChange.current = true

    async function loadPrintings(): Promise<void> {
      try {
        const url = new URL(card.prints_search_uri)
        // Physical TCG only — never offer an Arena/MTGO-only printing in the switcher.
        url.searchParams.set('q', `${url.searchParams.get('q') ?? ''} game:paper`)
        url.searchParams.set('order', 'released')
        url.searchParams.set('dir', 'desc')

        // Basic lands can have 500+ printings, well past one page (175) — walk every page
        // so older full-art/promo prints (e.g. Hour of Devastation) actually show up in the
        // picker, not just the most recent ones. Non-basics have far fewer printings, so
        // this loop exits after one request for them same as before.
        let nextUrl: string | null = url.toString()
        let all: ScryfallCard[] = []
        while (nextUrl) {
          const result: unknown = await window.api.fetchScryfallUrl(nextUrl)
          if (cancelled || isError(result)) break
          const page = result as ScryfallSearchResult
          all = all.concat(page.data ?? [])
          setPrintings(all)
          nextUrl = page.has_more && page.next_page ? page.next_page : null
        }
        if (cancelled || all.length === 0) return

        // In deck mode, `card` IS the printing already in the deck — show that exact one
        // rather than auto-jumping to "latest normal art".
        if (!deckMode) {
          const preferred = pickPreferredPrinting(all)
          if (preferred) setActiveId(preferred.id)
        }
      } catch {
        // Network hiccup fetching alternate printings — keep showing the originally
        // selected card rather than blocking the whole detail view.
      } finally {
        if (!cancelled) setLoadingPrintings(false)
      }
    }

    loadPrintings()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card])

  // A different printing may be a different layout entirely — always land on the front face.
  useEffect(() => {
    setFaceIndex(0)
    setIsFlipping(false)
  }, [activeId])

  // Tell the deck builder whenever the user picks a different printing from the dropdown
  // (skip the very first render, which is just the initial card, not a user change).
  useEffect(() => {
    if (skipNextPrintingChange.current) {
      skipNextPrintingChange.current = false
      return
    }
    if (!deckMode) return
    const current = printings.find((p) => p.id === activeId)
    if (current) deckMode.onPrintingChange(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const active = printings.find((p) => p.id === activeId) ?? card
  const faces = active.card_faces
  // Only transform/MDFC-style cards have two independently-illustrated faces worth flipping
  // between — split/adventure cards share one image and shouldn't get a flip button.
  const isFlippable = faces?.length === 2 && Boolean(faces[0]?.image_uris) && Boolean(faces[1]?.image_uris)
  const currentFace = isFlippable ? faces[faceIndex] : faces?.[0]

  const image = currentFace?.image_uris?.large ?? active.image_uris?.large ?? active.image_uris?.normal
  const oracleText = active.oracle_text ?? currentFace?.oracle_text
  const manaCost = active.mana_cost ?? currentFace?.mana_cost
  const displayName = currentFace?.name ?? active.name
  const typeLine = currentFace?.type_line ?? active.type_line
  const power = currentFace?.power ?? active.power
  const toughness = currentFace?.toughness ?? active.toughness
  const loyalty = currentFace?.loyalty ?? active.loyalty
  const usdPrice = active.prices?.usd
  const usdFoilPrice = active.prices?.usd_foil

  const [rulings, setRulings] = useState<ScryfallRuling[] | null>(null)
  const [rulingsLoading, setRulingsLoading] = useState(false)
  const [rulingsError, setRulingsError] = useState<string | null>(null)
  const [showRulings, setShowRulings] = useState(false)

  // Rulings are tied to the oracle card, not the specific printing — reset only when the
  // underlying card actually changes, not on every printing swap.
  useEffect(() => {
    setRulings(null)
    setShowRulings(false)
    setRulingsError(null)
  }, [active.oracle_id])

  async function handleToggleRulings(): Promise<void> {
    if (rulings) {
      setShowRulings((s) => !s)
      return
    }
    setRulingsLoading(true)
    setRulingsError(null)
    const result = await window.api.fetchScryfallUrl(active.rulings_uri)
    if (isError(result)) {
      setRulingsError(result.details)
    } else {
      setRulings((result as ScryfallRulingsResult).data ?? [])
    }
    setRulingsLoading(false)
    setShowRulings(true)
  }

  function handleFlip(): void {
    if (!isFlippable || isFlipping) return
    setIsFlipping(true)
    window.setTimeout(() => {
      setFaceIndex((i) => (i === 0 ? 1 : 0))
      setIsFlipping(false)
    }, FLIP_HALF_DURATION_MS)
  }

  function handleRemove(): void {
    deckMode?.onRemove?.()
    onClose()
  }

  return (
    <div className="card-detail-overlay" onClick={onClose}>
      <div className="card-detail" onClick={(e) => e.stopPropagation()}>
        <button className="card-detail__close" onClick={onClose}>
          ×
        </button>
        <div className={`card-detail__image-wrap ${deckMode?.isFoil ? 'is-foil' : ''}`}>
          {image && (
            <img
              className={`card-detail__image ${isFlipping ? 'is-flipping' : ''}`}
              src={image}
              alt={displayName}
            />
          )}
          {isFlippable && (
            <button className="card-detail__flip" onClick={handleFlip} title="Flip card">
              ⟲ Flip
            </button>
          )}
          {deckMode?.onRemove && (
            <button className="card-detail__remove" onClick={handleRemove}>
              {deckMode.removeLabel ?? 'Remove from Deck'}
            </button>
          )}
        </div>
        <div className="card-detail__info">
          <h2>{displayName}</h2>
          <p className="card-detail__meta">
            {manaCost && <span>{manaCost}</span>} · {typeLine}
          </p>
          <p className="card-detail__meta">
            {active.set_name} #{active.collector_number} · {active.rarity}
          </p>
          {deckMode?.onToggleFoil && (
            <label className="card-detail__foil-toggle">
              <input type="checkbox" checked={Boolean(deckMode.isFoil)} onChange={deckMode.onToggleFoil} />
              ✨ Foil
            </label>
          )}
          {oracleText && <p className="card-detail__text">{oracleText}</p>}
          {(power || loyalty) && (
            <p className="card-detail__pt">
              {power && `${power}/${toughness}`}
              {loyalty && `Loyalty: ${loyalty}`}
            </p>
          )}

          <button
            className={`card-detail__rulings-toggle ${showRulings ? 'is-open' : ''}`}
            onClick={handleToggleRulings}
            disabled={rulingsLoading}
          >
            <span className="card-detail__rulings-toggle-chevron">▸</span>
            {rulingsLoading ? 'Loading Rulings…' : showRulings ? 'Hide Rulings' : 'Show Rulings'}
            {rulings && <span className="card-detail__rulings-count">{rulings.length}</span>}
          </button>
          {showRulings && rulingsError && <p className="app__error">Couldn't load rulings: {rulingsError}</p>}
          {showRulings && rulings && rulings.length === 0 && (
            <p className="app__hint">No official rulings for this card.</p>
          )}
          {showRulings && rulings && rulings.length > 0 && (
            <ul className="card-detail__rulings-list">
              {rulings.map((r, i) => (
                <li key={i}>
                  <span className="card-detail__ruling-date">{r.published_at}</span>
                  <p>{r.comment}</p>
                </li>
              ))}
            </ul>
          )}

          {printings.length > 1 && (
            <>
              <h3>Printing {loadingPrintings && '(loading…)'}</h3>
              <PrintingSelect printings={printings} activeId={activeId} onChange={setActiveId} />
            </>
          )}

          <CardTagsPanel card={active} />

          <h3>Legality</h3>
          <ul className="card-detail__legalities">
            {LEGALITY_ORDER.filter((f) => active.legalities[f]).map((format) => (
              <li key={format} className={`legality legality--${active.legalities[format]}`}>
                <span>{format}</span>
                <span>{formatLegality(active.legalities[format])}</span>
              </li>
            ))}
          </ul>

          <h3>Price (USD, via Scryfall)</h3>
          <p className="card-detail__price">
            {usdPrice ? `$${usdPrice}` : 'N/A'}
            {usdFoilPrice && ` · Foil: $${usdFoilPrice}`}
          </p>
          <p className="card-detail__note">BRL pricing (LigaMagic) not yet integrated.</p>

          <a href={active.scryfall_uri} target="_blank" rel="noreferrer" className="card-detail__link">
            View on Scryfall ↗
          </a>
        </div>
      </div>
    </div>
  )
}
