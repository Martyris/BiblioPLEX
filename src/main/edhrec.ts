// EDHREC has no official API. This scrapes the same JSON blob (__NEXT_DATA__) that their
// own Next.js frontend renders from — confirmed by inspecting a live commander page. It's
// undocumented and could break if EDHREC changes their frontend, so every step here fails
// soft into an EdhrecError rather than throwing.
const USER_AGENT = 'BiblioPLEX/0.1 (https://github.com/; local dev build)'
const MIN_INTERVAL_MS = 500 // polite pacing for an unofficial, undocumented source

let lastRequestAt = 0
// A promise chain, not a boolean: each call appends itself and awaits its predecessor, so
// concurrent callers are strictly serialized. Without this, two calls can both read the same
// stale `lastRequestAt` before either updates it and fire back-to-back — the same race that
// let this app blow through Scryfall's rate limit despite a throttle being in place there.
let chain: Promise<void> = Promise.resolve()

async function throttledFetch(url: string): Promise<Response> {
  const previousTurn = chain
  let release!: () => void
  const ourTurn = new Promise<void>((resolve) => {
    release = resolve
  })
  chain = ourTurn

  await previousTurn
  try {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt = Date.now()
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000)
    })
  } finally {
    release()
  }
}

export interface EdhrecError {
  error: true
  status: number
  details: string
}

export interface EdhrecCardEntry {
  id: string
  name: string
  synergy: number
  num_decks: number
  potential_decks: number
}

export interface EdhrecCardList {
  tag: string
  header: string
  cards: EdhrecCardEntry[]
}

export interface EdhrecTag {
  slug: string
  value: string
  count: number
}

export interface EdhrecCommanderData {
  name: string
  num_decks: number
  rank: number | null
  cardlists: EdhrecCardList[]
  tags: EdhrecTag[]
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // EDHREC drops apostrophes outright rather than treating them as a word separator —
    // "Y'shtola, Night's Blessed" -> "yshtola-nights-blessed", NOT "y-shtola-night-s-blessed"
    // (confirmed by hand against edhrec.com). Falling through to the general non-alnum-to-"-"
    // rule below without this first is why every possessive/contraction commander name (Yshtola,
    // Yuriko, Sephiroth Planet's Heir, ...) 404'd — this was a real, reported bug, not a guess.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// MDFC/split/adventure cards carry a combined "Front // Back" name at the top level (Scryfall's
// own `name` field) — EDHREC only ever has a page for the front (commander-legal) face, never
// the combined string or the back face alone. Plain single-faced names pass through unchanged.
function frontFaceName(name: string): string {
  return name.split(' // ')[0]
}

function toEdhrecError(err: unknown): EdhrecError {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[edhrec] request failed:', message)
  return { error: true, status: 0, details: message }
}

// Pages barely change intra-session; cache to avoid re-hitting an unofficial endpoint
// every time the user reopens the same page.
const cache = new Map<string, { data: unknown; at: number }>()
const CACHE_TTL_MS = 30 * 60 * 1000

interface RawCardview {
  id: string
  name: string
  synergy?: number
  num_decks?: number
  potential_decks?: number
  rank?: number
}

interface RawCardlist {
  tag: string
  header: string
  cardviews?: RawCardview[]
}

/** Fetches an EDHREC page and pulls out its embedded __NEXT_DATA__ JSON blob. */
async function fetchNextData(url: string): Promise<Record<string, unknown> | EdhrecError> {
  const res = await throttledFetch(url)

  if (res.status === 404) {
    return { error: true, status: 404, details: 'Page not found on EDHREC' }
  }
  if (!res.ok) {
    return { error: true, status: res.status, details: `EDHREC returned ${res.status}` }
  }

  const html = await res.text()
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
  if (!match) {
    return { error: true, status: 0, details: 'Could not parse EDHREC page (its layout may have changed)' }
  }

  return JSON.parse(match[1])
}

function isEdhrecError(x: unknown): x is EdhrecError {
  return typeof x === 'object' && x !== null && (x as { error?: unknown }).error === true
}

export async function getCommanderData(
  cardName: string,
  tagSlug?: string
): Promise<EdhrecCommanderData | EdhrecError> {
  const slug = slugify(frontFaceName(cardName))
  const cacheKey = `commander:${slug}:${tagSlug ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data as EdhrecCommanderData | EdhrecError
  }

  try {
    const url = tagSlug
      ? `https://edhrec.com/commanders/${slug}/${encodeURIComponent(tagSlug)}`
      : `https://edhrec.com/commanders/${slug}`
    const parsed = await fetchNextData(url)
    if (isEdhrecError(parsed)) {
      const result: EdhrecError =
        parsed.status === 404 ? { ...parsed, details: 'No EDHREC page found for this commander' } : parsed
      cache.set(cacheKey, { data: result, at: Date.now() })
      return result
    }

    const pageData = (parsed as { props?: { pageProps?: { data?: Record<string, unknown> } } })?.props?.pageProps
      ?.data
    const jsonDict = pageData?.container as
      | { json_dict?: { cardlists?: RawCardlist[]; card?: { name?: string; num_decks?: number; rank?: number } } }
      | undefined
    const cardlistsSource = jsonDict?.json_dict
    if (!cardlistsSource) {
      return { error: true, status: 0, details: 'Unexpected EDHREC data shape' }
    }

    const rawLists: RawCardlist[] = cardlistsSource.cardlists ?? []
    const potentialDecks: number = cardlistsSource.card?.num_decks ?? 0

    const cardlists: EdhrecCardList[] = rawLists
      .filter((l) => Array.isArray(l.cardviews) && l.cardviews.length > 0)
      .map((l) => ({
        tag: l.tag,
        header: l.header,
        cards: (l.cardviews ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          synergy: c.synergy ?? 0,
          num_decks: c.num_decks ?? 0,
          potential_decks: c.potential_decks ?? potentialDecks
        }))
      }))

    const rawTags = (pageData?.panels as { taglinks?: EdhrecTag[] } | undefined)?.taglinks ?? []

    const result: EdhrecCommanderData = {
      name: cardlistsSource.card?.name ?? cardName,
      num_decks: cardlistsSource.card?.num_decks ?? 0,
      rank: cardlistsSource.card?.rank ?? null,
      cardlists,
      tags: rawTags.map((t) => ({ slug: t.slug, value: t.value, count: t.count }))
    }

    cache.set(cacheKey, { data: result, at: Date.now() })
    return result
  } catch (err) {
    return toEdhrecError(err)
  }
}

