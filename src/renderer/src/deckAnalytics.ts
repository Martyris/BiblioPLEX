import type { ScryfallCard } from './types'
import { isBasicLand, categorizeCard, CARD_CATEGORIES, type CardCategory } from './deckLogic'

const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const
type WubrgColor = (typeof WUBRG)[number]

export interface ManaCurvePoint {
  cmc: number | '7+'
  count: number
}

/** Buckets nonland cards by mana value, 7+ collapsed into one bucket (standard convention —
 *  high-end cards are rare enough that per-value buckets past 7 aren't worth the chart width). */
export function computeManaCurve(cards: ScryfallCard[]): ManaCurvePoint[] {
  const buckets = new Map<number | '7+', number>()
  for (const card of cards) {
    if (isBasicLand(card) || categorizeCard(card) === 'Land') continue
    const bucket = card.cmc >= 7 ? '7+' : Math.floor(card.cmc)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  const order: (number | '7+')[] = [0, 1, 2, 3, 4, 5, 6, '7+']
  return order.map((cmc) => ({ cmc, count: buckets.get(cmc) ?? 0 }))
}

/** Colored mana symbols across a card's cost. Hybrid/Phyrexian symbols (e.g. {W/U}, {W/P})
 *  split their weight evenly across every WUBRG letter they contain, rather than over- or
 *  under-counting a card that can be cast multiple ways. */
function pipsInCost(manaCost: string | undefined): Partial<Record<WubrgColor, number>> {
  const pips: Partial<Record<WubrgColor, number>> = {}
  if (!manaCost) return pips
  const symbols = manaCost.match(/\{[^}]+\}/g) ?? []
  for (const symbol of symbols) {
    const letters = WUBRG.filter((c) => symbol.includes(c))
    if (letters.length === 0) continue
    const weight = 1 / letters.length
    for (const l of letters) pips[l] = (pips[l] ?? 0) + weight
  }
  return pips
}

/** Which WUBRG colors appear anywhere in a card's cost (both faces) — presence only, no
 *  weighting, for "what colors does this card need access to" rather than "how much". */
export function requiredColorsForCard(card: ScryfallCard): WubrgColor[] {
  const costs = card.card_faces?.length ? card.card_faces.map((f) => f.mana_cost) : [card.mana_cost]
  const colors = new Set<WubrgColor>()
  for (const cost of costs) {
    if (!cost) continue
    for (const c of WUBRG) if (cost.includes(c)) colors.add(c)
  }
  return [...colors]
}

/** Total colored pip weight per color across every nonland card's cost (both faces, for
 *  split/adventure/MDFC cards) — the standard basis for "what does this deck actually need". */
export function computePipCounts(cards: ScryfallCard[]): Record<WubrgColor, number> {
  const totals: Record<WubrgColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const card of cards) {
    if (categorizeCard(card) === 'Land') continue
    const costs = card.card_faces?.length ? card.card_faces.map((f) => f.mana_cost) : [card.mana_cost]
    for (const cost of costs) {
      const pips = pipsInCost(cost)
      for (const c of WUBRG) totals[c] += pips[c] ?? 0
    }
  }
  return totals
}

export interface TypeBreakdownEntry {
  category: CardCategory
  count: number
}

export function computeTypeBreakdown(cards: ScryfallCard[]): TypeBreakdownEntry[] {
  const counts = new Map<CardCategory, number>()
  for (const card of cards) {
    const category = categorizeCard(card)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const order: CardCategory[] = [...CARD_CATEGORIES, 'Other']
  return order.filter((c) => counts.has(c)).map((category) => ({ category, count: counts.get(category)! }))
}

const NAME_FOR_COLOR: Record<WubrgColor, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest'
}

/** Distributes `total` across values proportional to `shares`, via largest-remainder rounding
 *  so the results always sum back to exactly `total` (plain multiply-and-round can miss by 1). */
function distributeProportionally(shares: number[], total: number): number[] {
  const sumShares = shares.reduce((a, b) => a + b, 0)
  if (sumShares <= 0 || total <= 0) return shares.map(() => 0)
  const raw = shares.map((s) => (s / sumShares) * total)
  const floors = raw.map(Math.floor)
  let remainder = total - floors.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => ({ i, frac: v - floors[i] })).sort((a, b) => b.frac - a.frac)
  const result = [...floors]
  for (const { i } of order) {
    if (remainder <= 0) break
    result[i] += 1
    remainder -= 1
  }
  return result
}

