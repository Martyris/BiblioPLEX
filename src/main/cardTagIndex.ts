import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { gunzipSync } from 'zlib'
import { deriveCardTags, isManaOnlyAbilityLand, TAGGING_VERSION, type TaggableCard } from './cardTagging'
import { getAllCardTagOverrides } from './cardTagStore'
import { getComboHeavyOracleIds, getComboIndexStatus } from './comboIndex'
import { getAllTaggerCardData, TAGGER_INTEGRATION_VERSION } from './tagIndex'
import { normalizeCard } from './scryfall'

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
  // Snapshot of the combo index's own builtAt at the time this file was built — "Combo" tags
  // come from a separate crawl (comboIndex.ts), not from any regex rule, so a taggingVersion
  // bump alone can't detect "the combo data changed since this file was last built." Missing
  // entirely (built before this field existed) counts as stale whenever a combo index exists.
  comboIndexBuiltAt?: string | null
  // Scryfall Tagger integration version this file was built under — same idea as
  // taggingVersion, but for tagIndex.ts's own rollup/mapping logic rather than the regex rules.
  // Missing entirely (every index built before this field existed) counts as stale, same as any
  // real mismatch — those files were built with regex tags only, before Tagger was wired in.
  taggerIntegrationVersion?: number
}

export interface IndexStatus {
  builtAt: string | null
  count: number
  // True when the on-disk index predates the current tagging rules (or never existed) — lets
  // callers decide whether an automatic refresh is worth doing.
  stale: boolean
}

export interface CardTagIndexBuildProgress {
  phase: 'idle' | 'fetching' | 'tagging' | 'done'
  current: number
  // 0 during 'fetching' (no byte-level progress is tracked for the bulk download) and during
  // 'idle'/'done' — only meaningful once 'tagging' starts, where it's the full card count.
  total: number
}

let memoryIndex: IndexFile | null = null
let buildProgress: CardTagIndexBuildProgress = { phase: 'idle', current: 0, total: 0 }
let buildAbortController: AbortController | null = null
let cancelRequested = false

export function getCardTagIndexBuildProgress(): CardTagIndexBuildProgress {
  return buildProgress
}

/** Best-effort cancel for an in-flight buildCardTagIndex() call — aborts the bulk-data fetch
 *  immediately if still downloading, or stops the per-card tagging loop at its next yield
 *  point otherwise. Either way the on-disk index is left untouched (a cancelled build never
 *  writes a file), and the returned status just reflects whatever was already there. */
export function cancelCardTagIndexBuild(): void {
  cancelRequested = true
  buildAbortController?.abort()
}

function indexPath(): string {
  return join(app.getPath('userData'), 'cardTagIndex.json')
}

// A pre-built snapshot shipped with the app itself (see package.json's build.extraResources),
// so a fresh install has Tag Search working immediately instead of forcing every new user
// through a multi-minute Scryfall bulk-data crawl before the feature is usable at all. Same
// dev/packaged dual-path resolution as tagIndex.ts's dataDir() for the Tagger scrape data.
// "Rebuild Index" always writes to indexPath() (real userData), which then takes over for good
// — this bundled copy is only ever consulted when no userData index exists yet.
function bundledIndexPath(): string {
  const devPath = join(app.getAppPath(), 'resources', 'card-tag-index', 'cardTagIndex.json')
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath ?? '', 'card-tag-index', 'cardTagIndex.json')
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

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal
  })
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`)
  return res.json()
}

// Scryfall's bulk card files are JSON Lines (one card object per line) inside a real gzip
// file — the response has Content-Type: application/gzip with no Content-Encoding header, so
// fetch does NOT auto-decompress it; this has to gunzip the body manually before parsing.
async function fetchJsonLines(url: string, signal?: AbortSignal): Promise<RawBulkCard[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/gzip' },
    signal
  })
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`)
  const compressed = Buffer.from(await res.arrayBuffer())
  const text = gunzipSync(compressed).toString('utf-8')
  const cards: RawBulkCard[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Same backfill as scryfall.ts's getJson — the bulk oracle_cards dump can in principle pick
    // a "reversible_card"-layout printing as an oracle id's canonical entry, which (unlike every
    // other multi-faced layout) omits top-level oracle_id/cmc/type_line/etc. entirely. The loop
    // below reads card.type_line directly with no fallback, so an unnormalized one would crash
    // the whole bulk build partway through rather than just mis-tagging one card.
    cards.push(normalizeCard(JSON.parse(trimmed) as Record<string, unknown>) as RawBulkCard)
  }
  return cards
}

async function loadIndex(): Promise<IndexFile | null> {
  if (memoryIndex) return memoryIndex
  try {
    const raw = await readFile(indexPath(), 'utf-8')
    memoryIndex = JSON.parse(raw) as IndexFile
    return memoryIndex
  } catch {
    // No userData index yet — fall through to the bundled seed below.
  }
  try {
    const raw = await readFile(bundledIndexPath(), 'utf-8')
    memoryIndex = JSON.parse(raw) as IndexFile
  } catch {
    memoryIndex = null
  }
  return memoryIndex
}

