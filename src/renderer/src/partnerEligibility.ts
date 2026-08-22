import type { ScryfallCard } from './types'

export type SecondCommanderMode = 'background' | 'partner' | null

function fullOracleText(card: ScryfallCard): string {
  if (card.oracle_text) return card.oracle_text
  return (card.card_faces ?? []).map((f) => f.oracle_text ?? '').join('\n')
}

/** Whether this commander can pair with a second commander, and what kind of pick that is. */
export function detectSecondCommanderMode(card: ScryfallCard): SecondCommanderMode {
  const text = fullOracleText(card)
  if (/choose a background/i.test(text)) return 'background'
  if (/\bpartner\b/i.test(text)) return 'partner'
  return null
}

/** Scryfall search scope for picking the second commander/background. */
export function secondCommanderQuery(mode: SecondCommanderMode): string {
  return mode === 'background' ? 't:background' : 'keyword:partner'
}
