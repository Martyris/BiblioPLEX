import { useEffect, useMemo, useState } from 'react'
import { ARCHETYPE_OPTIONS, computeDeckScore, gradeFor, scoreColor, type CommanderTagRef } from '../deckScore'
import { isBasicLand } from '../deckLogic'
import { resolveCardTags, type CardTagOverride } from '../cardTagging'
import CardTile from './CardTile'
import type { ScryfallCard } from '../types'

interface Props {
  deckCards: ScryfallCard[]
  deckColorIdentity: string[]
  deckCardTagCounts: { tag: string; count: number }[]
  totalDeckSize: number
  synergyOracleIds: Set<string> | null
  synergyWeights: Map<string, number> | null
  synergyLoading: boolean
  commanderTags: CommanderTagRef[]
  cardTagOverrides: Map<string, CardTagOverride>
  // Records the computed overall/grade to the deck whenever they change, so the decks list
  // can show a "last recorded" score without recomputing every deck's full score live.
  onScoreComputed?: (overall: number, grade: string) => void
}

// Only categories backed by a real, discrete set of cards worth inspecting are clickable —
// Land Count is basically "every basic plus a handful of nonbasics", not a curated subset,
// and Mana Curve/Color Consistency are shape/probability stats over the whole deck, not a
// card list at all.
const CATEGORY_LABELS: Record<string, string> = {
  ramp: 'Ramp',
  draw: 'Card Draw',
  removal: 'Removal & Interaction',
  wipes: 'Board Wipes',
  synergy: 'Commander Synergy'
}

function cardsForCategory(
  key: string,
  deckCards: ScryfallCard[],
  cardTagOverrides: Map<string, CardTagOverride>,
  synergyOracleIds: Set<string> | null
): ScryfallCard[] {
  const tagsFor = (card: ScryfallCard): string[] => resolveCardTags(card, cardTagOverrides.get(card.oracle_id))
  // Basic lands never meaningfully belong in any of these breakdowns — excluding them here
  // also sidesteps the fact that duplicate basics share one printing id, which would
  // otherwise collide as React keys in the popup grid below.
  const nonBasics = deckCards.filter((c) => !isBasicLand(c))
  switch (key) {
    case 'ramp':
      return nonBasics.filter((c) => tagsFor(c).includes('Ramp'))
    case 'draw':
      return nonBasics.filter((c) => tagsFor(c).includes('Card Draw'))
    case 'removal':
      return nonBasics.filter((c) => tagsFor(c).some((t) => t === 'Removal' || t === 'Soft Removal'))
    case 'wipes':
      return nonBasics.filter((c) => tagsFor(c).includes('Board Wipe'))
    case 'synergy':
      return synergyOracleIds ? nonBasics.filter((c) => synergyOracleIds.has(c.oracle_id)) : []
    default:
      return []
  }
}

const RING_RADIUS = 54
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const RING_DURATION_MS = 2600

/** Counts the ring up from 0 to the real score on an eased curve, rather than snapping
 *  straight to the final value — the grade letter and color update in lockstep with it,
 *  driven off the same animated number, so everything reads as one motion. */
