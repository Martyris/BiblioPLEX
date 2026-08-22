import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { gunzipSync } from 'zlib'
import { deriveCardTags, TAGGING_VERSION, type TaggableCard } from './cardTagging'
import { getAllCardTagOverrides } from './cardTagStore'

const USER_AGENT = 'BiblioPLEX/0.1 (https://github.com/; local dev build)'
const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data'

// Raw shape of an entry in Scryfall's "oracle_cards" bulk file — one record per unique
// oracle_id (already deduped across printings), same fields as the regular card API. Kept
// loose (index signature) since we store the whole thing back out verbatim plus a `tags`
// field, rather than re-typing Scryfall's entire card schema a third time in this codebase.
interface RawBulkCard extends TaggableCard {
  id: string
  oracle_id: string
  name: string
  layout: string
  set_type?: string
  games?: string[]
  promo_types?: string[]
  security_stamp?: string
  [key: string]: unknown
}

export interface IndexedCard extends RawBulkCard {
  tags: string[]
}

interface IndexFile {
  builtAt: string
  cards: IndexedCard[]
  // Precomputed at build time so the tag-autocomplete input doesn't have to scan every card
  // on each keystroke. Optional since an index built before this field existed won't have it —
  // getAllTagValues falls back to deriving it on the fly for those.
  allTags?: string[]
  // Tagging rules version this file was built under — missing entirely on files built before
  // this field existed, which counts as stale (version 0) same as any real mismatch.
  taggingVersion?: number
}

export interface IndexStatus {
  builtAt: string | null
  count: number
  // True when the on-disk index predates the current tagging rules (or never existed) — lets
  // callers decide whether an automatic refresh is worth doing.
  stale: boolean
}

let memoryIndex: IndexFile | null = null

function indexPath(): string {
  return join(app.getPath('userData'), 'cardTagIndex.json')
}

// Mirrors src/renderer/src/queryBuilder.ts's BASE_EXCLUSION_TERMS + EXCLUDE_TOKENS_TERM
// (paper only, no art series/front cards/joke sets/tokens) — approximated here from bulk
// data's own fields rather than Scryfall query syntax, since this runs against raw JSON, not
// a live search. Scryfall's own `is:funny` (which -is:funny relies on) is broader than just
// set_type === 'funny' — it also catches playtest cards (e.g. "You Compleat Me", set_type
// "masters", promo_types: ["playtest"]) and acorn-security-stamped cards embedded in
// otherwise-normal sets. Verified against the live search API that -is:funny excludes both.
function passesExclusions(card: RawBulkCard): boolean {
  if (!card.games?.includes('paper')) return false
  if (['art_series', 'front_card', 'token', 'double_faced_token', 'emblem'].includes(card.layout)) return false
  if (card.set_type === 'funny') return false
  if (card.promo_types?.includes('playtest')) return false
  if (card.security_stamp === 'acorn') return false
  return true
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`)
  return res.json()
}

// Scryfall's bulk card files are JSON Lines (one card object per line) inside a real gzip
// file — the response has Content-Type: application/gzip with no Content-Encoding header, so
// fetch does NOT auto-decompress it; this has to gunzip the body manually before parsing.
async function fetchJsonLines(url: string): Promise<RawBulkCard[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/gzip' }
  })
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`)
  const compressed = Buffer.from(await res.arrayBuffer())
  const text = gunzipSync(compressed).toString('utf-8')
  const cards: RawBulkCard[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    cards.push(JSON.parse(trimmed) as RawBulkCard)
  }
  return cards
}

async function loadIndex(): Promise<IndexFile | null> {
  if (memoryIndex) return memoryIndex
  try {
    const raw = await readFile(indexPath(), 'utf-8')
    memoryIndex = JSON.parse(raw) as IndexFile
  } catch {
    memoryIndex = null
  }
  return memoryIndex
}

export async function getCardTagIndexStatus(): Promise<IndexStatus> {
  const idx = await loadIndex()
  return {
    builtAt: idx?.builtAt ?? null,
    count: idx?.cards.length ?? 0,
    stale: idx !== null && (idx.taggingVersion ?? 0) < TAGGING_VERSION
  }
}

/** Called once per app session (see main/index.ts) — refreshes an already-built index that's
 *  gone stale from a tagging-rules change, silently and in the background. Deliberately does
 *  NOT build an index that doesn't exist yet at all; that first build is still the user's own
 *  "Build Card Tag Index" action, not something to trigger on their behalf unasked. */
export async function ensureCardTagIndexFresh(): Promise<IndexStatus> {
  const status = await getCardTagIndexStatus()
  if (!status.builtAt || !status.stale) return status
  return buildCardTagIndex()
}

/** One-time (or manually re-triggered) bulk pull of Scryfall's full oracle-card pool, tagged
 *  locally with the same rule engine used for individual cards. This is what makes "search by
 *  tag" cover the whole card pool instead of only cards already seen in some deck. */
export async function buildCardTagIndex(): Promise<IndexStatus> {
  const meta = (await fetchJson(BULK_DATA_URL)) as { data: { type: string; jsonl_download_uri: string }[] }
  const entry = meta.data.find((d) => d.type === 'oracle_cards')
  if (!entry) throw new Error('Scryfall bulk-data listing has no oracle_cards entry')

  const allCards = await fetchJsonLines(entry.jsonl_download_uri)

  const indexed: IndexedCard[] = []
  for (const card of allCards) {
    if (!passesExclusions(card)) continue
    const { keywordTags, functionalTags } = deriveCardTags(card)
    indexed.push({ ...card, tags: [...keywordTags, ...functionalTags] })
  }

  const allTags = [...new Set(indexed.flatMap((c) => c.tags))].sort()
  const file: IndexFile = {
    builtAt: new Date().toISOString(),
    cards: indexed,
    allTags,
    taggingVersion: TAGGING_VERSION
  }
  memoryIndex = file
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(indexPath(), JSON.stringify(file), 'utf-8')
  return { builtAt: file.builtAt, count: indexed.length, stale: false }
}

/** Every tag value that actually occurs in the index — powers the tag-search autocomplete. */
export async function getAllTagValues(): Promise<string[]> {
  const idx = await loadIndex()
  if (!idx) return []
  return idx.allTags ?? [...new Set(idx.cards.flatMap((c) => c.tags))].sort()
}

/** Cards matching every one of the given tags (AND, not OR — each added tag narrows the
 *  search), with manual overrides merged in at query time. */
export async function searchIndexedCardsByTags(tags: string[]): Promise<IndexedCard[]> {
  if (tags.length === 0) return []
  const idx = await loadIndex()
  if (!idx) return []
  const overrides = await getAllCardTagOverrides()

  return idx.cards.filter((card) => {
    const override = overrides[card.oracle_id]
    const finalTags = override
      ? new Set([...card.tags, ...override.added].filter((t) => !override.removed.includes(t)))
      : new Set(card.tags)
    return tags.every((t) => finalTags.has(t))
  })
}
