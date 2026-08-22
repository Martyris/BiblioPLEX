import { useEffect, useRef, useState } from 'react'
import { isError, type EdhrecCardEntry, type EdhrecCommanderData, type ScryfallCard } from '../types'
import EdhrecCardTile from './EdhrecCardTile'
import CardContextMenu from './CardContextMenu'

interface Props {
  commander: ScryfallCard
  onBack: () => void
  backLabel?: string
  helpText?: string
  initialTag?: string
  onSelectCard: (card: ScryfallCard) => void
  // Right-click menu actions — omit any of these to leave that option out of the menu.
  onAddToDeck?: (card: ScryfallCard) => void
  onAddToPool?: (card: ScryfallCard) => void
  onAddToWant?: (card: ScryfallCard) => void
  // Marks a recommendation already on the Card Pool or Want list, by oracle id (same
  // resolution as deckOracleIds below).
  getMarkerForOracleId?: (oracleId: string) => 'want' | 'pool' | undefined
  /** Oracle ids (not printing ids) currently in the deck — used for the "in deck" badge.
   *  Must be oracle-based so the badge stays correct after the user swaps a card's printing
   *  (which changes its exact id but not its oracle identity). */
  deckOracleIds?: Set<string>
}

const MAX_VISIBLE_TAGS = 24

/** Deterministic color per category name (hash → hue), so "Creatures" is always the same
 *  shade across every commander instead of every section using one flat accent color. */