function useAnimatedScore(target: number): number {
  const [animated, setAnimated] = useState(0)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAnimated(target)
      return
    }
    setAnimated(0)
    let frame: number
    const start = performance.now()

    function tick(now: number): void {
      const t = Math.min(1, (now - start) / RING_DURATION_MS)
      // Linear, not eased — an ease-out curve front-loads almost the whole score into the
      // first few frames, so the letter grade blows past F/D/C nearly instantly and only
      // lingers near the final value. A steady pace keeps every grade tier visible.
      setAnimated(Math.round(t * target))
      if (t < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return animated
}

export default function DeckScoreView({
  deckCards,
  deckColorIdentity,
  deckCardTagCounts,
  totalDeckSize,
  synergyOracleIds,
  synergyWeights,
  synergyLoading,
  commanderTags,
  cardTagOverrides,
  onScoreComputed
}: Props) {
  const [archetypeKey, setArchetypeKey] = useState('auto')
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null)

  const selectedCategoryCards = useMemo(() => {
    if (!selectedCategoryKey) return []
    const cards = cardsForCategory(selectedCategoryKey, deckCards, cardTagOverrides, synergyOracleIds)
    // Highest synergy-tag match first, within a category — the cards most "on theme" for
    // this specific commander lead, rather than whatever order they were added to the deck.
    return [...cards].sort(
      (a, b) => (synergyWeights?.get(b.oracle_id) ?? 0) - (synergyWeights?.get(a.oracle_id) ?? 0)
    )
  }, [selectedCategoryKey, deckCards, cardTagOverrides, synergyOracleIds, synergyWeights])

  const result = useMemo(
    () =>
      computeDeckScore({
        deckCards,
        deckColorIdentity,
        deckCardTagCounts,
        totalDeckSize,
        synergyOracleIds,
        commanderTags,
        archetypeKey
      }),
    [deckCards, deckColorIdentity, deckCardTagCounts, totalDeckSize, synergyOracleIds, commanderTags, archetypeKey]
  )
  const animatedScore = useAnimatedScore(result.overall)
  const animatedColor = scoreColor(animatedScore)
  const animatedGradeInfo = gradeFor(animatedScore)
  const animatedGrade = animatedGradeInfo.grade
  const animatedGradeLabel = animatedGradeInfo.label
  const ringOffset = RING_CIRCUMFERENCE * (1 - animatedScore / 100)

  // Skipped while synergy data is still loading — that version of the score is missing the
  // Synergy category and any archetype adjustment, so recording it would overwrite a real
  // "last recorded" score with an incomplete one for the moment before the fetch resolves.
  useEffect(() => {
    if (synergyLoading) return
    onScoreComputed?.(result.overall, result.grade)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.overall, result.grade, synergyLoading])

  return (
    <>
      <h3 className="section-heading">Deck Score</h3>
      <p className="app__hint">
        A rough read on the deck's fundamentals — ramp, draw, interaction, curve, and color consistency — measured
        against typical Commander deckbuilding guidelines. Not a power-level rating, just a sanity check.
      </p>

      {result.sizeWarning && <p className="deck-score__size-warning">⚠ {result.sizeWarning}</p>}

      <div className="deck-score__archetype-picker">
        <label htmlFor="deck-score-archetype">Archetype</label>
        <select
          id="deck-score-archetype"
          value={archetypeKey}
          onChange={(e) => setArchetypeKey(e.target.value)}
        >
          <option value="auto">Auto (best EDHREC match)</option>
          <option value="none">None (baseline targets)</option>
          {ARCHETYPE_OPTIONS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {result.appliedArchetype && result.archetypeNote && (
        <p className="deck-score__archetype-note">
          🎯 {result.appliedArchetype.label}
          {archetypeKey === 'auto' ? ' (auto-detected)' : ''}: {result.archetypeNote}
        </p>
      )}

      {synergyLoading ? (
        <div className="deck-score__calculating">
          <div className="deck-score__spinner" />
          <p>
            Calculating deck score — checking EDHREC for this commander's synergy picks, can take ~15s the first
            time…
          </p>
        </div>
      ) : (
        <>
      <div className="deck-score__hero" style={{ '--score-color': animatedColor } as React.CSSProperties}>
        <div className="deck-score__hero-glow" />
        <div className="deck-score__grade-circle">
          <svg className="deck-score__ring" viewBox="0 0 120 120">
            <circle className="deck-score__ring-track" cx="60" cy="60" r={RING_RADIUS} />
            <circle
              className="deck-score__ring-fill"
              cx="60"
              cy="60"
              r={RING_RADIUS}
              style={{ stroke: animatedColor, strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: ringOffset }}
            />
          </svg>
          <span className="deck-score__grade" style={{ color: animatedColor }}>
            {animatedGrade}
          </span>
          <span className="deck-score__overall">{animatedScore}/100</span>
        </div>
        <div className="deck-score__hero-text">
          <p className="deck-score__grade-label" style={{ color: animatedColor }}>
            {animatedGradeLabel}
          </p>
          <p className="app__hint">Overall score is the average of the categories below.</p>
        </div>
      </div>

      <h3 className="section-heading">Breakdown</h3>
      <div className="deck-score__category-grid">
        {result.categories.map((c) => {
          const clickable = c.key in CATEGORY_LABELS
          return (
            <button
              key={c.key}
              type="button"
              className={`deck-score__category-card ${clickable ? 'is-clickable' : ''}`}
              onClick={() => clickable && setSelectedCategoryKey(c.key)}
              disabled={!clickable}
            >
              <div className="deck-score__category-top">
                <span className="deck-score__category-label">{c.label}</span>
                <span className="deck-score__category-value" style={{ color: scoreColor(c.score) }}>
                  {c.score}
                </span>
              </div>
              <div className="deck-score__category-track">
                <div
                  className="deck-score__category-fill"
                  style={{ width: `${c.score}%`, background: scoreColor(c.score) }}
                />
              </div>
              <p className="deck-score__category-detail">{c.detail}</p>
            </button>
          )
        })}
      </div>

      {selectedCategoryKey && (
        <div className="deck-tag-filter">
          <div className="deck-tag-filter__header">
            <h3 className="section-heading">{CATEGORY_LABELS[selectedCategoryKey]} Cards</h3>
            <button
              className="deck-tag-filter__close"
              onClick={() => setSelectedCategoryKey(null)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {selectedCategoryCards.length === 0 && <p className="app__hint">No cards in this category.</p>}
          <div className="card-grid card-grid--compact">
            {selectedCategoryCards.map((card, index) => (
              <CardTile key={`${card.id}-${index}`} card={card} onSelect={() => {}} />
            ))}
          </div>
        </div>
      )}

      {result.weaknesses.length > 0 && (
        <>
          <h3 className="section-heading">Needs Attention</h3>
          <ul className="deck-score__callout-list deck-score__callout-list--weak">
            {result.weaknesses.map((w) => (
              <li key={w}>
                <span className="deck-score__callout-icon">⚠</span> {w}
              </li>
            ))}
          </ul>
        </>
      )}

      {result.strengths.length > 0 && (
        <>
          <h3 className="section-heading">Strengths</h3>
          <ul className="deck-score__callout-list deck-score__callout-list--strong">
            {result.strengths.map((s) => (
              <li key={s}>
                <span className="deck-score__callout-icon">✓</span> {s}
              </li>
            ))}
          </ul>
        </>
      )}
        </>
      )}
    </>
  )
}
