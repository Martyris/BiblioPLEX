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
