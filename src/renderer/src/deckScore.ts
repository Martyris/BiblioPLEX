import type { ScryfallCard } from './types'
import { categorizeCard } from './deckLogic'
import { cardsSeenByTurn, computeManaCurve, computeCurveHealthNotes, simulateColorAccessProbability } from './deckAnalytics'

export interface ScoreCategory {
  key: string
  label: string
  score: number
  detail: string
}

// One distinct color per grade tier (not just a rough red/yellow/green split) — shared by the
// Score tab's animated ring and the small static ring on the decks list, so a given score
// reads as the same color everywhere it shows up.
export function scoreColor(score: number): string {
  if (score >= 98) return '#b388ff'
  if (score >= 93) return '#4fd8c4'
  if (score >= 85) return '#7ee787'
  if (score >= 75) return '#a8d84f'
  if (score >= 60) return '#e6c229'
  if (score >= 45) return '#f0824f'
  return '#f04747'
}

export interface DeckScoreResult {
  overall: number
  grade: string
  gradeLabel: string
  categories: ScoreCategory[]
  strengths: string[]
  weaknesses: string[]
  sizeWarning: string | null
  appliedArchetype: { key: string; label: string } | null
  archetypeNote: string | null
}

interface RangeSpec {
  min: number
  max: number
  tolerance: number
}

/** 100 inside [min, max]; falls off linearly outside it, hitting 0 once `tolerance` units
 *  past the nearest edge. A generous, forgiving curve — decks rarely hit a number exactly,
 *  and a few pieces short of "ideal" shouldn't read as a failing score. */
function rangeScore(value: number, { min, max, tolerance }: RangeSpec): number {
  if (value >= min && value <= max) return 100
  const distance = value < min ? min - value : value - max
  return Math.max(0, Math.round(100 - (distance / tolerance) * 100))
}

function countTag(tagCounts: { tag: string; count: number }[], ...tags: string[]): number {
  return tagCounts.filter((t) => tags.includes(t.tag)).reduce((sum, t) => sum + t.count, 0)
}

/** Explicitly says which direction the count is off in — "18 pieces (ideal 8-12)" reads as
 *  neutral even when 18 is well past the top of the range, so state the verdict in words
 *  rather than making the reader do the comparison themselves. */
function directionalDetail(value: number, { min, max }: RangeSpec, noun: string): string {
  if (value < min) return `${value} ${noun} — below the ideal ${min}-${max}. Consider adding more.`
  if (value > max) return `${value} ${noun} — above the ideal ${min}-${max}. Consider trimming a few.`
  return `${value} ${noun} — right in the ideal ${min}-${max} range.`
}

function rangeCategory(key: string, label: string, value: number, spec: RangeSpec, noun: string): ScoreCategory {
  return { key, label, score: rangeScore(value, spec), detail: directionalDetail(value, spec, noun) }
}

/** For traits where more is strictly never bad (synergy with the commander, unlike ramp or
 *  removal where too much crowds out the rest of the deck) — 100 once `min` is met or beaten,
 *  falling off below it. No upper penalty, ever. */
function floorScore(value: number, min: number, tolerance: number): number {
  if (value >= min) return 100
  return Math.max(0, Math.round(100 - ((min - value) / tolerance) * 100))
}

function floorDetail(value: number, min: number, noun: string): string {
  if (value < min) return `${value} ${noun} — below the ${min}+ target. Consider adding more.`
  return `${value} ${noun} — meets the ${min}+ target. More is only ever better here.`
}

function floorCategory(key: string, label: string, value: number, min: number, tolerance: number, noun: string): ScoreCategory {
  return { key, label, score: floorScore(value, min, tolerance), detail: floorDetail(value, min, noun) }
}

type AdjustableCategory = 'lands' | 'ramp' | 'draw' | 'removal' | 'wipes'

export interface ArchetypeAdjustment {
  key: string
  label: string
  // Matches against the commander's own EDHREC theme tag slugs — a commander tagged
  // "spellslinger" is normally BUILT that way, which is a reasonable proxy for how this
  // specific deck should be judged even before checking its actual card choices.
  matchTagSlugs: string[]
  overrides: Partial<Record<AdjustableCategory, RangeSpec>>
  note: string
}