/** How many WUBRG colors a permanent (land, rock, dork — anything with produced_mana) can
 *  actually produce. Colorless-only entries ('C') don't help cast a colored pip. */
export function producedWubrgColors(card: ScryfallCard): WubrgColor[] {
  return WUBRG.filter((c) => card.produced_mana?.includes(c))
}

/** Count of NONBASIC lands producing each color — the mana base you already have before basics
 *  get allocated, used so the basic split fills gaps instead of ignoring existing fixing. */
export function computeNonbasicColorSources(cards: ScryfallCard[]): Record<WubrgColor, number> {
  const totals: Record<WubrgColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const card of cards) {
    if (categorizeCard(card) !== 'Land' || isBasicLand(card)) continue
    for (const c of producedWubrgColors(card)) totals[c] += 1
  }
  return totals
}

export interface BasicLandSplitEntry {
  name: string
  color: WubrgColor
  nonbasicSources: number
  current: number
  totalSources: number
  ideal: number
}

/** Recommends how your *current* basic land count should be split across colors. Proportional
 *  to colored mana pip weight, same as before, but now weighted by need rather than blindly —
 *  a color already well-covered by nonbasic lands gets fewer of the shared basics, and a color
 *  under-covered gets more, so the total (nonbasic + basic) sources per color track pip demand
 *  instead of the basics alone. Still redistributes the count you already run, not a target
 *  deck size — this answers "is my existing basic mix right", not "how many lands to run". */
export function computeIdealBasicSplit(
  deckCards: ScryfallCard[],
  colorIdentity: string[],
  basicCounts: Map<string, { count: number }>
): BasicLandSplitEntry[] {
  const identity = new Set(colorIdentity)
  const relevantColors = WUBRG.filter((c) => identity.has(c))
  if (relevantColors.length === 0) return []

  const currentBasics = relevantColors.map((c) => basicCounts.get(NAME_FOR_COLOR[c])?.count ?? 0)
  const totalBasics = currentBasics.reduce((a, b) => a + b, 0)
  const nonbasicSources = computeNonbasicColorSources(deckCards)

  const pips = computePipCounts(deckCards)
  const totalPips = relevantColors.reduce((sum, c) => sum + pips[c], 0)

  if (totalPips === 0 || totalBasics === 0) {
    return relevantColors.map((c, i) => ({
      name: NAME_FOR_COLOR[c],
      color: c,
      nonbasicSources: nonbasicSources[c],
      current: currentBasics[i],
      totalSources: nonbasicSources[c] + currentBasics[i],
      ideal: 0
    }))
  }

  const combinedPool = relevantColors.reduce((sum, c) => sum + nonbasicSources[c], 0) + totalBasics

  // Target TOTAL sources (nonbasic + basic) per color, proportional to pip weight — then the
  // basics owed to a color are whatever's left after its existing nonbasic sources.
  const targetTotals = distributeProportionally(
    relevantColors.map((c) => pips[c]),
    combinedPool
  )
  const deficits = relevantColors.map((c, i) => Math.max(0, targetTotals[i] - nonbasicSources[c]))

  // A color whose nonbasics already meet or beat its target has zero deficit — if every color
  // is already fully covered by nonbasics (deficits all zero), fall back to plain pip-weight
  // redistribution of the basics rather than leaving them all undistributed.
  const idealBasics =
    deficits.some((d) => d > 0)
      ? distributeProportionally(deficits, totalBasics)
      : distributeProportionally(
          relevantColors.map((c) => pips[c]),
          totalBasics
        )

  return relevantColors.map((c, i) => ({
    name: NAME_FOR_COLOR[c],
    color: c,
    nonbasicSources: nonbasicSources[c],
    current: currentBasics[i],
    totalSources: nonbasicSources[c] + currentBasics[i],
    ideal: idealBasics[i]
  }))
}

/** Monte Carlo estimate of the chance that, among `sampleSize` cards seen from the library,
 *  there's at least one source for every color in `requiredColors`. Exact combinatorics for
 *  "at least one of each of several possibly-overlapping color sets" gets unwieldy fast (a dual
 *  land counts toward two colors at once) — simulation handles the overlap for free and is
 *  plenty accurate at a few thousand trials for a deck-building heuristic. */
