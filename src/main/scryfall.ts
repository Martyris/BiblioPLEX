const API_BASE = 'https://api.scryfall.com'
const USER_AGENT = 'BiblioPLEX/0.1 (https://github.com/; local dev build)'

// Scryfall asks that consumers stay under 10 req/s for most endpoints, but under just
// 2 req/s for the "heavy" ones: search, named, random, and collection. Two independent
// queues enforce that split.
const GENERAL_INTERVAL_MS = 110 // ~9/s, safely under the 10/s general cap
const HEAVY_INTERVAL_MS = 550 // ~1.8/s, safely under the 2/s heavy-endpoint cap

let generalLastAt = 0
let heavyLastAt = 0
// These are promise chains, not booleans — each call appends itself and awaits its
// predecessor, so concurrent callers are strictly serialized. A plain "check last request
// time, then set it" (no chain) is racy: two calls can both read the same stale timestamp
// before either writes a new one, both pass the wait check, and fire back-to-back — which is
// exactly how this app got rate-limited by Scryfall despite having a throttle in place.
let generalChain: Promise<void> = Promise.resolve()
let heavyChain: Promise<void> = Promise.resolve()

function isHeavyEndpoint(url: string): boolean {
  return /\/cards\/(search|named|random|collection)(\?|$)/.test(url)
}

async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
  const heavy = isHeavyEndpoint(url)
  const interval = heavy ? HEAVY_INTERVAL_MS : GENERAL_INTERVAL_MS

  // Claim our spot in line synchronously (no `await` between reading and replacing the
  // chain), so no other concurrent call can slip in between.
  const previousTurn = heavy ? heavyChain : generalChain
  let release!: () => void
  const ourTurn = new Promise<void>((resolve) => {
    release = resolve
  })
  if (heavy) heavyChain = ourTurn
  else generalChain = ourTurn

  await previousTurn
  try {
    const lastAt = heavy ? heavyLastAt : generalLastAt
    const wait = Math.max(0, lastAt + interval - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (heavy) heavyLastAt = Date.now()
    else generalLastAt = Date.now()

    return await fetch(url, {
      ...init,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...init?.headers
      },
      signal: AbortSignal.timeout(10_000)
    })
  } finally {
    release()
  }
}

export interface ScryfallError {
  error: true
  status: number
  details: string
}

function toScryfallError(err: unknown): ScryfallError {
  const message = err instanceof Error ? err.message : String(err)
  const timedOut = err instanceof Error && err.name === 'TimeoutError'
  console.error('[scryfall] request failed:', message)
  return { error: true, status: timedOut ? 408 : 0, details: timedOut ? 'Request timed out' : message }
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await throttledFetch(url, init)
    const body = await res.json()

    if (!res.ok) {
      return { error: true, status: res.status, details: body?.details ?? 'Unknown error' } as ScryfallError
    }
    return body
  } catch (err) {
    return toScryfallError(err)
  }
}

function isScryfallError(x: unknown): x is ScryfallError {
  return typeof x === 'object' && x !== null && (x as { error?: unknown }).error === true
}

export interface SearchOptions {
  order?: string
  dir?: 'asc' | 'desc'
  page?: number
}

export async function searchCards(query: string, options: SearchOptions = {}): Promise<unknown> {
  if (!query.trim()) return { object: 'list', total_cards: 0, data: [] }

  const params = new URLSearchParams({ q: query })
  if (options.order) params.set('order', options.order)
  if (options.dir) params.set('dir', options.dir)
  if (options.page) params.set('page', String(options.page))

  return getJson(`${API_BASE}/cards/search?${params.toString()}`)
}

export async function getCardById(id: string): Promise<unknown> {
  return getJson(`${API_BASE}/cards/${encodeURIComponent(id)}`)
}

// Scryfall's plain-text search only matches the English oracle name — a foreign printed name
// (e.g. "Blitzschlag" for Lightning Bolt) 404s there even though Scryfall does track it. The
// fuzzy-named endpoint resolves it correctly, so this is the fallback path for foreign-name
// search rather than a change to searchCards itself.
export async function getCardByFuzzyName(name: string): Promise<unknown> {
  return getJson(`${API_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`)
}

export async function getSets(): Promise<unknown> {
  return getJson(`${API_BASE}/sets`)
}

// /cards/autocomplete is a lightweight name-only lookup (not in the "heavy" list above) meant
// for exactly this — firing on every keystroke of a search-as-you-type box. It returns just
// matching names, no card data/images, which is what makes it fast enough to skip debouncing.
// Superseded as the deck builder's dropdown source by getCardNameCatalog below (zero network
// latency per keystroke instead of one round-trip), but left in place — still used as-is
// nowhere else yet, and cheap to keep around.
export async function autocompleteCardNames(query: string): Promise<unknown> {
  if (!query.trim()) return { object: 'catalog', data: [] }
  return getJson(`${API_BASE}/cards/autocomplete?q=${encodeURIComponent(query)}`)
}

