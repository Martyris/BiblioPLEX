import type { ScryfallCard } from './types'

// Module-wide caches shared by the whole Playtest surface (PlaytestTabView's live board and
// PlaytestAnalysisView's post-match report both look up the same card art/data for the same
// names) — living in their own module, rather than PlaytestTabView.tsx, specifically so the two
// components can both import them without creating a circular import between the two.
export const cardImageCache = new Map<string, string | null>()
export const cardDataByName = new Map<string, ScryfallCard>()
