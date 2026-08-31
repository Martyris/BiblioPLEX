import { getMainLocale } from './localePreference'

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

// Most multi-faced layouts (transform, modal_dfc, adventure, split, flip, meld) still mirror
// the front face's summary fields at the top level (oracle_id, cmc, type_line, mana_cost,
// oracle_text, colors, power, toughness, image_uris) — every place in this app that reads
// `card.oracle_id`/`card.cmc`/etc. directly relies on that, the same way it would for any
// single-faced card. The one layout that doesn't is "reversible_card" (a bonus alternate-art
// back treatment, not a second real game object — e.g. Tarkir: Dragonstorm's showcase prints):
// Scryfall omits ALL of those top-level fields for it, and a missing oracle_id in particular
// reached code (both here and in the renderer) that assumes it's always a string, crashing the
// app outright the moment a deck held one of these printings — see the bug report: picking
// Marang River Regent // Coil and Catch's reversible printing broke the app for good until
// decks.json was hand-edited. Backfilling from card_faces[0] here, in the one place every card
// object passes through on its way from Scryfall, means nothing downstream needs to know this
// layout is unusual at all.
const FACE_BACKFILL_FIELDS = [
  'oracle_id',
  'cmc',
  'type_line',
  'mana_cost',
  'oracle_text',
  'colors',
  'power',
  'toughness',
  'image_uris'
] as const

export function normalizeCard(card: Record<string, unknown>): Record<string, unknown> {
  const faces = card.card_faces
  if (!Array.isArray(faces) || faces.length === 0 || typeof faces[0] !== 'object' || faces[0] === null) return card
  const front = faces[0] as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  let changed = false
  for (const field of FACE_BACKFILL_FIELDS) {
    if (card[field] === undefined && front[field] !== undefined) {
      patch[field] = front[field]
      changed = true
    }
  }
  return changed ? { ...card, ...patch } : card
}

// Applied to every response body this file returns — cheap to check and a no-op for anything
// that isn't card-shaped (catalogs, rulings lists, sets), since only objects with a real
// `card_faces` array ever get touched.
function normalizeCardData(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const obj = body as Record<string, unknown>
  if (obj.object === 'list' && Array.isArray(obj.data)) {
    return {
      ...obj,
      data: obj.data.map((c) => (c && typeof c === 'object' && 'card_faces' in c ? normalizeCard(c as Record<string, unknown>) : c))
    }
  }
  if ('card_faces' in obj) return normalizeCard(obj)
  return body
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await throttledFetch(url, init)
    const body = await res.json()

    if (!res.ok) {
      return { error: true, status: res.status, details: body?.details ?? 'Unknown error' } as ScryfallError
    }
    return normalizeCardData(body)
  } catch (err) {
    return toScryfallError(err)
  }
}

function isScryfallError(x: unknown): x is ScryfallError {
  return typeof x === 'object' && x !== null && (x as { error?: unknown }).error === true
}

// When the renderer's locale is pt-BR (see localePreference.ts), card-fetching functions below
// swap in the Portuguese printing's *presentation* fields only — image_uris (or per-face for
// double-faced cards) and printed_name. Gameplay fields (oracle text, type_line, mana_cost,
// legalities, and crucially the English oracle `name` itself, which cardTagging.ts's regex
// rules and singleton/basic-land matching depend on) are deliberately left untouched — this is
// a display-language substitution, not a data-language switch. A printing without a Portuguese
// version (most of Magic's back catalog) just silently falls back to the English art/name.
interface LocalizableCard {
  set?: string
  collector_number?: string
  image_uris?: unknown
  printed_name?: string
  card_faces?: { image_uris?: unknown; printed_name?: string }[]
}

// Keyed by "<set>/<collector_number>" — null means "confirmed no Portuguese printing exists",
// cached the same as a hit so a whole deck of untranslated older cards doesn't re-hit the
// network on every subsequent open.
const ptPrintingCache = new Map<string, LocalizableCard | null>()

async function getPortuguesePrinting(set: string, collectorNumber: string): Promise<LocalizableCard | null> {
  const key = `${set}/${collectorNumber}`
  if (ptPrintingCache.has(key)) return ptPrintingCache.get(key) ?? null

  const result = await getJson(`${API_BASE}/cards/${encodeURIComponent(set)}/${encodeURIComponent(collectorNumber)}/pt`)
  const printing = isScryfallError(result) ? null : (result as LocalizableCard)
  ptPrintingCache.set(key, printing)
  return printing
}

