import { useEffect, useState } from 'react'
import { isError, type ScryfallCard, type ScryfallSearchResult, type SearchResponse } from './types'
import type { SortOption } from './components/SortControl'

interface CardResultsState {
  cards: ScryfallCard[]
  total: number | null
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  loadMore: () => void
}

export function useCardResults(query: string, sort: SortOption, rawText?: string): CardResultsState {
  const [cards, setCards] = useState<ScryfallCard[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tracks whichever query string actually produced results — the original, or (after a
  // foreign-name fallback resolves) the substituted one — so "Load more" paginates the query
  // that worked instead of re-running the original foreign name and 404ing again.
  const [effectiveQuery, setEffectiveQuery] = useState('')

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setCards([])
      setTotal(null)
      setHasMore(false)
      setError(null)
      return
    }

    let cancelled = false
    const timeout = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        let usedQuery = trimmed
        let result = (await window.api.searchCards(trimmed, {
          order: sort.order,
          dir: sort.dir,
          page: 1
        })) as SearchResponse
        if (cancelled) return

        // Scryfall's plain-text search only matches English oracle names — a foreign printed
        // name (e.g. a card's German or Japanese name) 404s there even though Scryfall does
        // track it. Retry via the fuzzy-name endpoint, which does resolve foreign names, and
        // re-run the same search substituting the resolved English name for what was typed.
        const rawTrimmed = rawText?.trim()
        if (isError(result) && result.status === 404 && rawTrimmed && trimmed.includes(rawTrimmed)) {
          const fuzzy = await window.api.getCardByFuzzyName(rawTrimmed)
          if (cancelled) return
          if (!isError(fuzzy)) {
            const resolvedName = (fuzzy as ScryfallCard).name
            usedQuery = trimmed.replace(rawTrimmed, resolvedName)
            result = (await window.api.searchCards(usedQuery, {
              order: sort.order,
              dir: sort.dir,
              page: 1
            })) as SearchResponse
            if (cancelled) return
          }
        }

        if (isError(result)) {
          setCards([])
          setTotal(null)
          setHasMore(false)
          setError(result.status === 404 ? 'No cards found.' : result.details)
          return
        }

        setCards(result.data ?? [])
        setTotal(result.total_cards ?? result.data?.length ?? 0)
        setHasMore(Boolean(result.has_more))
        setPage(1)
        setEffectiveQuery(usedQuery)
      } catch (err) {
        if (!cancelled) {
          setCards([])
          setTotal(null)
          setHasMore(false)
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [query, sort.order, sort.dir, rawText])

  async function loadMore(): Promise<void> {
    const trimmed = effectiveQuery || query.trim()
    if (!trimmed || loadingMore) return
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const result = (await window.api.searchCards(trimmed, {
        order: sort.order,
        dir: sort.dir,
        page: nextPage
      })) as SearchResponse

      if (isError(result)) {
        setError(result.details)
        return
      }

      const r = result as ScryfallSearchResult
      setCards((prev) => [...prev, ...(r.data ?? [])])
      setHasMore(Boolean(r.has_more))
      setPage(nextPage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return { cards, total, hasMore, loading, loadingMore, error, loadMore }
}
