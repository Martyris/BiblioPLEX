import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isError, type ScryfallCard, type ScryfallRuling, type ScryfallRulingsResult, type ScryfallSearchResult } from '../types'
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
  // Whether *this specific slot* should open showing its back/secondary face (transform,
  // modal_dfc, or a reversible_card printing) instead of the front — remembered the same way a
  // foil choice is. Omit onToggleFlip to make flipping ephemeral (resets next time this card is
  // opened), e.g. outside deck-editing contexts.
  isFlipped?: boolean
  onToggleFlip?: () => void
  // This deck's own tag additions for this exact card (see StoredDeck.userCardTags) — omit all
  // three together outside deck-editing contexts (Search, Sets, Commander, Precons, Playtest),
  // where there's no specific deck to scope a tag addition to.
  userTags?: string[]
  onAddUserTag?: (tag: string) => void
  onRemoveUserTag?: (tag: string) => void
  // A user-uploaded image standing in for this card's real art, scoped to one deck (see
  // StoredDeck.proxyArtByKey) — a cosmetic "skin," not a printing change. `back` only matters
  // for a transform/MDFC card (isFlippable below) — flipping switches which one shows, same as
  // it switches which real face shows. Omit onSetProxyArt to hide the button entirely (e.g.
  // outside deck-editing contexts, same as the tag props above).
  proxyArt?: { front: string; back?: string }
  onSetProxyArt?: (face: 'front' | 'back', dataUrl: string | null) => void
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
// A sanity check on the file the user picks, before it's ever read/rescaled — rejects something
// wildly oversized without bothering to decode it. The actual stored size is governed by
// PROXY_ART_MAX_DIMENSION + JPEG re-encoding below instead, which brings basically any photo
// down to well under a megabyte regardless of how large the original file was.
const MAX_PROXY_ART_INPUT_BYTES = 10 * 1024 * 1024
// Longest side, in px, after rescaling — comfortably covers every size this app ever actually
// displays a card image at (the card-detail view's own image is smaller than this), so there's
// no visible quality loss, while keeping what's stored inline in decks.json (see
// StoredDeck.proxyArtByKey) reasonable regardless of how large the source photo was.
const PROXY_ART_MAX_DIMENSION = 1000

function formatLegality(status: string): string {
  return status.replace('_', ' ')
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode that image.'))
    img.src = src
  })
}

// Downscales to PROXY_ART_MAX_DIMENSION on the longest side (a no-op if the source is already
// smaller) and re-encodes as JPEG — a proxy art upload can now be up to 10MB going in, but
// nothing card-art-sized ever needs to stay anywhere near that once stored inline in decks.json.
// Falls back to the untouched original data URL if canvas 2D somehow isn't available.
async function rescaleImageFile(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file)
  const img = await loadImageElement(original)
  const scale = Math.min(1, PROXY_ART_MAX_DIMENSION / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return original
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
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
  const [proxyArtModalOpen, setProxyArtModalOpen] = useState(false)
  const [proxyArtError, setProxyArtError] = useState<string | null>(null)
  const [proxyArtSaving, setProxyArtSaving] = useState(false)
  const proxyArtFileInputRef = useRef<HTMLInputElement>(null)

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

  // A different printing may be a different layout entirely — land on whichever face this deck
  // slot last remembered (front, if there's no deckMode to remember one, or none was saved yet).
  useEffect(() => {
    setFaceIndex(deckMode?.isFlipped ? 1 : 0)
    setIsFlipping(false)
    // Deliberately NOT reacting to deckMode.isFlipped changing on its own — that happens when
    // this same effect's own flip click persists a toggle, and re-running here would immediately
    // fight it back to the pre-toggle face.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A back-face proxy only ever applies while actually showing the back (faceIndex 1) — flipping
  // a two-sided card with only a front skin set correctly falls through to that face's real art
  // instead of incorrectly re-showing the front's skin on the back.
  const proxyArtForFace = faceIndex === 1 ? deckMode?.proxyArt?.back : deckMode?.proxyArt?.front
  const image =
    proxyArtForFace ??
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
      deckMode?.onToggleFlip?.()
    }, FLIP_HALF_DURATION_MS)
  }

  function handleRemove(): void {
    deckMode?.onRemove?.()
    onClose()
  }

  async function handleProxyArtFile(file: File): Promise<void> {
    if (file.size > MAX_PROXY_ART_INPUT_BYTES) {
      setProxyArtError('Image is too large — please use one under 10 MB.')
      return
    }
    setProxyArtSaving(true)
    setProxyArtError(null)
    try {
      const dataUrl = await rescaleImageFile(file)
      // Whichever face is currently showing is the one being skinned — flip first, then upload,
      // to set the other side.
      deckMode?.onSetProxyArt?.(faceIndex === 1 ? 'back' : 'front', dataUrl)
      setProxyArtModalOpen(false)
    } catch (err) {
      setProxyArtError(err instanceof Error ? err.message : String(err))
    } finally {
      setProxyArtSaving(false)
    }
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
          {deckMode?.onSetProxyArt &&
            // Two-sided cards get their own art per face — flip to the side you want, then set
            // (or discard) that side's skin specifically; the label says which side is current
            // so it's never ambiguous which face an upload is about to replace.
            (proxyArtForFace ? (
              <button
                className="card-detail__proxy-art"
                onClick={() => deckMode.onSetProxyArt?.(faceIndex === 1 ? 'back' : 'front', null)}
              >
                Discard Proxy Art{isFlippable ? (faceIndex === 1 ? ' (Back)' : ' (Front)') : ''}
              </button>
            ) : (
              <button className="card-detail__proxy-art" onClick={() => setProxyArtModalOpen(true)}>
                Use Proxy Art{isFlippable ? (faceIndex === 1 ? ' (Back)' : ' (Front)') : ''}
              </button>
            ))}
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

      {proxyArtModalOpen &&
        createPortal(
          <div className="card-detail-overlay" onClick={(e) => { e.stopPropagation(); setProxyArtModalOpen(false) }}>
            <div className="account-modal account-modal--confirm" onClick={(e) => e.stopPropagation()}>
              <button className="card-detail__close" onClick={() => setProxyArtModalOpen(false)}>
                ×
              </button>
              <h3 className="section-heading" style={{ marginTop: 0 }}>
                Use Proxy Art{isFlippable ? (faceIndex === 1 ? ' — Back' : ' — Front') : ''}
              </h3>
              <p className="app__hint">
                Shows your own image instead of this card's real art, in this deck only — the card underneath is
                completely unchanged (same name, rules text, and legality).
                {isFlippable && ' Flip the card first to set the other side separately.'} Up to 10MB — larger images
                are automatically resized down.
              </p>
              <input
                ref={proxyArtFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleProxyArtFile(file)
                  e.target.value = ''
                }}
              />
              <button className="secondary-button" onClick={() => proxyArtFileInputRef.current?.click()} disabled={proxyArtSaving}>
                {proxyArtSaving ? 'Uploading…' : 'Choose Image'}
              </button>
              {proxyArtError && <p className="app__error">{proxyArtError}</p>}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