export async function getCardTagIndexStatus(): Promise<IndexStatus> {
  const idx = await loadIndex()
  const comboStatus = await getComboIndexStatus()
  const comboOutOfDate = idx !== null && comboStatus.builtAt !== null && idx.comboIndexBuiltAt !== comboStatus.builtAt
  return {
    builtAt: idx?.builtAt ?? null,
    count: idx?.cards.length ?? 0,
    stale:
      idx !== null &&
      ((idx.taggingVersion ?? 0) < TAGGING_VERSION || (idx.taggerIntegrationVersion ?? 0) < TAGGER_INTEGRATION_VERSION || comboOutOfDate)
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
  cancelRequested = false
  buildAbortController = new AbortController()
  buildProgress = { phase: 'fetching', current: 0, total: 0 }

  try {
    const meta = (await fetchJson(BULK_DATA_URL, buildAbortController.signal)) as {
      data: { type: string; jsonl_download_uri: string }[]
    }
    const entry = meta.data.find((d) => d.type === 'oracle_cards')
    if (!entry) throw new Error('Scryfall bulk-data listing has no oracle_cards entry')

    const allCards = await fetchJsonLines(entry.jsonl_download_uri, buildAbortController.signal)
    const comboHeavyIds = new Set(await getComboHeavyOracleIds())
    const comboStatus = await getComboIndexStatus()
    // Scryfall Tagger's community-tagged data (see tagIndex.ts) is the primary source now —
    // real volunteer-vetted tags beat oracle-text regex guessing. The regex tagger only fills
    // in for cards Tagger hasn't gotten to yet (new sets especially), so a card's tag set
    // always comes from exactly one source, never a blend of both.
    const taggerData = await getAllTaggerCardData()

    buildProgress = { phase: 'tagging', current: 0, total: allCards.length }
    const indexed: IndexedCard[] = []
    for (let i = 0; i < allCards.length; i++) {
      const card = allCards[i]
      if (passesExclusions(card)) {
        // Basic lands get no automatic tags at all — same reasoning as cardTagging.ts's
        // autoTagsFor: a Forest is a Forest, not "Cycle"/"Fixing"/whatever else Tagger or the
        // regex fallback happens to notice, and every deck running basics was drowning real
        // Tag Search results in this noise.
        let tags: string[] = []
        // Snow-Covered basics print as "Basic Snow Land" (Snow sits between Basic and Land as
        // its own supertype) — matches deckLogic.ts's isBasicLand on the renderer side, which
        // needs the same OR for the same reason.
        if (!card.type_line.includes('Basic Land') && !card.type_line.includes('Basic Snow Land')) {
          const tagger = taggerData[card.oracle_id]
          if (tagger) {
            tags = [...new Set([...tagger.specific.map((t) => t.label), ...tagger.rollup.map((t) => t.label)])]
            // A land whose only activated ability(ies) do nothing but produce mana doesn't earn
            // "Activated Ability" — Tagger's single largest, least useful tag otherwise, since
            // virtually every land has SOME kind of tap ability.
            if (isManaOnlyAbilityLand(card)) tags = tags.filter((t) => t !== 'Activated Ability')
          } else {
            const { keywordTags, functionalTags } = deriveCardTags(card)
            tags = [...keywordTags, ...functionalTags]
          }
        }
        if (comboHeavyIds.has(card.oracle_id)) tags.push('Combo')
        indexed.push({ ...card, tags })
      }

      // The tagging loop itself is synchronous and fast (tens of thousands of cards, no I/O
      // per card) — without an occasional yield it would run start-to-finish in one event-loop
      // tick, starving both progress polling and cancellation of any chance to be observed.
      if (i % 1000 === 999) {
        buildProgress = { phase: 'tagging', current: i + 1, total: allCards.length }
        await new Promise((resolve) => setImmediate(resolve))
        if (cancelRequested) {
          buildProgress = { phase: 'idle', current: 0, total: 0 }
          return getCardTagIndexStatus()
        }
      }
    }

    const allTags = [...new Set(indexed.flatMap((c) => c.tags))].sort()
    const file: IndexFile = {
      builtAt: new Date().toISOString(),
      cards: indexed,
      allTags,
      taggingVersion: TAGGING_VERSION,
      comboIndexBuiltAt: comboStatus.builtAt,
      taggerIntegrationVersion: TAGGER_INTEGRATION_VERSION
    }
    memoryIndex = file
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(indexPath(), JSON.stringify(file), 'utf-8')
    buildProgress = { phase: 'done', current: indexed.length, total: indexed.length }
    return { builtAt: file.builtAt, count: indexed.length, stale: false }
  } catch (err) {
    buildProgress = { phase: 'idle', current: 0, total: 0 }
    if (cancelRequested || (err instanceof Error && err.name === 'AbortError')) {
      cancelRequested = false
      return getCardTagIndexStatus()
    }
    throw err
  } finally {
    buildAbortController = null
  }
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