// Each entry needs real deckbuilding judgment behind its numbers, not a guess — these are
// widely-cited community rules of thumb for well-established EDHREC archetypes, not invented
// figures. Only ONE of these ever applies at a time (see resolveArchetypeAdjustments) — a
// deck is built around one primary game plan, and stacking every matching archetype's
// adjustments on top of each other would muddy the targets rather than sharpen them.
const ARCHETYPE_ADJUSTMENTS: ArchetypeAdjustment[] = [
  {
    key: 'spellslinger',
    matchTagSlugs: ['spellslinger'],
    label: 'Spellslinger',
    overrides: {
      draw: { min: 12, max: 18, tolerance: 8 },
      removal: { min: 10, max: 15, tolerance: 8 }
    },
    note: 'Spellslinger decks lean harder on card draw and interaction than an average deck — targets raised to match.'
  },
  {
    key: 'aristocrats',
    matchTagSlugs: ['aristocrats'],
    label: 'Aristocrats',
    overrides: {
      wipes: { min: 0, max: 1, tolerance: 3 }
    },
    note: 'Sacrifice/aristocrats decks build around a wide, expendable board — a board wipe hurts them as much as the ' +
      'table, so few-to-none is normal.'
  },
  {
    key: 'tokens',
    matchTagSlugs: ['tokens'],
    label: 'Tokens',
    overrides: {
      wipes: { min: 0, max: 1, tolerance: 3 }
    },
    note: 'Go-wide token decks avoid board wipes for the same reason — the board itself is the win condition.'
  },
  {
    key: 'group-hug',
    matchTagSlugs: ['group-hug'],
    label: 'Group Hug',
    overrides: {
      removal: { min: 2, max: 6, tolerance: 6 },
      wipes: { min: 0, max: 1, tolerance: 3 }
    },
    note: 'Group hug decks deliberately minimize hostile interaction — low removal and wipe counts are the point, ' +
      'not a gap.'
  },
  {
    key: 'stax',
    matchTagSlugs: ['stax'],
    label: 'Stax',
    overrides: {
      removal: { min: 12, max: 18, tolerance: 8 }
    },
    note: 'Stax/control decks win by locking down the board through heavy interaction — target raised accordingly.'
  },
  {
    key: 'landfall',
    matchTagSlugs: ['landfall'],
    label: 'Landfall',
    overrides: {
      lands: { min: 38, max: 42, tolerance: 8 },
      ramp: { min: 10, max: 15, tolerance: 8 }
    },
    note: 'Landfall decks want extra land drops and land-matters ramp — land count and ramp targets both raised.'
  },
  {
    key: 'voltron',
    matchTagSlugs: ['voltron'],
    label: 'Voltron',
    overrides: {
      wipes: { min: 3, max: 5, tolerance: 4 }
    },
    note: 'Voltron decks stake everything on one or two threats — a board wipe barely costs them anything while ' +
      'clearing away blockers, so a heavier wipe count than usual is normal, not excessive.'
  },
  {
    key: 'tribal',
    matchTagSlugs: ['tribal'],
    label: 'Tribal',
    overrides: {
      wipes: { min: 0, max: 1, tolerance: 3 }
    },
    note: 'Tribal decks go wide with a specific creature type — same logic as Tokens: a wipe undoes the whole ' +
      'game plan, so low-to-none is expected.'
  },
  {
    key: 'infect',
    matchTagSlugs: ['infect'],
    label: 'Infect',
    overrides: {
      lands: { min: 32, max: 36, tolerance: 8 },
      removal: { min: 4, max: 8, tolerance: 8 }
    },
    note: 'Infect is a fast, low-curve race to 10 poison counters — fewer lands (a low curve needs less mana) and ' +
      'less interaction (the plan is racing, not answering) than a typical deck.'
  },
  {
    key: 'combo',
    matchTagSlugs: ['combo'],
    label: 'Combo',
    overrides: {
      draw: { min: 12, max: 18, tolerance: 8 },
      removal: { min: 10, max: 15, tolerance: 8 }
    },
    note: 'Combo decks need to dig for specific pieces and protect them once assembled — card draw and interaction ' +
      'targets both raised, same reasoning as Spellslinger.'
  },
  {
    key: 'aggro',
    matchTagSlugs: ['aggro'],
    label: 'Aggro',
    overrides: {
      lands: { min: 32, max: 36, tolerance: 8 },
      ramp: { min: 4, max: 8, tolerance: 8 }
    },
    note: 'Aggro decks curve out low and close games fast — fewer lands and less need for ramp than a deck built ' +
      'around a bigger late game.'
  },
  {
    key: 'big-creatures',
    matchTagSlugs: ['big-creatures', 'stompy'],
    label: 'Big Creatures',
    overrides: {
      ramp: { min: 12, max: 18, tolerance: 8 }
    },
    note: 'Ramp-into-big-threats decks live or die on hitting their acceleration — target raised well above the ' +
      'baseline 8-12.'
  }
]

