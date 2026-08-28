// Crawls Commander Spellbook's full combo database and tallies which cards show up in a lot of
// distinct combos — powers the "Combo" functional tag (see cardTagging.ts/cardTagIndex.ts).
// There's no cheap way to ask Spellbook "how many combos is card X in" in bulk: the `/variants/`
// list's own `count` field is always null (confirmed against the live API), and sorting by
// `variantCount` on `/cards/` is silently ignored. So this pulls every combo variant once (paged
// 100 at a time — the server clamps any larger `limit`) and tallies oracle_id occurrences itself,
// same "one-time bulk crawl, cached to disk, manually refreshed" shape as precons.ts and
// cardTagIndex.ts.

import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'

const API_BASE = 'https://backend.commanderspellbook.com'
const PAGE_SIZE = 100
// Measured against the live API during development: a burst of concurrent requests gets a
// hard 429 after roughly 90-460 requests depending on how much quota was already used, and
// recovery takes 3-4 minutes once tripped. There's no documented rate limit and no
// Retry-After header — this interval (well under the ~1 req/s that reliably tripped it in
// testing) is a conservative guess, not a published number, so a real crawl also needs the
// retry-with-backoff below rather than assuming this alone is always enough headroom.
const REQUEST_INTERVAL_MS = 2000
// How long to wait before retrying a single page after a 429 — comfortably past the ~3-4
// minute recovery window observed in testing.
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
const MAX_RETRIES_PER_PAGE = 4

// Bump if the crawl/tally logic here changes what ends up in comboIndex.json.
const COMBO_INDEX_VERSION = 1

// A card showing up in at least this many distinct combo variants earns the "Combo" tag.
// Chosen by inspecting the real tally distribution from a full crawl (see the research this
// was built from) rather than picked arbitrarily — adjust here if it reads too loose/tight.
export const COMBO_TAG_THRESHOLD = 15

interface ComboIndexFile {
  builtAt: string
  version: number
  variantCount: number
  // oracle_id -> number of distinct combo variants that card participates in.
  counts: Record<string, number>
}

export interface ComboIndexStatus {
  builtAt: string | null
  variantCount: number
  // How many distinct oracle_ids meet COMBO_TAG_THRESHOLD — i.e. how many cards will actually
  // get tagged "Combo" the next time the card tag index is (re)built.
  comboCardCount: number
  stale: boolean
}

export interface ComboIndexBuildProgress {
  phase: 'idle' | 'crawling' | 'rate-limited' | 'done'
  current: number
  // Stays 0 (unknown) until the crawl hits the last page — the API never reports a real total,
  // so there's nothing better to show early on than a growing page count.
  total: number
}

let memoryFile: ComboIndexFile | null = null
let buildProgress: ComboIndexBuildProgress = { phase: 'idle', current: 0, total: 0 }
let cancelRequested = false

/** Best-effort cancel for an in-flight buildComboIndex() call — checked between pages and
 *  during rate-limit backoffs (see sleepCancellable), so it takes effect within a couple
 *  seconds rather than waiting out a multi-minute backoff. A cancelled crawl abandons its
 *  partial tally rather than writing it — the on-disk index is left exactly as it was. */
export function cancelComboIndexBuild(): void {
  cancelRequested = true
}

function comboIndexPath(): string {
  return join(app.getPath('userData'), 'comboIndex.json')
}

// A pre-built snapshot shipped with the app itself (see package.json's build.extraResources) —
// same reasoning and dev/packaged dual-path resolution as cardTagIndex.ts's bundledIndexPath():
// a fresh install gets "Combo" tags immediately instead of requiring a 30-60+ minute Commander
// Spellbook crawl before the feature does anything. "Rebuild Combo Index" always writes to
// comboIndexPath() (real userData), which then takes over for good.
function bundledComboIndexPath(): string {
  const devPath = join(app.getAppPath(), 'resources', 'combo-index', 'comboIndex.json')
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath ?? '', 'combo-index', 'comboIndex.json')
}

async function loadFile(): Promise<ComboIndexFile | null> {
  if (memoryFile) return memoryFile
  try {
    const raw = await readFile(comboIndexPath(), 'utf-8')
    memoryFile = JSON.parse(raw) as ComboIndexFile
    return memoryFile
  } catch {
    // No userData index yet — fall through to the bundled seed below.
  }
  try {
    const raw = await readFile(bundledComboIndexPath(), 'utf-8')
    memoryFile = JSON.parse(raw) as ComboIndexFile
  } catch {
    memoryFile = null
  }
  return memoryFile
}

function countComboCards(counts: Record<string, number>): number {
  return Object.values(counts).filter((c) => c >= COMBO_TAG_THRESHOLD).length
}

export async function getComboIndexStatus(): Promise<ComboIndexStatus> {
  const file = await loadFile()
  return {
    builtAt: file?.builtAt ?? null,
    variantCount: file?.variantCount ?? 0,
    comboCardCount: file ? countComboCards(file.counts) : 0,
    stale: file !== null && (file.version ?? 0) < COMBO_INDEX_VERSION
  }
}