function categoryColor(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 62%)`
}

export default function CommanderView({
  commander,
  onBack,
  backLabel = 'Back to commanders',
  helpText,
  initialTag,
  onSelectCard,
  onAddToDeck,
  onAddToPool,
  onAddToWant,
  getMarkerForOracleId,
  deckOracleIds
}: Props) {
  const [data, setData] = useState<EdhrecCommanderData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingCardId, setLoadingCardId] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(initialTag ?? null)
  const [contextMenu, setContextMenu] = useState<{ entry: EdhrecCardEntry; x: number; y: number } | null>(null)
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map())
  const topRef = useRef<HTMLDivElement>(null)
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(new Set())

  function scrollToSection(tag: string): void {
    sectionRefs.current.get(tag)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function scrollToTop(): void {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function toggleTagCollapsed(tag: string): void {
    setCollapsedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }
  // Maps an EDHREC entry's printing id -> its oracle id, only resolved when deck-aware
  // badges are needed (avoids the extra batch fetch for plain browsing).
  const [entryOracleIds, setEntryOracleIds] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getCommanderData(commander.name, activeTag ?? undefined)
      .then((result: unknown) => {
        if (cancelled) return
        if (isError(result)) {
          setError(
            result.status === 404
              ? 'No EDHREC data found for this commander yet.'
              : `Couldn't load EDHREC data: ${result.details}`
          )
          return
        }
        setData(result as EdhrecCommanderData)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [commander.name, activeTag])

  useEffect(() => {
    if ((!deckOracleIds && !getMarkerForOracleId) || !data) return
    let cancelled = false
    const ids = [...new Set(data.cardlists.flatMap((l) => l.cards.map((c) => c.id)))]
    if (ids.length === 0) return

    window.api.getCardsByIds(ids).then((result: unknown) => {
      if (cancelled || isError(result)) return
      const cards = (result as { data: ScryfallCard[] }).data ?? []
      setEntryOracleIds(new Map(cards.map((c) => [c.id, c.oracle_id])))
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, deckOracleIds])

  async function handleSelect(entry: EdhrecCardEntry): Promise<void> {
    setLoadingCardId(entry.id)
    try {
      const result = await window.api.getCard(entry.id)
      if (!isError(result)) {
        onSelectCard(result as ScryfallCard)
      }
    } finally {
      setLoadingCardId(null)
    }
  }

  function handleContextMenu(entry: EdhrecCardEntry, e: React.MouseEvent): void {
    if (!onAddToDeck && !onAddToPool && !onAddToWant) return
    e.preventDefault()
    setContextMenu({ entry, x: e.clientX, y: e.clientY })
  }

  async function runContextAction(action: (card: ScryfallCard) => void): Promise<void> {
    if (!contextMenu) return
    const { entry } = contextMenu
    setContextMenu(null)
    const result = await window.api.getCard(entry.id)
    if (!isError(result)) action(result as ScryfallCard)
  }

  const face = commander.card_faces?.[0]
  const image = commander.image_uris?.large ?? face?.image_uris?.large ?? commander.image_uris?.normal
  const tags = [...(data?.tags ?? [])].sort((a, b) => b.count - a.count).slice(0, MAX_VISIBLE_TAGS)

  // Being in the deck always wins over Want/Pool — a deck card is also always in the pool
  // (added there automatically on add), so showing a separate pool badge on top would just
  // be noise.
  function statusFor(entry: EdhrecCardEntry): 'deck' | 'want' | 'pool' | undefined {
    const oracleId = entryOracleIds.get(entry.id)
    if (!oracleId) return undefined
    if (deckOracleIds?.has(oracleId)) return 'deck'
    return getMarkerForOracleId?.(oracleId)
  }

  return (
    <div className="commander-view">
      <div ref={topRef} className="app__results-toolbar">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← {backLabel}
        </button>
      </div>
      {helpText && <p className="app__hint">{helpText}</p>}

      <div className="commander-view__header">
        {commander.image_uris?.art_crop && (
          <span
            className="commander-view__header-art-bg"
            style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }}
          />
        )}
        {image && <img className="commander-view__image" src={image} alt={commander.name} />}
        <div>
          <h2>{commander.name}</h2>
          <p className="card-detail__meta">{commander.type_line}</p>
          {data && (
            <p className="app__hint">
              {data.num_decks.toLocaleString()} decks on EDHREC
              {data.rank ? ` · Rank #${data.rank}` : ''}
            </p>
          )}
        </div>
      </div>

      {tags.length > 0 && (
        <div className="tag-row">
          <button className={`tag-chip ${!activeTag ? 'is-active' : ''}`} onClick={() => setActiveTag(null)}>
            All
          </button>
          {tags.map((tag) => (
            <button
              key={tag.slug}
              className={`tag-chip ${activeTag === tag.slug ? 'is-active' : ''}`}
              onClick={() => setActiveTag(tag.slug)}
              title={`${tag.count.toLocaleString()} decks`}
            >
              {tag.value}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="app__hint">Loading EDHREC recommendations…</p>}
      {error && <p className="app__error">{error}</p>}

      {data && data.cardlists.length > 0 && (
        <div className="commander-view__body">
          <nav className="commander-view__toc">
            <button className="commander-view__toc-top" onClick={scrollToTop}>
              ↑ Back to Top
            </button>
            {data.cardlists.map((list) => (
              <button
                key={list.tag}
                className="commander-view__toc-item"
                onClick={() => scrollToSection(list.tag)}
              >
                <span className="commander-view__section-dash" style={{ background: categoryColor(list.tag) }} />
                {list.header}
              </button>
            ))}
          </nav>

          <div className="commander-view__sections">
            {data.cardlists.map((list) => {
              const isCollapsed = collapsedTags.has(list.tag)
              return (
                <section
                  key={list.tag}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(list.tag, el)
                  }}
                  className="commander-view__section"
                >
                  <button
                    className={`commander-view__section-heading commander-view__section-heading--toggle ${isCollapsed ? 'is-collapsed' : ''}`}
                    onClick={() => toggleTagCollapsed(list.tag)}
                  >
                    <span className="commander-view__section-dash" style={{ background: categoryColor(list.tag) }} />
                    {list.header}
                    <span className="commander-view__section-chevron">▾</span>
                  </button>
                  {!isCollapsed && (
                    <div className="edhrec-grid">
                      {list.cards.map((entry) => (
                        <EdhrecCardTile
                          key={entry.id}
                          entry={entry}
                          loading={loadingCardId === entry.id}
                          status={statusFor(entry)}
                          onSelect={handleSelect}
                          onContextMenu={handleContextMenu}
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

      {contextMenu && (
        <CardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={[
            ...(onAddToDeck ? [{ label: 'Add to Deck', onSelect: () => runContextAction(onAddToDeck) }] : []),
            ...(onAddToPool ? [{ label: 'Add to Pool', onSelect: () => runContextAction(onAddToPool) }] : []),
            ...(onAddToWant ? [{ label: 'Add to Want', onSelect: () => runContextAction(onAddToWant) }] : [])
          ]}
        />
      )}
    </div>
  )
}