// For the archetype picker in the UI — "Auto" and "None" are handled separately by the caller.
export const ARCHETYPE_OPTIONS: { key: string; label: string }[] = ARCHETYPE_ADJUSTMENTS.map((a) => ({
  key: a.key,
  label: a.label
}))

export interface CommanderTagRef {
  slug: string
  count: number
}

/** Picks exactly one archetype's adjustments to apply — never stacks several at once, since
 *  a deck is built around one primary game plan and mixing targets would blur rather than
 *  sharpen them. `archetypeKey` of 'none' turns adjustments off entirely; 'auto' (or
 *  omitted) picks whichever matching archetype is the commander's most popular EDHREC tag;
 *  any other value forces that specific archetype regardless of what EDHREC says. */
function resolveArchetypeAdjustments(
  commanderTags: CommanderTagRef[],
  archetypeKey: string | undefined
): {
  overrides: Partial<Record<AdjustableCategory, RangeSpec>>
  applied: { key: string; label: string } | null
  note: string | null
} {
  const none = { overrides: {}, applied: null, note: null }
  if (archetypeKey === 'none') return none

  let chosen: ArchetypeAdjustment | null = null
  if (archetypeKey && archetypeKey !== 'auto') {
    chosen = ARCHETYPE_ADJUSTMENTS.find((a) => a.key === archetypeKey) ?? null
  } else {
    const countBySlug = new Map(commanderTags.map((t) => [t.slug.toLowerCase(), t.count]))
    let bestCount = -1
    for (const a of ARCHETYPE_ADJUSTMENTS) {
      for (const slug of a.matchTagSlugs) {
        const count = countBySlug.get(slug)
        if (count !== undefined && count > bestCount) {
          bestCount = count
          chosen = a
        }
      }
    }
  }

  if (!chosen) return none
  return { overrides: chosen.overrides, applied: { key: chosen.key, label: chosen.label }, note: chosen.note }
}

// No "E" — same reason report cards skip it (F follows D directly). SS/S sit above A instead,
// for decks that go beyond "excellent" into essentially textbook-optimal fundamentals.
export function gradeFor(overall: number): { grade: string; label: string } {
  if (overall >= 98) return { grade: 'SS', label: 'Flawless' }
  if (overall >= 93) return { grade: 'S', label: 'Outstanding' }
  if (overall >= 85) return { grade: 'A', label: 'Excellent' }
  if (overall >= 75) return { grade: 'B', label: 'Good' }
  if (overall >= 60) return { grade: 'C', label: 'Solid Foundation' }
  if (overall >= 45) return { grade: 'D', label: 'Needs Work' }
  return { grade: 'F', label: 'Early Draft' }
}