export interface CommanderTagIndex {
  tags: EdhrecTag[]
  // printing id (as EDHREC references it) -> tag slugs that card appears under for this commander
  cardTags: Record<string, string[]>
}

// Building the full index means fetching every one of the commander's tag-filtered pages —
// expensive against an unofficial, rate-limited-by-etiquette source, so it's bounded and
// cached for a long time. The renderer resolves these ids to oracle ids itself (so the
// index stays valid across printing swaps).
const MAX_INDEXED_TAGS = 30
const TAG_INDEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours — this is a heavy computation

export async function getCommanderTagIndex(cardName: string): Promise<CommanderTagIndex | EdhrecError> {
  const slug = slugify(frontFaceName(cardName))
  const cacheKey = `tagindex:${slug}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < TAG_INDEX_CACHE_TTL_MS) {
    return cached.data as CommanderTagIndex | EdhrecError
  }

  const base = await getCommanderData(cardName)
  if (isEdhrecError(base)) return base

  const topTags = [...base.tags].sort((a, b) => b.count - a.count).slice(0, MAX_INDEXED_TAGS)
  const cardTags: Record<string, Set<string>> = {}

  for (const tag of topTags) {
    const tagged = await getCommanderData(cardName, tag.slug)
    if (isEdhrecError(tagged)) continue
    for (const list of tagged.cardlists) {
      for (const card of list.cards) {
        if (!cardTags[card.id]) cardTags[card.id] = new Set()
        cardTags[card.id].add(tag.slug)
      }
    }
  }

  const result: CommanderTagIndex = {
    tags: base.tags,
    cardTags: Object.fromEntries(Object.entries(cardTags).map(([id, set]) => [id, [...set]]))
  }

  cache.set(cacheKey, { data: result, at: Date.now() })
  return result
}

export interface EdhrecPreconCatalogEntry {
  // EDHREC's own URL slug for this specific precon's detail page (/precon/<slug>) — this is
  // the stable identifier for a precon, since the same set can bundle several (e.g. Marvel
  // Super Heroes Commander's four decks all share set code "msc").
  slug: string
  label: string
  setCode: string
  setHeader: string
}

/** The full historical catalog (2011-present) of Commander precons, grouped by set on
 *  EDHREC's own precon index page — one entry per precon, not per set, since a set can bundle
 *  several. Doesn't include per-card data; call getPreconDeckDetail(slug) for that. */
export async function getPreconCatalog(): Promise<EdhrecPreconCatalogEntry[] | EdhrecError> {
  const cacheKey = 'precon-catalog'
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data as EdhrecPreconCatalogEntry[] | EdhrecError
  }

  try {
    const parsed = await fetchNextData('https://edhrec.com/precon')
    if (isEdhrecError(parsed)) return parsed

    const lists = (
      parsed as {
        props?: { pageProps?: { data?: { container?: { json_dict?: { cardlists?: RawCardlist[] } } } } }
      }
    )?.props?.pageProps?.data?.container?.json_dict?.cardlists
    if (!lists) return { error: true, status: 0, details: 'Unexpected EDHREC precon catalog shape' }

    const entries: EdhrecPreconCatalogEntry[] = []
    for (const list of lists) {
      for (const view of list.cardviews ?? []) {
        const raw = view as RawCardview & { url?: string; label?: string; set?: string }
        if (!raw.url || !raw.label || !raw.set) continue
        const slug = raw.url.replace(/^\/precon\//, '')
        entries.push({ slug, label: raw.label, setCode: raw.set, setHeader: list.header })
      }
    }

    cache.set(cacheKey, { data: entries, at: Date.now() })
    return entries
  } catch (err) {
    return toEdhrecError(err)
  }
}

// [name, quantity, set code, collector number] — EDHREC's own compact tuple shape for a
// precon's decklist entries, already carrying the exact printing each precon actually ships.
export type EdhrecPreconCardTuple = [string, number, string, string]

export interface EdhrecPreconDeck {
  commanderNames: string[]
  commanderPrints: EdhrecPreconCardTuple[]
  cardEntries: EdhrecPreconCardTuple[]
}

/** The exact decklist (every card's specific printing + quantity, commander included
 *  separately) for one precon, from its own EDHREC detail page. */
export async function getPreconDeckDetail(slug: string): Promise<EdhrecPreconDeck | EdhrecError> {
  const cacheKey = `precon-detail:${slug}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data as EdhrecPreconDeck | EdhrecError
  }

  try {
    const parsed = await fetchNextData(`https://edhrec.com/precon/${encodeURIComponent(slug)}`)
    if (isEdhrecError(parsed)) return parsed

    const deck = (
      parsed as {
        props?: {
          pageProps?: {
            data?: {
              deck?: {
                commander?: string[]
                commander_v2?: EdhrecPreconCardTuple[]
                cards?: Record<string, EdhrecPreconCardTuple[]>
              }
            }
          }
        }
      }
    )?.props?.pageProps?.data?.deck
    if (!deck) return { error: true, status: 0, details: 'Unexpected EDHREC precon detail shape' }

    const cardEntries = Object.values(deck.cards ?? {}).flat()
    const result: EdhrecPreconDeck = {
      commanderNames: deck.commander ?? [],
      commanderPrints: deck.commander_v2 ?? [],
      cardEntries
    }

    cache.set(cacheKey, { data: result, at: Date.now() })
    return result
  } catch (err) {
    return toEdhrecError(err)
  }
}

export interface EdhrecTopCommander {
  id: string
  name: string
  num_decks: number
  rank: number
}

/** EDHREC's own "Top Commanders" ranking (past 2 years) — this is the authoritative
 *  popularity order, distinct from Scryfall's own (differently-computed) edhrec sort. */
export async function getTopCommanders(): Promise<EdhrecTopCommander[] | EdhrecError> {
  const cacheKey = 'top-commanders'
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data as EdhrecTopCommander[] | EdhrecError
  }

  try {
    const parsed = await fetchNextData('https://edhrec.com/commanders')
    if (isEdhrecError(parsed)) return parsed

    const lists = (parsed as { props?: { pageProps?: { data?: { container?: { json_dict?: { cardlists?: RawCardlist[] } } } } } })
      ?.props?.pageProps?.data?.container?.json_dict?.cardlists
    const cardviews = lists?.[0]?.cardviews ?? []

    const result: EdhrecTopCommander[] = cardviews.map((c, i) => ({
      id: c.id,
      name: c.name,
      num_decks: c.num_decks ?? 0,
      rank: c.rank ?? i + 1
    }))

    cache.set(cacheKey, { data: result, at: Date.now() })
    return result
  } catch (err) {
    return toEdhrecError(err)
  }
}