export function simulateColorAccessProbability(
  cards: ScryfallCard[],
  requiredColors: string[],
  sampleSize: number,
  trials = 8000
): number {
  const needed = [...new Set(requiredColors)]
  if (needed.length === 0) return 1
  const n = cards.length
  const clampedSample = Math.min(Math.max(0, sampleSize), n)
  if (clampedSample <= 0) return 0

  const producedSets = cards.map((c) => new Set(producedWubrgColors(c)))
  const indices = Array.from({ length: n }, (_, i) => i)
  let successes = 0

  for (let t = 0; t < trials; t++) {
    const covered = new Set<string>()
    for (let i = 0; i < clampedSample; i++) {
      const j = i + Math.floor(Math.random() * (n - i))
      const tmp = indices[i]
      indices[i] = indices[j]
      indices[j] = tmp
      for (const c of producedSets[indices[i]]) covered.add(c)
      if (needed.every((c) => covered.has(c))) break
    }
    if (needed.every((c) => covered.has(c))) successes++
  }
  return successes / trials
}

/** P(zero successes in `draws` draws from a population of `populationSize` containing
 *  `successes`), via an iterative product of fractions — exact, and avoids ever forming huge
 *  factorials (C(99, 40) alone overflows well past safe-integer precision). */
function probabilityZeroSuccesses(populationSize: number, successes: number, draws: number): number {
  if (draws <= 0) return 1
  if (draws > populationSize) return 0
  const failures = populationSize - successes
  if (failures < draws) return 0
  let p = 1
  for (let i = 0; i < draws; i++) {
    p *= (failures - i) / (populationSize - i)
  }
  return p
}

/** Probability of drawing at least one copy of a trait present `successes` times in a
 *  `populationSize`-card library, having seen `draws` cards. */
export function probabilityAtLeastOne(populationSize: number, successes: number, draws: number): number {
  if (populationSize <= 0 || successes <= 0) return 0
  if (successes >= populationSize) return 1
  const clampedDraws = Math.min(draws, populationSize)
  return 1 - probabilityZeroSuccesses(populationSize, successes, clampedDraws)
}

export interface CurveHealthNote {
  tone: 'warning' | 'good'
  text: string
}

/** A couple of plain-language flags on the mana curve shape — thin early game or top-heavy —
 *  rather than another chart to read; these are the two shapes that most commonly cause real
 *  gameplay problems (nothing to do turns 2-3, or a hand full of uncastable bombs). */
export function computeCurveHealthNotes(curve: ManaCurvePoint[]): CurveHealthNote[] {
  const total = curve.reduce((sum, p) => sum + p.count, 0)
  if (total === 0) return []

  const lowSlice = curve.filter((p) => p.cmc === 2 || p.cmc === 3).reduce((sum, p) => sum + p.count, 0)
  const highSlice = curve.filter((p) => p.cmc === '7+' || (typeof p.cmc === 'number' && p.cmc >= 6)).reduce(
    (sum, p) => sum + p.count,
    0
  )

  const notes: CurveHealthNote[] = []
  const lowShare = lowSlice / total
  const highShare = highSlice / total

  if (lowShare < 0.25) {
    notes.push({
      tone: 'warning',
      text: `Only ${Math.round(lowShare * 100)}% of nonland cards cost 2-3 — the deck may be short on early plays.`
    })
  } else {
    notes.push({ tone: 'good', text: `${Math.round(lowShare * 100)}% of nonland cards cost 2-3 — a healthy early game.` })
  }

  if (highShare > 0.2) {
    notes.push({
      tone: 'warning',
      text: `${Math.round(highShare * 100)}% of nonland cards cost 6+ — the curve is top-heavy.`
    })
  }

  return notes
}

/** Cards seen by a given turn: opening hand (7) plus one draw per turn — except the player
 *  going first skips the draw step of their very first turn (current tournament rule). */
export function cardsSeenByTurn(turn: number, onThePlay: boolean, handSize = 7): number {
  const draws = onThePlay ? Math.max(0, turn - 1) : turn
  return handSize + draws
}