export function computeDeckScore(params: {
  deckCards: ScryfallCard[]
  deckColorIdentity: string[]
  deckCardTagCounts: { tag: string; count: number }[]
  totalDeckSize: number
  // Oracle ids EDHREC lists under the commander's own top synergy tags — omit while still
  // loading (or if there's no commander) to leave the Synergy category out entirely rather
  // than score it against an empty set.
  synergyOracleIds?: Set<string> | null
  // The commander's own EDHREC theme tags (slug + popularity count) — used to auto-pick
  // whichever archetype best matches how that commander is actually usually built.
  commanderTags?: CommanderTagRef[]
  // 'auto' (default) picks the commander's most popular matching archetype; 'none' disables
  // archetype adjustments; any other value forces that specific archetype.
  archetypeKey?: string
}): DeckScoreResult {
  const { deckCards, deckColorIdentity, deckCardTagCounts, totalDeckSize, synergyOracleIds } = params

  const {
    overrides,
    applied: appliedArchetype,
    note: archetypeNote
  } = resolveArchetypeAdjustments(params.commanderTags ?? [], params.archetypeKey)
  const rangeFor = (key: AdjustableCategory, fallback: RangeSpec): RangeSpec => overrides[key] ?? fallback

  const landCount = deckCards.filter((c) => categorizeCard(c) === 'Land').length
  const rampCount = countTag(deckCardTagCounts, 'Ramp')
  const drawCount = countTag(deckCardTagCounts, 'Card Draw')
  const removalCount = countTag(deckCardTagCounts, 'Removal', 'Soft Removal')
  const wipeCount = countTag(deckCardTagCounts, 'Board Wipe')

  const categories: ScoreCategory[] = []

  categories.push(
    rangeCategory('lands', 'Land Count', landCount, rangeFor('lands', { min: 34, max: 38, tolerance: 8 }), 'lands')
  )
  categories.push(
    rangeCategory('ramp', 'Ramp', rampCount, rangeFor('ramp', { min: 8, max: 12, tolerance: 8 }), 'pieces')
  )
  categories.push(
    rangeCategory('draw', 'Card Draw', drawCount, rangeFor('draw', { min: 8, max: 12, tolerance: 8 }), 'pieces')
  )
  categories.push(
    rangeCategory(
      'removal',
      'Removal & Interaction',
      removalCount,
      rangeFor('removal', { min: 8, max: 12, tolerance: 8 }),
      'pieces'
    )
  )
  categories.push(
    rangeCategory('wipes', 'Board Wipes', wipeCount, rangeFor('wipes', { min: 2, max: 4, tolerance: 4 }), 'pieces')
  )

  const curve = computeManaCurve(deckCards)
  const curveNotes = computeCurveHealthNotes(curve)
  const warningCount = curveNotes.filter((n) => n.tone === 'warning').length
  categories.push({
    key: 'curve',
    label: 'Mana Curve',
    score: Math.max(0, 100 - warningCount * 30),
    detail: curveNotes.map((n) => n.text).join(' ') || 'No curve data yet.'
  })

  if (deckColorIdentity.length > 1) {
    const probability = simulateColorAccessProbability(deckCards, deckColorIdentity, cardsSeenByTurn(3, true))
    categories.push({
      key: 'castability',
      label: 'Color Consistency',
      score: Math.round(probability * 100),
      detail: `${Math.round(probability * 100)}% chance of all ${deckColorIdentity.length} colors by turn 3 (on the play)`
    })
  }

  if (synergyOracleIds && synergyOracleIds.size > 0) {
    const synergyCount = deckCards.filter((c) => synergyOracleIds.has(c.oracle_id)).length
    categories.push(floorCategory('synergy', 'Commander Synergy', synergyCount, 15, 15, 'cards'))
  }

  const overall = Math.round(categories.reduce((sum, c) => sum + c.score, 0) / categories.length)
  const { grade, label } = gradeFor(overall)

  const sorted = [...categories].sort((a, b) => a.score - b.score)
  const weaknesses = sorted
    .filter((c) => c.score < 70)
    .map((c) => `${c.label}: ${c.detail}`)
  const strengths = sorted
    .filter((c) => c.score >= 90)
    .reverse()
    .map((c) => `${c.label}: ${c.detail}`)

  const sizeWarning =
    totalDeckSize === 100 ? null : `This deck has ${totalDeckSize} cards — Commander decks need exactly 100.`

  return {
    overall,
    grade,
    gradeLabel: label,
    categories,
    strengths,
    weaknesses,
    sizeWarning,
    appliedArchetype,
    archetypeNote
  }
}
