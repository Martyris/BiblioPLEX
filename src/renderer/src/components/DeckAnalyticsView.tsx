import { useEffect, useMemo, useState } from 'react'
import BarChart from './BarChart'
import CardTile from './CardTile'
import CardDetail from './CardDetail'
import CardContextMenu from './CardContextMenu'
import ColorPips from './ColorPips'
import { COLOR_HEX } from '../colorIdentityName'
import { categorizeCard, isBasicLand } from '../deckLogic'
import {
  cardsSeenByTurn,
  computeCurveHealthNotes,
  computeIdealBasicSplit,
  computeManaCurve,
  computePipCounts,
  computeTypeBreakdown,
  probabilityAtLeastOne,
  requiredColorsForCard,
  simulateColorAccessProbability
} from '../deckAnalytics'
import { resolveCardTags, type CardTagOverride } from '../cardTagging'
import type { ScryfallCard } from '../types'

// Community-standard EDH targets — not hard rules, just the usual rough guidance for a
// functional 99. Counts come straight from the existing tag system, so this stays in sync
// with whatever the tagging engine already tracks.
const BALANCE_TARGETS: { tag: string; label: string; min: number }[] = [
  { tag: 'Ramp', label: 'Ramp', min: 8 },
  { tag: 'Removal', label: 'Removal (incl. board wipes)', min: 8 },
  { tag: 'Card Draw', label: 'Card Draw', min: 8 },
  { tag: 'Counterspell', label: 'Counterspells', min: 2 }
]

const CATEGORY_LABELS: Record<string, string> = {
  Planeswalker: 'Planeswalkers',
  Creature: 'Creatures',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other'
}

const WUBRG_LABELS: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }

interface Props {
  deckCards: ScryfallCard[]
  deckColorIdentity: string[]
  basicLandCounts: Map<string, { count: number; sampleId: string }>
  deckCardTagCounts: { tag: string; count: number }[]
  // Total deck size and commander count, for the two overview stats that count the command
  // zone as part of the deck. The draw-probability calculator below deliberately does NOT use
  // these — the commander is never actually drawn from the library, so including it there
  // would make the hypergeometric math wrong, not just differently labeled.
  totalDeckSize: number
  commanderCount: number
  commander: ScryfallCard | null
  cardTagOverrides: Map<string, CardTagOverride>
  // Right-click menu actions for the Deck Balance suggestion tiles — omit any to leave that
  // option out of the menu (matches the same convention as CommanderView/TagSearchView).
  onAddToDeck?: (card: ScryfallCard) => void
  onAddToPool?: (card: ScryfallCard) => void
  onAddToWant?: (card: ScryfallCard) => void
}