export function getComboIndexBuildProgress(): ComboIndexBuildProgress {
  return buildProgress
}

/** The set of oracle_ids that meet COMBO_TAG_THRESHOLD — consumed by cardTagIndex.ts's build to
 *  add a "Combo" tag to matching cards, and exposed to the renderer (via IPC) so a single card's
 *  live tag display (CardTagsPanel etc.) can show "Combo" even for cards outside the bulk index.
 *  Empty until the index has actually been built once. */
export async function getComboHeavyOracleIds(): Promise<string[]> {
  const file = await loadFile()
  if (!file) return []
  return Object.entries(file.counts)
    .filter(([, c]) => c >= COMBO_TAG_THRESHOLD)
    .map(([id]) => id)
}

interface RawVariant {
  uses?: { card?: { oracleId?: string } }[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Sleeps in short slices so a cancel request lands within ~250ms instead of being stuck behind
// a full RATE_LIMIT_BACKOFF_MS (up to 5 minutes) wait.
async function sleepCancellable(ms: number): Promise<void> {
  const step = 250
  let waited = 0
  while (waited < ms && !cancelRequested) {
    await sleep(Math.min(step, ms - waited))
    waited += step
  }
}

/** Fetches one page, retrying through 429s with a long backoff (see RATE_LIMIT_BACKOFF_MS)
 *  instead of treating a rate limit as fatal — a multi-thousand-page crawl against an
 *  undocumented, unauthenticated limit is expected to trip it occasionally, and losing the
 *  entire crawl's progress over one transient 429 would make this feature unusable. Returns an
 *  empty page if cancelled mid-fetch/backoff — the caller distinguishes "cancelled" from "end
 *  of data" by checking cancelRequested itself right after this returns. */
async function fetchVariantsPageWithRetry(offset: number, processedSoFar: number): Promise<RawVariant[]> {
  for (let attempt = 0; ; attempt++) {
    if (cancelRequested) return []
    const res = await fetch(`${API_BASE}/variants/?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Accept: 'application/json' }
    })
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES_PER_PAGE) {
        throw new Error(`Commander Spellbook kept rate-limiting us at offset ${offset} after ${attempt} retries`)
      }
      buildProgress = { phase: 'rate-limited', current: processedSoFar, total: 0 }
      await sleepCancellable(RATE_LIMIT_BACKOFF_MS)
      continue
    }
    if (!res.ok) throw new Error(`Commander Spellbook returned HTTP ${res.status} at offset ${offset}`)
    const json = (await res.json()) as { results?: RawVariant[] }
    return json.results ?? []
  }
}

/** One-time (or manually re-triggered) full crawl of every combo Commander Spellbook knows
 *  about. Deliberately sequential (one page at a time, paced by REQUEST_INTERVAL_MS) rather
 *  than concurrent — see that constant's comment for why. A page coming back empty is what
 *  marks the end of the list (the API never reports a real total), and this can easily run
 *  30-60+ minutes end to end once the rate-limit pacing and any 429 backoffs are counted; it's
 *  meant to be started and left running, not watched. */
export async function buildComboIndex(): Promise<ComboIndexStatus> {
  cancelRequested = false
  buildProgress = { phase: 'crawling', current: 0, total: 0 }
  let processedPages = 0
  let variantCount = 0
  const tally = new Map<string, number>()
  let wasCancelled = false

  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (cancelRequested) {
        wasCancelled = true
        break
      }
      const requestedAt = Date.now()
      const page = await fetchVariantsPageWithRetry(offset, processedPages)
      if (cancelRequested) {
        wasCancelled = true
        break
      }
      if (page.length === 0) break

      for (const variant of page) {
        const seen = new Set<string>()
        for (const use of variant.uses ?? []) {
          const oracleId = use.card?.oracleId
          if (oracleId && !seen.has(oracleId)) {
            seen.add(oracleId)
            tally.set(oracleId, (tally.get(oracleId) ?? 0) + 1)
          }
        }
      }
      variantCount += page.length
      processedPages++
      buildProgress = { phase: 'crawling', current: processedPages, total: 0 }

      const elapsed = Date.now() - requestedAt
      if (elapsed < REQUEST_INTERVAL_MS) await sleepCancellable(REQUEST_INTERVAL_MS - elapsed)
    }
  } catch (err) {
    buildProgress = { phase: 'idle', current: 0, total: 0 }
    throw err
  }

  if (wasCancelled) {
    buildProgress = { phase: 'idle', current: 0, total: 0 }
    cancelRequested = false
    return getComboIndexStatus()
  }

  const counts: Record<string, number> = {}
  for (const [id, count] of tally) counts[id] = count

  const file: ComboIndexFile = {
    builtAt: new Date().toISOString(),
    version: COMBO_INDEX_VERSION,
    variantCount,
    counts
  }
  memoryFile = file
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(comboIndexPath(), JSON.stringify(file), 'utf-8')
  buildProgress = { phase: 'done', current: processedPages, total: processedPages }

  return { builtAt: file.builtAt, variantCount, comboCardCount: countComboCards(counts), stale: false }
}