async function localizeCard<T extends LocalizableCard>(card: T): Promise<T> {
  if (getMainLocale() !== 'pt-BR' || !card?.set || !card.collector_number) return card
  const pt = await getPortuguesePrinting(card.set, card.collector_number)
  if (!pt) return card

  if (card.card_faces && pt.card_faces) {
    return {
      ...card,
      card_faces: card.card_faces.map((face, i) => ({
        ...face,
        image_uris: pt.card_faces?.[i]?.image_uris ?? face.image_uris,
        printed_name: pt.card_faces?.[i]?.printed_name ?? face.printed_name
      }))
    }
  }
  return { ...card, image_uris: pt.image_uris ?? card.image_uris, printed_name: pt.printed_name ?? card.printed_name }
}

// On-demand, single-card localized art lookup — used by CardDetail when it opens a card while
// pt-BR is active. Bulk list/grid functions (search, deck grids, precon lists) deliberately
// don't call this per-card: at Scryfall's rate limit, one extra request per card turns loading
// a 99-card deck or the ~300-commander Precons list into a many-second stall (this is exactly
// what got reported as "loading cards and precons seems to be getting stuck" — that regression
// is why bulk localization was pulled back out). A single CardDetail open only ever pays for
// one extra request, so it stays instant while still surfacing Portuguese art where it exists.
export async function getLocalizedCardArt(set: string, collectorNumber: string): Promise<unknown> {
  if (getMainLocale() !== 'pt-BR') return null
  return getPortuguesePrinting(set, collectorNumber)
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
  const result = await getJson(`${API_BASE}/cards/${encodeURIComponent(id)}`)
  return isScryfallError(result) ? result : localizeCard(result as LocalizableCard)
}

// Scryfall's plain-text search only matches the English oracle name — a foreign printed name
// (e.g. "Blitzschlag" for Lightning Bolt) 404s there even though Scryfall does track it. The
// fuzzy-named endpoint resolves it correctly, so this is the fallback path for foreign-name
// search rather than a change to searchCards itself.
export async function getCardByFuzzyName(name: string): Promise<unknown> {
  const result = await getJson(`${API_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`)
  return isScryfallError(result) ? result : localizeCard(result as LocalizableCard)
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

// The base card types (Artifact, Creature, ...) and supertypes (Legendary, Basic, ...) are a
// small, fixed set with no dedicated Scryfall catalog endpoint — listed here verbatim from the
// comprehensive rules rather than invented. Everything below the em dash on a type line (Elf,
// Equipment, Forest, Aura, Adventure, ...) DOES have real catalogs, one per broad card type.
const BASE_CARD_TYPES = [
  'Artifact',
  'Battle',
  'Conspiracy',
  'Creature',
  'Enchantment',
  'Instant',
  'Kindred',
  'Land',
  'Phenomenon',
  'Plane',
  'Planeswalker',
  'Scheme',
  'Sorcery',
  'Vanguard'
]
const SUPERTYPES = ['Basic', 'Elite', 'Host', 'Legendary', 'Ongoing', 'Snow', 'World']
const SUBTYPE_CATALOGS = [
  'artifact-types',
  'creature-types',
  'enchantment-types',
  'land-types',
  'planeswalker-types',
  'spell-types'
]

// Same one-fetch-per-app-run caching as the name catalog above — merges every type/subtype
// catalog Scryfall has into one flat, deduped list for TypeAutocomplete (types + subtypes are
// searched the same way, since Scryfall's own t: operator treats a type line as just one bag of
// words with no type/subtype distinction in the query itself).
let cardTypeCatalogCache: string[] | null = null

export async function getCardTypeCatalog(): Promise<unknown> {
  if (cardTypeCatalogCache) return { object: 'catalog', data: cardTypeCatalogCache }

  const results = await Promise.all(SUBTYPE_CATALOGS.map((name) => getJson(`${API_BASE}/catalog/${name}`)))
  const failed = results.find(isScryfallError)
  if (failed) return failed

  const subtypes = results.flatMap((r) => (r as { data?: string[] }).data ?? [])
  cardTypeCatalogCache = [...new Set([...BASE_CARD_TYPES, ...SUPERTYPES, ...subtypes])].sort()
  return { object: 'catalog', data: cardTypeCatalogCache }
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
