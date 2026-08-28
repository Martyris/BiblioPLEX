import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import CardTile from './CardTile'
import CardDetail from './CardDetail'
import ColorPips from './ColorPips'
import { groupCardsByCategory, getIllegalReason } from '../deckLogic'
import { isError, type ScryfallCard } from '../types'

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

interface Props {
  preconId: string
  onBack: () => void
  // Clicking a type/subtype word in a card's inspect view jumps to the main Search tab — see
  // App.tsx's handleTypeSearch.
  onTypeSearch: (term: string) => void
}

const DECK_CATEGORY_LABELS: Record<string, string> = {
  Planeswalker: 'Planeswalkers',
  Creature: 'Creatures',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other'
}

// Same curated palette as DeckBuilder's category sidebar (DECK_CATEGORY_DASH_COLORS) — kept
// as its own copy since that constant isn't exported, matching this file's existing
// DECK_CATEGORY_LABELS duplication.
const DECK_CATEGORY_DASH_COLORS: Record<string, string> = {
  Planeswalker: '#e6c229',
  Creature: '#7ee787',
  Instant: '#4fd8c4',
  Sorcery: '#f0824f',
  Artifact: '#9fb8d9',
  Enchantment: '#b388ff',
  Land: '#c9a876',
  Other: '#8b95a8'
}