// The full list of English card names (~30k strings, one JSON payload) barely changes between
// Magic releases, so it's fetched once per app run and cached in memory — every keystroke
// after that first fetch filters this array locally with zero network round-trip, which is
// what makes the dropdown feel instant rather than merely "fast".
let cardNameCatalogCache: string[] | null = null

export async function getCardNameCatalog(): Promise<unknown> {
  if (cardNameCatalogCache) return { object: 'catalog', data: cardNameCatalogCache }
  const result = await getJson(`${API_BASE}/catalog/card-names`)
  if (!isScryfallError(result)) {
    cardNameCatalogCache = (result as { data?: string[] }).data ?? []
  }
  return result
}

// POST /cards/collection accepts at most 75 identifiers per call.
const COLLECTION_BATCH_SIZE = 75

/** Batch-resolves card ids to full card objects, preserving the input order. */
export async function getCardsByIds(ids: string[]): Promise<unknown> {
  const uniqueIds = [...new Set(ids)]
  const results: unknown[] = []

  for (let i = 0; i < uniqueIds.length; i += COLLECTION_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + COLLECTION_BATCH_SIZE)
    const body = await getJson(`${API_BASE}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((id) => ({ id })) })
    })
    if (isScryfallError(body)) return body
    const data = (body as { data?: unknown[] })?.data ?? []
    results.push(...data)
  }

  const byId = new Map(results.map((c) => [(c as { id: string }).id, c]))
  return { object: 'list', data: ids.map((id) => byId.get(id)).filter(Boolean) }
}

/** Batch-resolves exact (set, collector_number) pairs to their specific printings — used for
 *  precon decklists (see main/precons.ts), which know exactly which printing each card ships
 *  as and shouldn't get some other/newer printing substituted in. Returns one card per
 *  requested pair; pairs Scryfall couldn't find come back in `not_found` (as "set/number"
 *  strings) rather than silently vanishing, since a precon list quietly missing cards is worse
 *  than a decklist import quietly missing cards — this one has no user to notice at import time. */
export async function getCardsBySetAndNumber(
  pairs: { set: string; collectorNumber: string }[],
  onProgress?: (resolved: number, total: number) => void
): Promise<unknown> {
  const key = (p: { set: string; collectorNumber: string }): string => `${p.set}/${p.collectorNumber}`
  const uniquePairs = [...new Map(pairs.map((p) => [key(p), p])).values()]
  const results: unknown[] = []
  const notFound: string[] = []

  for (let i = 0; i < uniquePairs.length; i += COLLECTION_BATCH_SIZE) {
    const batch = uniquePairs.slice(i, i + COLLECTION_BATCH_SIZE)
    const body = await getJson(`${API_BASE}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifiers: batch.map((p) => ({ set: p.set, collector_number: p.collectorNumber }))
      })
    })
    if (isScryfallError(body)) return body
    const data = (body as { data?: unknown[] })?.data ?? []
    const missing = (body as { not_found?: { set?: string; collector_number?: string }[] })?.not_found ?? []
    results.push(...data)
    notFound.push(...missing.filter((m) => m.set && m.collector_number).map((m) => `${m.set}/${m.collector_number}`))
    onProgress?.(Math.min(i + COLLECTION_BATCH_SIZE, uniquePairs.length), uniquePairs.length)
  }

  const byKey = new Map(
    results.map((c) => [key({ set: (c as { set: string }).set, collectorNumber: (c as { collector_number: string }).collector_number }), c])
  )
  return {
    object: 'list',
    data: pairs.map((p) => byKey.get(key(p))).filter(Boolean),
    not_found: notFound
  }
}

/** Batch-resolves card names to full card objects (their most-recent printing, same as
 *  Scryfall's own name-based collection lookup) — one or two heavy-throttled calls total for
 *  an entire decklist import, instead of one search per card. Names that don't resolve come
 *  back in `not_found` so the caller can report exactly which lines of a pasted list failed. */
export async function getCardsByNames(names: string[]): Promise<unknown> {
  const uniqueNames = [...new Set(names)]
  const results: unknown[] = []
  const notFound: string[] = []

  for (let i = 0; i < uniqueNames.length; i += COLLECTION_BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + COLLECTION_BATCH_SIZE)
    const body = await getJson(`${API_BASE}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) })
    })
    if (isScryfallError(body)) return body
    const data = (body as { data?: unknown[] })?.data ?? []
    const missing = (body as { not_found?: { name?: string }[] })?.not_found ?? []
    results.push(...data)
    notFound.push(...missing.map((m) => m.name).filter((n): n is string => Boolean(n)))
  }

  return { object: 'list', data: results, not_found: notFound }
}

// Used for card-relative links Scryfall itself hands back (prints_search_uri, rulings_uri,
// next_page, etc). Restricted to api.scryfall.com so the renderer can't be tricked into
// making the main process fetch an arbitrary host.
export async function fetchScryfallUrl(url: string): Promise<unknown> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: true, status: 400, details: 'Invalid URL' } as ScryfallError
  }
  if (parsed.hostname !== 'api.scryfall.com') {
    return { error: true, status: 400, details: 'URL must be on api.scryfall.com' } as ScryfallError
  }
  return getJson(parsed.toString())
}
