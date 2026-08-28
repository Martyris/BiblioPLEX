import type { ScryfallCard } from './types'
import { resolveCardTags } from './cardTagging'
import { isBasicLand } from './deckLogic'

// Deliberately minimal, self-contained shapes — only the fields this module actually reads.
// PlaytestTabView's own (locally-duplicated, per this app's existing convention) GameSimProgress/
// GameSimResult satisfy these structurally, so no import/type coupling is needed between the two
// renderer files.
export interface AnalysisCardRef {
  name: string
}

export interface AnalysisPermanent {
  name: string
}

export interface AnalysisSeatSnapshot {
  name: string
  life: number
  hand: AnalysisCardRef[]
  graveyard: AnalysisCardRef[]
  battlefield: AnalysisPermanent[]
}

export interface AnalysisSnapshot {
  turn: number
  players: AnalysisSeatSnapshot[]
}

export interface AnalysisResult {
  winner: string
  turns: number
  gameMs: number
}

export type CardFateKind = 'cast-survived' | 'cast-died' | 'cast-resolved' | 'discarded-unused' | 'dead-in-hand'

export interface CardFate {
  name: string
  fate: CardFateKind
  tags: string[]
}

export interface TagRollupEntry {
  tag: string
  cast: number
  unused: number
}

export interface SeatAnalysis {
  seatName: string
  won: boolean
  turns: number
  gameMs: number
  lifeOverTime: { turn: number; life: number }[]
  cardFates: CardFate[]
  tagRollup: TagRollupEntry[]
}

/** Derives a post-match report for one seat from the full snapshot history of a finished game —
 *  see docs-equivalent context in the Playtest plan: "what worked / what didn't" correlated
 *  against the deck's existing functional tags, not a new taxonomy. Basic lands are excluded from
 *  the card-fate breakdown entirely — nobody needs to know a Mountain sat in hand. Cards never
 *  seen in hand/graveyard/battlefield across the whole game (still in library) are silently
 *  dropped rather than reported as a fate — there's nothing to say about a card that never came
 *  up. Exile is not a tracked zone in the wire protocol, so a card that's cast and later exiled
 *  reads as "cast, still around" (the last zone it was actually seen in) — a known, accepted gap
 *  given what the log exposes, not a bug. */
export function analyzeSeat(
  history: AnalysisSnapshot[],
  result: AnalysisResult,
  seatName: string,
  deckCardNames: string[],
  cardDataByName: Map<string, ScryfallCard>
): SeatAnalysis {
  const won = result.winner.includes(seatName)

  const lifeByTurn = new Map<number, number>()
  for (const snap of history) {
    const player = snap.players.find((p) => p.name === seatName)
    if (!player) continue
    lifeByTurn.set(snap.turn, player.life) // history is chronological, so a later write for the same turn wins
  }
  const lifeOverTime = [...lifeByTurn.entries()].sort((a, b) => a[0] - b[0]).map(([turn, life]) => ({ turn, life }))

  const uniqueNames = [...new Set(deckCardNames)]
  const cardFates: CardFate[] = []

  for (const name of uniqueNames) {
    const cardData = cardDataByName.get(name)
    if (cardData && isBasicLand(cardData)) continue

    let everOnBattlefield = false
    let lastZone: 'hand' | 'graveyard' | 'battlefield' | null = null

    for (const snap of history) {
      const player = snap.players.find((p) => p.name === seatName)
      if (!player) continue
      if (player.battlefield.some((perm) => perm.name === name)) {
        everOnBattlefield = true
        lastZone = 'battlefield'
      } else if (player.graveyard.some((c) => c.name === name)) {
        lastZone = 'graveyard'
      } else if (player.hand.some((c) => c.name === name)) {
        lastZone = 'hand'
      }
    }

    if (lastZone === null) continue // never drawn — nothing to report

    let fate: CardFateKind
    if (lastZone === 'battlefield') {
      fate = 'cast-survived'
    } else if (lastZone === 'graveyard') {
      if (everOnBattlefield) {
        fate = 'cast-died'
      } else {
        const isSpell = Boolean(cardData?.type_line?.includes('Instant') || cardData?.type_line?.includes('Sorcery'))
        fate = isSpell ? 'cast-resolved' : 'discarded-unused'
      }
    } else {
      fate = 'dead-in-hand'
    }

    cardFates.push({ name, fate, tags: cardData ? resolveCardTags(cardData) : [] })
  }

  const rollupMap = new Map<string, { cast: number; unused: number }>()
  for (const cf of cardFates) {
    const bucket = cf.fate === 'discarded-unused' || cf.fate === 'dead-in-hand' ? 'unused' : 'cast'
    for (const tag of cf.tags) {
      const entry = rollupMap.get(tag) ?? { cast: 0, unused: 0 }
      entry[bucket]++
      rollupMap.set(tag, entry)
    }
  }
  const tagRollup = [...rollupMap.entries()]
    .map(([tag, counts]) => ({ tag, ...counts }))
    .sort((a, b) => b.cast + b.unused - (a.cast + a.unused))

  return { seatName, won, turns: result.turns, gameMs: result.gameMs, lifeOverTime, cardFates, tagRollup }
}
