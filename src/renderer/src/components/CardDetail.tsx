import { useEffect, useRef, useState } from 'react'
import { isError, type ScryfallCard, type ScryfallRuling, type ScryfallRulingsResult, type ScryfallSearchResult } from '../types'
import { pickPreferredPrinting } from '../printings'
import PrintingSelect from './PrintingSelect'
import CardTagsPanel from './CardTagsPanel'
import { getLocale } from '../i18n'

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
  // This deck's own tag additions for this exact card (see StoredDeck.userCardTags) — omit all
  // three together outside deck-editing contexts (Search, Sets, Commander, Precons, Playtest),
  // where there's no specific deck to scope a tag addition to.
  userTags?: string[]
  onAddUserTag?: (tag: string) => void
  onRemoveUserTag?: (tag: string) => void
}

interface Props {
  card: ScryfallCard
  onClose: () => void
  deckMode?: DeckMode
  // Read-only spectator contexts (Playtest inspecting a live-game card) don't want deck-editing
  // or collection-management chrome — printing switcher, functional tags, legality, and price
  // are all about *this card in your collection/deck*, which doesn't apply to just glancing at
  // a card mid-game. Keeps CardDetail as the one shared card-viewer instead of forking a second
  // near-identical component.
  minimal?: boolean
  // Playtest-only: when inspecting a battlefield permanent that has Equipment/Auras attached,
  // the actual attached cards — shown as clickable thumbnails so "what's equipped to this" is
  // immediately visible without leaving the inspect view, rather than a separate floating panel
  // easy to miss.
  equippedWith?: { name: string; imageUrl: string | null; onClick: () => void }[]
  // Playtest-only: whether the specific printing being inspected is marked owned-in-foil in
  // whichever deck it came from — separate from deckMode.isFoil (that's the deck-EDITING foil
  // toggle; this is read-only display of an already-known state).
  isFoil?: boolean
  // Clicking a tag in the Tags panel jumps to Tag Search for it — omitted (tags render as
  // plain, non-interactive text) wherever the caller has no tag-search view to jump to.
  onTagClick?: (tag: string) => void
  // Clicking a type or subtype word in the meta line searches for other cards of that
  // type/subtype — omitted (the words render as plain, non-interactive text, same as before
  // this existed) wherever the caller has no search view to jump to.
  onTypeClick?: (term: string) => void
}

const LEGALITY_ORDER = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper']
const FLIP_HALF_DURATION_MS = 150

function formatLegality(status: string): string {
  return status.replace('_', ' ')
}

// Renders a type line ("Legendary Creature — Jellyfish Hydra Beast") as the exact same text,
// broken into individually clickable type/subtype words when onTypeClick is provided — each
// word searches for other cards sharing it. Falls back to plain (inert) text when omitted, so
// callers with no search view to jump to see no visual or behavioral change at all.
function renderTypeLine(typeLine: string, onTypeClick?: (term: string) => void) {
  const [typesRaw, subtypesRaw] = typeLine.split('—').map((s) => s.trim())
  const typeWords = typesRaw ? typesRaw.split(/\s+/).filter(Boolean) : []
  const subtypeWords = subtypesRaw ? subtypesRaw.split(/\s+/).filter(Boolean) : []

  function renderWords(words: string[], keyPrefix: string) {
    return words.map((word, i) => (
      <span key={`${keyPrefix}-${i}`}>
        {i > 0 ? ' ' : ''}
        <span
          className={onTypeClick ? 'card-detail__type-word' : undefined}
          onClick={onTypeClick ? () => onTypeClick(word) : undefined}
        >
          {word}
        </span>
      </span>
    ))
  }

  return (
    <>
      {renderWords(typeWords, 'type')}
      {subtypeWords.length > 0 && (
        <>
          {' — '}
          {renderWords(subtypeWords, 'subtype')}
        </>
      )}
    </>
  )
}

export default function CardDetail({ card, onClose, deckMode, minimal, equippedWith, isFoil, onTagClick, onTypeClick }: Props) {
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
    skipNextPrintingChange.current = true

    // A read-only spectator inspect (Playtest) already has the exact right printing — the one
    // actually on the battlefield/in the deck — passed in as `card`. Fetching every alternate
    // printing here was not just wasted work: once it resolved, the "jump to preferred printing"
    // logic below would swap `activeId` to a DIFFERENT printing's id, visibly changing the art
    // a moment after opening. Skipping the fetch entirely avoids both problems.
    if (minimal) return

    setLoadingPrintings(true)

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

  // On-demand only (not part of the bulk card fetch that filled `printings`) — see
  // getLocalizedCardArt's own comment for why bulk lists don't pay this cost per-card. One
  // cheap extra request for whichever single printing is actually being looked at right now.
  const [localizedArt, setLocalizedArt] = useState<{
    image_uris?: ScryfallCard['image_uris']
    card_faces?: { image_uris?: ScryfallCard['image_uris'] }[]
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLocalizedArt(null)
    if (getLocale() !== 'pt-BR' || !active.set || !active.collector_number) return
    window.api.getLocalizedCardArt(active.set, active.collector_number).then((result) => {
      if (!cancelled && result && !isError(result)) {
        setLocalizedArt(result as { image_uris?: ScryfallCard['image_uris']; card_faces?: { image_uris?: ScryfallCard['image_uris'] }[] })
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id])

  const localizedFace = localizedArt?.card_faces?.[faceIndex]
  const image =
    localizedFace?.image_uris?.large ??
    currentFace?.image_uris?.large ??
    localizedArt?.image_uris?.large ??
    active.image_uris?.large ??
    active.image_uris?.normal
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
        <div className={`card-detail__image-wrap ${deckMode?.isFoil || isFoil ? 'is-foil' : ''}`}>
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
            {manaCost && <span>{manaCost}</span>} · {renderTypeLine(typeLine, onTypeClick)}
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

          {equippedWith && equippedWith.length > 0 && (
            <>
              <h3>Equipped / Enchanted with</h3>
              <div className="card-detail__equipped-with">
                {equippedWith.map((item, i) => (
                  <button key={i} className="card-detail__equipped-with-item" onClick={item.onClick} title={item.name}>
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} />
                    ) : (
                      <div className="card-detail__equipped-with-placeholder">{item.name}</div>
                    )}
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Always rendered once printings has been initialized with at least the currently-
              shown card (see useState<ScryfallCard[]>([card]) above) — this used to be gated on
              printings.length > 1, meaning the whole menu was completely absent from the page
              until the alternate-printings fetch finished. Users who clicked to inspect a card
              during that window saw no printing control at all, and often didn't notice it pop
              in once loading finished. Showing it immediately with just the current printing
              selected (and expanding once more arrive) means there's always something there to
              find, loading or not. */}
          {!minimal && (
            <>
              <h3>Printing {loadingPrintings && '(loading…)'}</h3>
              <PrintingSelect printings={printings} activeId={activeId} onChange={setActiveId} />
            </>
          )}

          {!minimal && (
            <CardTagsPanel
              card={active}
              userTags={deckMode?.userTags}
              onAddUserTag={deckMode?.onAddUserTag}
              onRemoveUserTag={deckMode?.onRemoveUserTag}
              onTagClick={onTagClick}
            />
          )}

          {!minimal && (
            <>
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
            </>
          )}

          <a href={active.scryfall_uri} target="_blank" rel="noreferrer" className="card-detail__link">
            View on Scryfall ↗
          </a>
        </div>
      </div>
    </div>
  )
}
