import type { ScryfallCard } from './types'

const ALT_ART_FRAME_EFFECTS = ['showcase', 'extendedart']

function isStandardPrinting(card: ScryfallCard): boolean {
  return (
    !card.full_art &&
    !card.promo &&
    !card.variation &&
    !card.digital &&
    !card.oversized &&
    card.border_color === 'black' &&
    !(card.frame_effects ?? []).some((fx) => ALT_ART_FRAME_EFFECTS.includes(fx))
  )
}

/** Picks the latest printing that isn't full art / alt art / promo, falling back to the latest overall. */
export function pickPreferredPrinting(printings: ScryfallCard[]): ScryfallCard | null {
  if (printings.length === 0) return null

  const byReleaseDesc = [...printings].sort((a, b) => (a.released_at < b.released_at ? 1 : -1))
  const standard = byReleaseDesc.filter(isStandardPrinting)
  return standard[0] ?? byReleaseDesc[0]
}
