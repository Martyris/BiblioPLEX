import { useEffect, useMemo, useState } from 'react'
import { isError } from './types'

interface ScryfallCatalog {
  object: 'catalog'
  data: string[]
}

// Module-level, not component state — the catalog is the same for every search box in the app
// and every DeckBuilder instance, so it's fetched at most once per app run (repeat calls in
// the same run just reuse the resolved promise) instead of once per mount.
let catalogPromise: Promise<string[]> | null = null

function loadCatalog(): Promise<string[]> {
  if (!catalogPromise) {
    catalogPromise = window.api.getCardNameCatalog().then((result) => {
      if (isError(result)) {
        catalogPromise = null // let the next caller retry instead of caching a failure
        return []
      }
      return (result as ScryfallCatalog).data ?? []
    })
  }
  return catalogPromise
}

// Backs search-as-you-type dropdowns. Scryfall's full card-name list (~30k names, one JSON
// payload) rarely changes, so it's fetched once and cached — every keystroke after that first
// load filters the in-memory array, with zero network round-trip, which is what makes this
// feel instant rather than merely "fast" the way a per-keystroke API call would.
export function useCardNameAutocomplete(query: string): { names: string[]; loading: boolean } {
  const [catalog, setCatalog] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    loadCatalog().then((names) => {
      if (!cancelled) setCatalog(names)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = query.trim().toLowerCase()

  const names = useMemo(() => {
    if (!trimmed || !catalog) return []
    // Prefix matches first (what you're almost always after when typing a card name from the
    // start), then other substring matches, each group alphabetical.
    const starts: string[] = []
    const contains: string[] = []
    for (const name of catalog) {
      const lower = name.toLowerCase()
      if (lower.startsWith(trimmed)) starts.push(name)
      else if (lower.includes(trimmed)) contains.push(name)
    }
    return [...starts.sort(), ...contains.sort()]
  }, [catalog, trimmed])

  return { names, loading: !catalog && Boolean(trimmed) }
}