export default function DeckAnalyticsView({
  deckCards,
  deckColorIdentity,
  basicLandCounts,
  deckCardTagCounts,
  totalDeckSize,
  commanderCount,
  commander,
  cardTagOverrides,
  onAddToDeck,
  onAddToPool,
  onAddToWant
}: Props) {
  const [showAllTags, setShowAllTags] = useState(false)
  const [balanceFilterTag, setBalanceFilterTag] = useState<string | null>(null)
  const [traitKey, setTraitKey] = useState<string>('')
  const [turn, setTurn] = useState(1)
  const [onThePlay, setOnThePlay] = useState(false)
  const [castabilityOnThePlay, setCastabilityOnThePlay] = useState(false)
  // Tracked by index (not id/card reference) so a duplicate basic land can be drawn again
  // without being mistaken for "already drawn" — each index is a distinct physical copy.
  const [drawnIndices, setDrawnIndices] = useState<number[] | null>(null)
  const [suggestionsByTag, setSuggestionsByTag] = useState<Record<string, ScryfallCard[]>>({})
  const [viewingSuggestion, setViewingSuggestion] = useState<ScryfallCard | null>(null)
  const [suggestionContextMenu, setSuggestionContextMenu] = useState<{
    card: ScryfallCard
    x: number
    y: number
  } | null>(null)

  function drawSampleHand(): void {
    const handSize = Math.min(7, deckCards.length)
    const indices = deckCards.map((_, i) => i)
    for (let i = 0; i < handSize; i++) {
      const j = i + Math.floor(Math.random() * (indices.length - i))
      const tmp = indices[i]
      indices[i] = indices[j]
      indices[j] = tmp
    }
    setDrawnIndices(indices.slice(0, handSize))
  }

  function drawOneMore(): void {
    if (!drawnIndices) return
    const drawnSet = new Set(drawnIndices)
    const remaining = deckCards.map((_, i) => i).filter((i) => !drawnSet.has(i))
    if (remaining.length === 0) return
    const next = remaining[Math.floor(Math.random() * remaining.length)]
    setDrawnIndices([...drawnIndices, next])
  }

  const sampleHand = drawnIndices ? drawnIndices.map((i) => deckCards[i]) : null

  const nonlandCards = useMemo(() => deckCards.filter((c) => categorizeCard(c) !== 'Land'), [deckCards])
  const landCards = useMemo(() => deckCards.filter((c) => categorizeCard(c) === 'Land'), [deckCards])
  const nonbasicLandCount = landCards.filter((c) => !isBasicLand(c)).length
  const basicLandCount = landCards.filter((c) => isBasicLand(c)).length

  const avgCmc = nonlandCards.length > 0 ? nonlandCards.reduce((sum, c) => sum + c.cmc, 0) / nonlandCards.length : 0

  const manaCurve = useMemo(() => computeManaCurve(deckCards), [deckCards])
  const curveHealthNotes = useMemo(() => computeCurveHealthNotes(manaCurve), [manaCurve])
  const tagCountByName = useMemo(() => new Map(deckCardTagCounts.map((t) => [t.tag, t.count])), [deckCardTagCounts])
  const balanceRows = BALANCE_TARGETS.map((t) => ({ ...t, count: tagCountByName.get(t.tag) ?? 0 }))
  const underTargetTags = balanceRows.filter((r) => r.count < r.min).map((r) => r.tag)

  // Popularity-ranked suggestions for whichever balance categories are under target, pulled
  // from the local bulk tag index (no network call) — filtered to the deck's own colors and
  // cards it doesn't already run, so every suggestion is one the deck could actually play.
  useEffect(() => {
    let cancelled = false
    if (underTargetTags.length === 0) {
      setSuggestionsByTag({})
      return
    }
    const deckOracleIdSet = new Set(deckCards.map((c) => c.oracle_id))

    async function load(): Promise<void> {
      const entries = await Promise.all(
        underTargetTags.map(async (tag) => {
          const result = await window.api.searchCardsByTags([tag])
          const cards = (result as (ScryfallCard & { tags: string[] })[])
            .filter((c) => !deckOracleIdSet.has(c.oracle_id))
            .filter(
              (c) =>
                deckColorIdentity.length === 0 ||
                (c.color_identity ?? []).every((col) => deckColorIdentity.includes(col))
            )
            .sort((a, b) => (a.edhrec_rank ?? Infinity) - (b.edhrec_rank ?? Infinity))
            .slice(0, 4)
          return [tag, cards] as const
        })
      )
      if (!cancelled) setSuggestionsByTag(Object.fromEntries(entries))
    }

    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underTargetTags.join(','), deckCards, deckColorIdentity])

  function handleSuggestionContextMenu(card: ScryfallCard, e: React.MouseEvent): void {
    if (!onAddToDeck && !onAddToPool && !onAddToWant) return
    e.preventDefault()
    setSuggestionContextMenu({ card, x: e.clientX, y: e.clientY })
  }

  function runSuggestionContextAction(action: (card: ScryfallCard) => void): void {
    if (!suggestionContextMenu) return
    action(suggestionContextMenu.card)
    setSuggestionContextMenu(null)
  }

  const balanceFilterCards = useMemo(() => {
    if (!balanceFilterTag) return []
    return deckCards.filter((card) =>
      resolveCardTags(card, cardTagOverrides.get(card.oracle_id)).includes(balanceFilterTag)
    )
  }, [balanceFilterTag, deckCards, cardTagOverrides])
  const pipCounts = useMemo(() => computePipCounts(deckCards), [deckCards])
  const typeBreakdown = useMemo(() => computeTypeBreakdown(deckCards), [deckCards])
  const idealBasics = useMemo(
    () => computeIdealBasicSplit(deckCards, deckColorIdentity, basicLandCounts),
    [deckCards, deckColorIdentity, basicLandCounts]
  )

  const commanderRequiredColors = useMemo(() => (commander ? requiredColorsForCard(commander) : []), [commander])
  // "The turn you can play your commander" on curve, 1 land per turn, no ramp factored into the
  // turn count itself — ramp cards seen among the sampled cards still help the simulation, they
  // just don't accelerate which turn we're checking against.
  const commanderTurn = commander ? Math.max(1, Math.ceil(commander.cmc)) : 1
  const castabilityCardsSeen = cardsSeenByTurn(commanderTurn, castabilityOnThePlay)
  const castabilityProbability = useMemo(() => {
    if (!commander || commanderRequiredColors.length === 0) return null
    return simulateColorAccessProbability(deckCards, commanderRequiredColors, castabilityCardsSeen)
  }, [commander, commanderRequiredColors, deckCards, castabilityCardsSeen])

  const pipChartData = deckColorIdentity
    .filter((c) => WUBRG_LABELS[c])
    .map((c) => ({ label: WUBRG_LABELS[c], value: Math.round(pipCounts[c as keyof typeof pipCounts] * 10) / 10, color: COLOR_HEX[c] }))

  const typeChartData = typeBreakdown.map((t) => ({ label: CATEGORY_LABELS[t.category] ?? t.category, value: t.count }))

  const tagOptions = deckCardTagCounts
  const categoryOptions = typeBreakdown

  // Trait keys are namespaced ("tag:Ramp" / "category:Creature") so a tag and a category that
  // happen to share a name (unlikely, but not impossible) can't collide.
  const traitEntries = [
    ...tagOptions.map((t) => ({ key: `tag:${t.tag}`, label: `Tag: ${t.tag}`, count: t.count })),
    ...categoryOptions.map((c) => ({
      key: `category:${c.category}`,
      label: `Type: ${CATEGORY_LABELS[c.category] ?? c.category}`,
      count: c.count
    }))
  ]
  const activeTrait = traitEntries.find((t) => t.key === traitKey) ?? traitEntries[0]

  const librarySize = deckCards.length
  const cardsSeen = cardsSeenByTurn(turn, onThePlay)
  const probability = activeTrait ? probabilityAtLeastOne(librarySize, activeTrait.count, cardsSeen) : 0

  // Conditional on whiffing in the opening hand: none of the trait's copies were among those
  // 7 cards, so they're all still sitting in the remaining library — just a smaller
  // population and a smaller draw count (whatever's been drawn since the opening hand).
  const OPENING_HAND_SIZE = 7
  const drawsAfterOpeningHand = Math.max(0, cardsSeen - OPENING_HAND_SIZE)
  const libraryAfterOpeningHand = Math.max(0, librarySize - OPENING_HAND_SIZE)
  const conditionalProbability = activeTrait
    ? probabilityAtLeastOne(libraryAfterOpeningHand, activeTrait.count, drawsAfterOpeningHand)
    : 0

  return (
    <div className="deck-analytics">
      <div className="deck-analytics__stats-row">
        <div className="deck-analytics__stat">
          <span className="deck-analytics__stat-value">{totalDeckSize}</span>
          <span className="deck-analytics__stat-label">Library Size</span>
        </div>
        <div className="deck-analytics__stat">
          <span className="deck-analytics__stat-value">
            {basicLandCount + nonbasicLandCount} <span className="deck-analytics__stat-sub">({nonbasicLandCount} nonbasic)</span>
          </span>
          <span className="deck-analytics__stat-label">Lands</span>
        </div>
        <div className="deck-analytics__stat">
          <span className="deck-analytics__stat-value">{avgCmc.toFixed(2)}</span>
          <span className="deck-analytics__stat-label">Avg. Mana Value (nonland)</span>
        </div>
        <div className="deck-analytics__stat">
          {/* Commanders are always nonland (creature/planeswalker), so they add straight in. */}
          <span className="deck-analytics__stat-value">{nonlandCards.length + commanderCount}</span>
          <span className="deck-analytics__stat-label">Nonland Cards</span>
        </div>
      </div>

      <section className="deck-analytics__section">
        <h3 className="deck-analytics__section-heading">
          <span className="deck-analytics__section-dash" />
          Sample Hand
        </h3>
        <p className="app__hint">
          A random 7 from your library (commander excluded, same as it would be in a real game).
        </p>
        <button className="primary-button" onClick={drawSampleHand} disabled={deckCards.length === 0}>
          Draw Sample Hand
        </button>
      </section>

      {sampleHand && (
        <div className="deck-tag-filter">
          <div className="deck-tag-filter__header">
            <h3 className="section-heading">Sample Hand</h3>
            <button className="deck-tag-filter__close" onClick={() => setDrawnIndices(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="card-grid">
            {sampleHand.map((card, i) => (
              <CardTile key={`${card.id}-${i}`} card={card} onSelect={() => {}} />
            ))}
            <button className="draw-more-tile" onClick={drawOneMore} title="Draw one more card">
              +
            </button>
          </div>
        </div>
      )}

      <section className="deck-analytics__section">
        <h3 className="deck-analytics__section-heading">
          <span className="deck-analytics__section-dash" />
          Mana Curve
        </h3>
        <p className="app__hint">Nonland cards by mana value.</p>
        <BarChart
          orientation="vertical"
          data={manaCurve.map((p) => ({ label: String(p.cmc), value: p.count }))}
        />
        {curveHealthNotes.map((note) => (
          <p key={note.text} className={note.tone === 'warning' ? 'app__error' : 'app__hint'}>
            {note.tone === 'warning' ? '⚠ ' : '✓ '}
            {note.text}
          </p>
        ))}
      </section>

      <section className="deck-analytics__section">
        <h3 className="deck-analytics__section-heading">
          <span className="deck-analytics__section-dash" />
          Color Pip Distribution
        </h3>
        <p className="app__hint">
          What the deck's mana costs actually demand — the basis for the ideal basic split below.
        </p>
        {pipChartData.length > 0 ? (
          <BarChart data={pipChartData} valueFormatter={(v) => v.toFixed(1)} />
        ) : (
          <p className="app__hint">No colored mana symbols yet.</p>
        )}
      </section>

      <section className="deck-analytics__section">
        <h3 className="deck-analytics__section-heading">
          <span className="deck-analytics__section-dash" />
          Card Types
        </h3>
        <BarChart data={typeChartData} />
      </section>

      <section className="deck-analytics__section">
        <h3 className="deck-analytics__section-heading">
          <span className="deck-analytics__section-dash" />
          Basic Land Split
        </h3>
        <p className="app__hint">
          Your current {basicLandCount} basics, redistributed proportionally to color pip weight — accounting for
          what your nonbasic lands already cover, so a color with plenty of nonbasic sources gets fewer basics and
          an under-covered color gets more. Not a target land count, just whether the mix leans the right way.
        </p>
        {idealBasics.length > 0 ? (
          <div className="basic-split-table basic-split-table--wide">
            <div className="basic-split-table__row basic-split-table__row--header">
              <span>Color</span>
              <span>Nonbasic Sources</span>
              <span>Basics</span>
              <span>Total Sources</span>
              <span>Ideal Basics</span>
            </div>
            {idealBasics.map((b) => (
              <div key={b.name} className="basic-split-table__row">
                <span style={{ color: COLOR_HEX[b.color] }}>{b.name}</span>
                <span>{b.nonbasicSources}</span>
                <span>{b.current}</span>
                <span>{b.totalSources}</span>
                <span className={b.ideal !== b.current ? 'basic-split-table__delta' : ''}>{b.ideal}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="app__hint">Add some colored spells and basics to see a recommendation.</p>
        )}
      </section>

      {commander && commanderRequiredColors.length > 0 && (
        <section className="deck-analytics__section">
          <h3 className="deck-analytics__section-heading">
            <span className="deck-analytics__section-dash" />
            Commander Castability
          </h3>
          <p className="app__hint">
            Chance of having access to every color {commander.name} needs by the turn you can cast it on curve
            (turn {commanderTurn}, no ramp assumed for the turn count — though ramp you've drawn still helps).
          </p>
          <div className="draw-probability">
            <div className="draw-probability__controls">
              <div className="draw-probability__field">
                <span>Needs</span>
                <ColorPips colors={commanderRequiredColors} size={20} />
              </div>
              <label className="draw-probability__field">
                <span>Sequence</span>
                <select
                  value={castabilityOnThePlay ? 'play' : 'draw'}
                  onChange={(e) => setCastabilityOnThePlay(e.target.value === 'play')}
                >
                  <option value="play">On the play</option>
                  <option value="draw">On the draw</option>
                </select>
              </label>
            </div>
            {castabilityProbability !== null && (
              <div className="draw-probability__result">
                <span className="draw-probability__percent">{(castabilityProbability * 100).toFixed(1)}%</span>
                <span className="app__hint">
                  across {castabilityCardsSeen} cards seen by turn {commanderTurn}
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="deck-analytics__section">
      <h3 className="deck-analytics__section-heading">
        <span className="deck-analytics__section-dash" />
        Deck Balance
      </h3>
      <p className="app__hint">
        Your counts against rough community targets for a functional 99 — not hard rules, just a sanity check.
      </p>
      <div className="deck-balance__body">
      <div className="basic-split-table">
        <div className="basic-split-table__row basic-split-table__row--header">
          <span>Category</span>
          <span>Count</span>
          <span>Target</span>
        </div>
        {balanceRows.map((row) => (
          <button
            key={row.tag}
            className="basic-split-table__row basic-split-table__row--clickable"
            onClick={() => setBalanceFilterTag(row.tag)}
            title={`See which cards count as ${row.label}`}
          >
            <span>{row.label}</span>
            <span className={row.count < row.min ? 'basic-split-table__warning' : ''}>{row.count}</span>
            <span>{row.min}+</span>
          </button>
        ))}
      </div>

      {underTargetTags.length > 0 && (
        <div className="deck-balance__suggestions">
          {underTargetTags.map((tag) => {
            const cards = suggestionsByTag[tag]
            if (!cards || cards.length === 0) return null
            return (
              <div key={tag} className="deck-balance__suggestion-row">
                <span className="deck-balance__suggestion-tag">{tag}</span>
                <div className="deck-balance__suggestion-tiles">
                  {cards.map((card) => (
                    <CardTile
                      key={card.id}
                      card={card}
                      onSelect={setViewingSuggestion}
                      onContextMenu={handleSuggestionContextMenu}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
      </div>
      </section>

      {balanceFilterTag && (
        <div className="deck-tag-filter">
          <div className="deck-tag-filter__header">
            <h3 className="section-heading">Cards tagged "{balanceFilterTag}"</h3>
            <button className="deck-tag-filter__close" onClick={() => setBalanceFilterTag(null)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="card-grid card-grid--compact">
            {balanceFilterCards.map((card) => (
              <CardTile key={card.id} card={card} onSelect={() => {}} />
            ))}
          </div>
        </div>
      )}

      {viewingSuggestion && <CardDetail card={viewingSuggestion} onClose={() => setViewingSuggestion(null)} />}

      {suggestionContextMenu && (
        <CardContextMenu
          x={suggestionContextMenu.x}
          y={suggestionContextMenu.y}
          onClose={() => setSuggestionContextMenu(null)}
          actions={[
            ...(onAddToDeck ? [{ label: 'Add to Deck', onSelect: () => runSuggestionContextAction(onAddToDeck) }] : []),
            ...(onAddToPool ? [{ label: 'Add to Pool', onSelect: () => runSuggestionContextAction(onAddToPool) }] : []),
            ...(onAddToWant ? [{ label: 'Add to Want', onSelect: () => runSuggestionContextAction(onAddToWant) }] : [])
          ]}
        />
      )}

      {deckCardTagCounts.length > 0 && (
        <section className="deck-analytics__section">
          <h3 className="deck-analytics__section-heading">
            <span className="deck-analytics__section-dash" />
            Card Tags
          </h3>
          <BarChart
            data={(showAllTags ? deckCardTagCounts : deckCardTagCounts.slice(0, 12)).map((t) => ({
              label: t.tag,
              value: t.count
            }))}
          />
          {!showAllTags && deckCardTagCounts.length > 12 && (
            <button className="back-link" onClick={() => setShowAllTags(true)}>
              Show all {deckCardTagCounts.length} tags
            </button>
          )}
        </section>
      )}

      <section className="deck-analytics__section">
      <h3 className="deck-analytics__section-heading">
        <span className="deck-analytics__section-dash" />
        Draw Probability
      </h3>
      <p className="app__hint">Chance of having drawn at least one card with the selected trait by a given turn.</p>
      <div className="draw-probability">
        <div className="draw-probability__controls">
          <label className="draw-probability__field">
            <span>Trait</span>
            <select value={activeTrait?.key ?? ''} onChange={(e) => setTraitKey(e.target.value)}>
              {traitEntries.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label} ({t.count})
                </option>
              ))}
            </select>
          </label>
          <label className="draw-probability__field">
            <span>Turn</span>
            <input
              type="number"
              min={1}
              max={20}
              value={turn}
              onChange={(e) => setTurn(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="draw-probability__field">
            <span>Sequence</span>
            <select value={onThePlay ? 'play' : 'draw'} onChange={(e) => setOnThePlay(e.target.value === 'play')}>
              <option value="play">On the play</option>
              <option value="draw">On the draw</option>
            </select>
          </label>
        </div>
        {activeTrait ? (
          <>
            <div className="draw-probability__result">
              <span className="draw-probability__percent">{(probability * 100).toFixed(1)}%</span>
              <span className="app__hint">
                chance of at least one "{activeTrait.label}" card among {cardsSeen} cards seen ({activeTrait.count} of{' '}
                {librarySize} drawable cards — the commander doesn't count, since it's never drawn from the library)
              </span>
            </div>
            <div className="draw-probability__result draw-probability__result--conditional">
              <span className="draw-probability__percent">{(conditionalProbability * 100).toFixed(1)}%</span>
              <span className="app__hint">
                chance of drawing one by turn {turn}, <em>given none were in your opening hand</em> —{' '}
                {drawsAfterOpeningHand} card{drawsAfterOpeningHand === 1 ? '' : 's'} drawn since, from a {libraryAfterOpeningHand}
                -card remaining library
              </span>
            </div>
          </>
        ) : (
          <p className="app__hint">Add some cards to the deck to enable this.</p>
        )}
      </div>
      </section>
    </div>
  )
}