// Same TOC/collapse behavior as DeckBuilder's useCategorySidebar — a read-only viewer still
// benefits from jumping straight to a category in a 100-card list. pageTopRef (shared, points at
// the outermost .app__results div — see PreconDeckView's own pageTopRef) is what "Back to Top"
// actually scrolls to now — it used to scroll to this section's own heading instead, which sits
// below the "← back"/Export/Copy toolbar, so "back to top" never actually reached the true top.
function useCategorySidebar(pageTopRef: RefObject<HTMLElement | null>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map())

  function toggleCollapsed(category: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  function scrollToSection(category: string): void {
    sectionRefs.current.get(category)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function scrollToTop(): void {
    // pageTopRef points at .app__results itself — the actual scrolling element (overflow-y:
    // auto), not a child of it. scrollIntoView scrolls the nearest scrollable ANCESTOR of its
    // target, so calling it here tried to scroll whatever's above .app__results (nothing
    // actually scrolls there), which is why this silently did nothing. Scrolling the container
    // directly is the correct call when the ref IS the scroller, not content inside it.
    pageTopRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return { collapsed, toggleCollapsed, sectionRefs, scrollToSection, scrollToTop }
}

// A read-only sibling to DeckBuilder — a precon isn't editable (see PreconsBrowser), so this
// deliberately has none of DeckBuilder's mutation machinery: no Add Cards, no Hot Swap, no
// EDHREC tab, no Card Pool/Want, and CardDetail is shown without a deckMode prop so it never
// offers a remove or printing-swap control either. It does reuse DeckBuilder's category
// sidebar/TOC for navigating a large decklist, plus Export and Copy to My Decks.
export default function PreconDeckView({ preconId, onBack, onTypeSearch }: Props) {
  const [precon, setPrecon] = useState<PreconDeck | null>(null)
  const [cardsById, setCardsById] = useState<Record<string, ScryfallCard>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingCard, setViewingCard] = useState<ScryfallCard | null>(null)
  const [exportModal, setExportModal] = useState<{ deckName: string; text: string } | null>(null)
  const [exportCopied, setExportCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null)
  // "Back to Top" target — see the outermost <div className="app__results" ref={pageTopRef}>
  // below, which holds the "← back" link and Export/Copy toolbar.
  const pageTopRef = useRef<HTMLDivElement>(null)
  const sidebar = useCategorySidebar(pageTopRef)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function load(): Promise<void> {
      const list = (await window.api.listPrecons()) as PreconDeck[]
      const found = list.find((p) => p.id === preconId) ?? null
      if (cancelled) return
      if (!found) {
        setError('Precon not found.')
        setLoading(false)
        return
      }
      setPrecon(found)

      const allIds = [
        found.commanderId,
        ...(found.partnerCommanderId ? [found.partnerCommanderId] : []),
        ...found.cardIds
      ]
      const result = await window.api.getCardsByIds([...new Set(allIds)])
      if (cancelled) return
      if (isError(result)) {
        setError(result.details)
        setLoading(false)
        return
      }
      const cards = (result as { data: ScryfallCard[] }).data ?? []
      setCardsById(Object.fromEntries(cards.map((c) => [c.id, c])))
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [preconId])

  const commander = precon ? cardsById[precon.commanderId] : undefined
  const partner = precon?.partnerCommanderId ? cardsById[precon.partnerCommanderId] : undefined
  const deckColorIdentity = useMemo(
    () => [...new Set([...(commander?.color_identity ?? []), ...(partner?.color_identity ?? [])])],
    [commander, partner]
  )
  const deckCards = useMemo(
    () => (precon ? precon.cardIds.map((id) => cardsById[id]).filter((c): c is ScryfallCard => Boolean(c)) : []),
    [precon, cardsById]
  )
  const categories = useMemo(() => groupCardsByCategory(deckCards), [deckCards])

  async function handleCopyToMyDecks(): Promise<void> {
    if (!precon) return
    setCopying(true)
    try {
      await window.api.copyPreconToMyDecks(precon.id)
      setCopiedNotice(`"${precon.name}" copied to My Decks.`)
      window.setTimeout(() => setCopiedNotice(null), 3000)
    } finally {
      setCopying(false)
    }
  }

  async function handleExport(): Promise<void> {
    if (!precon) return
    const nameCounts = new Map<string, number>()
    for (const id of precon.cardIds) {
      const name = cardsById[id]?.name ?? '(unknown card)'
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

  if (loading) {
    return (
      <div className="app__results">
        <p className="app__hint">Loading precon…</p>
      </div>
    )
  }

  if (error || !precon) {
    return (
      <div className="app__results">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← Precons
        </button>
        <p className="app__error">{error ?? 'Precon not found.'}</p>
      </div>
    )
  }

  return (
    <div className="app__results" ref={pageTopRef}>
      <div className="app__results-toolbar">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← Precons
        </button>
        <h2 className="set-detail__title">{precon.name}</h2>
        <span className="app__hint">{precon.setHeader}</span>
        <button className="secondary-button" onClick={handleExport}>
          Export
        </button>
        <button className="primary-button" onClick={handleCopyToMyDecks} disabled={copying}>
          {copying ? 'Copying…' : 'Copy to My Decks'}
        </button>
      </div>

      {copiedNotice && <p className="app__hint">{copiedNotice}</p>}

      <div className="deck-builder__header-row">
        {commander && (
          <button className="deck-builder__commander" title={commander.name} onClick={() => setViewingCard(commander)}>
            {commander.image_uris?.art_crop && (
              <span
                className="deck-builder__commander-art-bg"
                style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
              />
            )}
            <div className="deck-builder__commander-content">
              {commander.image_uris?.small && (
                <img src={commander.image_uris.small} alt={commander.name} className="deck-builder__commander-image" />
              )}
              <div>
                <p className="card-detail__meta">Commander</p>
                <h3>{commander.name}</h3>
                <ColorPips colors={commander.color_identity} size={18} showName />
              </div>
            </div>
          </button>
        )}

        {partner && (
          <button className="deck-builder__commander" title={partner.name} onClick={() => setViewingCard(partner)}>
            {partner.image_uris?.art_crop && (
              <span
                className="deck-builder__commander-art-bg"
                style={{ backgroundImage: `url(${partner.image_uris.art_crop})` }}
              />
            )}
            <div className="deck-builder__commander-content">
              {partner.image_uris?.small && (
                <img src={partner.image_uris.small} alt={partner.name} className="deck-builder__commander-image" />
              )}
              <div>
                <p className="card-detail__meta">Partner</p>
                <h3>{partner.name}</h3>
                <ColorPips colors={partner.color_identity} size={18} showName />
              </div>
            </div>
          </button>
        )}

        <p className="app__hint">{deckCards.length + 1 + (partner ? 1 : 0)} card(s) — view only, not editable.</p>
      </div>

      <h3 className="section-heading">
        Deck ({deckCards.length} card{deckCards.length === 1 ? '' : 's'})
      </h3>

      {deckCards.length > 0 && (
        <div className="commander-view__body">
          <nav className="commander-view__toc">
            <button className="commander-view__toc-top" onClick={sidebar.scrollToTop}>
              ↑ Back to Top
            </button>
            {categories.map(({ category, cards }) => (
              <button
                key={category}
                className="commander-view__toc-item"
                onClick={() => sidebar.scrollToSection(category)}
              >
                <span
                  className="commander-view__section-dash"
                  style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                />
                {DECK_CATEGORY_LABELS[category] ?? category} ({cards.length})
              </button>
            ))}
          </nav>

          <div className="commander-view__sections">
            {categories.map(({ category, cards }) => {
              const isCollapsed = sidebar.collapsed.has(category)
              return (
                <section
                  key={category}
                  ref={(el) => {
                    if (el) sidebar.sectionRefs.current.set(category, el)
                  }}
                  className="commander-view__section"
                >
                  <button
                    className={`commander-view__section-heading commander-view__section-heading--toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                    onClick={() => sidebar.toggleCollapsed(category)}
                  >
                    <span
                      className="commander-view__section-dash"
                      style={{ background: DECK_CATEGORY_DASH_COLORS[category] }}
                    />
                    {DECK_CATEGORY_LABELS[category] ?? category}
                    {` (${cards.length})`}
                    <span className="commander-view__section-chevron">▾</span>
                  </button>
                  {!isCollapsed && (
                    <div className="card-grid">
                      {cards.map((card) => (
                        <CardTile
                          key={card.id}
                          card={card}
                          onSelect={setViewingCard}
                          illegalReason={getIllegalReason(card, deckColorIdentity)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}

      {viewingCard && (
        <CardDetail card={viewingCard} onClose={() => setViewingCard(null)} onTypeClick={onTypeSearch} />
      )}

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
