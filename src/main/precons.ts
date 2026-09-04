import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getPreconCatalog, getPreconDeckDetail } from './edhrec'
import { getCardsBySetAndNumber, getSets } from './scryfall'

// Bump whenever the build logic itself changes what ends up in precons.json (not for comments)
// — an on-disk file built under an older version is treated as stale, same convention as
// cardTagging.ts's TAGGING_VERSION.
const PRECON_BUILD_VERSION = 1

export interface PreconDeck {
  // EDHREC's own slug for this precon (e.g. "avengers-assemble") — stable, and the one thing
  // that uniquely identifies a single precon even when several share one Scryfall set.
  id: string
  name: string
  setCode: string
  setHeader: string
  releasedAt: string | null
  commanderId: string
  commanderName: string
  partnerCommanderId: string | null
  partnerCommanderName: string | null
  cardIds: string[]
}

interface PreconFile {
  builtAt: string
  buildVersion: number
  decks: PreconDeck[]
  // Precons whose commander or decklist couldn't be resolved (EDHREC page missing, printing
  // not found on Scryfall, etc.) — kept for visibility rather than silently vanishing, per the
  // "skip rather than guess wrong" call for ambiguous cases.
  skipped: string[]
}

export interface PreconStatus {
  builtAt: string | null
  count: number
  skippedCount: number
  stale: boolean
}

export interface PreconBuildProgress {
  phase: 'idle' | 'catalog' | 'decks' | 'resolving' | 'done'
  current: number
  total: number
}

let memoryFile: PreconFile | null = null
let buildProgress: PreconBuildProgress = { phase: 'idle', current: 0, total: 0 }

function preconsPath(): string {
  return join(app.getPath('userData'), 'precons.json')
}

// A pre-built snapshot shipped with the app itself (see package.json's build.extraResources) —
// this was the one heavy index that DIDN'T already have this, unlike cardTagIndex.ts's own
// bundledIndexPath/comboIndex.ts's equivalent, so a fresh install had zero precons and no way
// to browse any until the user found and ran the several-minutes-long full build themselves (a
// real user hit exactly this). Same dev/packaged dual-path resolution as those two. "Check for
// New Precons" always writes to preconsPath() (real userData), which then takes over for good —
// this bundled copy is only ever consulted when no userData library exists yet, so it can go a
// little stale between app releases without being a problem: the incremental build tops it up
// with anything new to EDHREC's catalog in seconds, not minutes.
function bundledPreconsPath(): string {
  const devPath = join(app.getAppPath(), 'resources', 'precons', 'precons.json')
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath ?? '', 'precons', 'precons.json')
}

async function loadFile(): Promise<PreconFile | null> {
  if (memoryFile) return memoryFile
  try {
    const raw = await readFile(preconsPath(), 'utf-8')
    memoryFile = JSON.parse(raw) as PreconFile
    return memoryFile
  } catch {
    // No userData library yet — fall through to the bundled seed below.
  }
  try {
    const raw = await readFile(bundledPreconsPath(), 'utf-8')
    memoryFile = JSON.parse(raw) as PreconFile
  } catch {
    memoryFile = null
  }
  return memoryFile
}

export async function getPreconStatus(): Promise<PreconStatus> {
  const file = await loadFile()
  return {
    builtAt: file?.builtAt ?? null,
    count: file?.decks.length ?? 0,
    skippedCount: file?.skipped.length ?? 0,
    stale: file !== null && (file.buildVersion ?? 0) < PRECON_BUILD_VERSION
  }
}

export function getPreconBuildProgress(): PreconBuildProgress {
  return buildProgress
}

export async function listPrecons(): Promise<PreconDeck[]> {
  const file = await loadFile()
  return file?.decks ?? []
}

export async function getPrecon(id: string): Promise<PreconDeck | null> {
  const file = await loadFile()
  return file?.decks.find((d) => d.id === id) ?? null
}

/** Pulls every Commander precon EDHREC has ever catalogued, each resolved to its exact
 *  decklist (specific printings, correct basic-land counts) via that precon's own EDHREC
 *  detail page — not reconstructed from a Scryfall set search, which can't tell "this set
 *  bundles 4 different precons" apart or recover physical copy counts for a basic land that
 *  only got one unique printing.
 *
 *  Incremental: a precon already present in the saved library (from a prior build under the
 *  current PRECON_BUILD_VERSION) is reused as-is rather than re-fetched — only precons new to
 *  EDHREC's catalog (or ones that were previously skipped, since a retry may now succeed) get
 *  fetched. A version bump forces a full rebuild, same as a first-ever build. */
export async function buildPreconLibrary(): Promise<PreconStatus> {
  const existing = await loadFile()
  const reusable = existing && existing.buildVersion === PRECON_BUILD_VERSION ? existing : null
  const existingIds = new Set(reusable?.decks.map((d) => d.id) ?? [])

  buildProgress = { phase: 'catalog', current: 0, total: 0 }
  const catalog = await getPreconCatalog()
  if ('error' in catalog) {
    buildProgress = { phase: 'idle', current: 0, total: 0 }
    throw new Error(catalog.details)
  }

  const newEntries = catalog.filter((entry) => !existingIds.has(entry.slug))

  if (reusable && newEntries.length === 0) {
    buildProgress = { phase: 'done', current: 0, total: 0 }
    return { builtAt: reusable.builtAt, count: reusable.decks.length, skippedCount: reusable.skipped.length, stale: false }
  }

  // Release dates come from the sets list (one call) rather than per-precon — many precons
  // share a set, and a precon's own detail page doesn't carry a release date itself.
  const setsResult = await getSets()
  const releaseBySet = new Map<string, string>()
  if (setsResult && typeof setsResult === 'object' && !('error' in setsResult) && 'data' in setsResult) {
    for (const s of (setsResult as { data: { code: string; released_at?: string }[] }).data) {
      if (s.released_at) releaseBySet.set(s.code, s.released_at)
    }
  }

  buildProgress = { phase: 'decks', current: 0, total: newEntries.length }
  const pending: { entry: (typeof catalog)[number]; detail: Awaited<ReturnType<typeof getPreconDeckDetail>> }[] = []
  for (const entry of newEntries) {
    const detail = await getPreconDeckDetail(entry.slug)
    pending.push({ entry, detail })
    buildProgress = { phase: 'decks', current: pending.length, total: newEntries.length }
  }

  // Every (set, collector_number) this build needs, across every NEW precon, resolved in one
  // batched pass — the same staple printing (a set's own Sol Ring, Command Tower, etc.)
  // recurs across every precon sharing that set, so this is far fewer unique lookups than
  // newEntries.length * ~100. Precons already in the saved library aren't touched.
  const allPairs: { set: string; collectorNumber: string }[] = []
  for (const { detail } of pending) {
    if ('error' in detail) continue
    for (const [, , set, cn] of detail.commanderPrints) allPairs.push({ set, collectorNumber: cn })
    for (const [, , set, cn] of detail.cardEntries) allPairs.push({ set, collectorNumber: cn })
  }

  buildProgress = { phase: 'resolving', current: 0, total: allPairs.length }
  const resolved = await getCardsBySetAndNumber(allPairs, (current, total) => {
    buildProgress = { phase: 'resolving', current, total }
  })
  if (resolved && typeof resolved === 'object' && 'error' in resolved) {
    buildProgress = { phase: 'idle', current: 0, total: 0 }
    throw new Error((resolved as unknown as { details: string }).details)
  }
  const cardsByKey = new Map<string, { id: string }>()
  for (const c of (resolved as { data: { id: string; set: string; collector_number: string }[] }).data) {
    cardsByKey.set(`${c.set}/${c.collector_number}`, c)
  }
  buildProgress = { phase: 'resolving', current: allPairs.length, total: allPairs.length }

  const newDecks: PreconDeck[] = []
  const newSkipped: string[] = []
  for (const { entry, detail } of pending) {
    if ('error' in detail || detail.commanderPrints.length === 0) {
      newSkipped.push(entry.label)
      continue
    }

    const commanderCards = detail.commanderPrints
      .map(([, , set, cn]) => cardsByKey.get(`${set}/${cn}`))
      .filter((c): c is { id: string } => Boolean(c))
    if (commanderCards.length === 0) {
      newSkipped.push(entry.label)
      continue
    }
    const [commander, partner] = commanderCards

    const cardIds: string[] = []
    for (const [, qty, set, cn] of detail.cardEntries) {
      const card = cardsByKey.get(`${set}/${cn}`)
      if (!card) continue
      for (let i = 0; i < qty; i++) cardIds.push(card.id)
    }
    if (cardIds.length === 0) {
      newSkipped.push(entry.label)
      continue
    }

    newDecks.push({
      id: entry.slug,
      name: entry.label,
      setCode: entry.setCode,
      setHeader: entry.setHeader,
      releasedAt: releaseBySet.get(entry.setCode) ?? null,
      commanderId: commander.id,
      commanderName: detail.commanderNames[0] ?? '',
      partnerCommanderId: partner?.id ?? null,
      partnerCommanderName: partner ? (detail.commanderNames[1] ?? null) : null,
      cardIds
    })
  }

  // Retried entries (previously skipped, now attempted again) shouldn't leave a stale
  // duplicate label behind in `skipped` regardless of whether the retry succeeded or failed
  // again — either way the label below reflects the outcome of this build.
  const retriedLabels = new Set(newEntries.map((e) => e.label))
  const carriedOverSkipped = (reusable?.skipped ?? []).filter((label) => !retriedLabels.has(label))

  const decks = [...(reusable?.decks ?? []), ...newDecks]
  const skipped = [...carriedOverSkipped, ...newSkipped]

  const file: PreconFile = {
    builtAt: new Date().toISOString(),
    buildVersion: PRECON_BUILD_VERSION,
    decks,
    skipped
  }
  memoryFile = file
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(preconsPath(), JSON.stringify(file), 'utf-8')
  buildProgress = { phase: 'done', current: newEntries.length, total: newEntries.length }
  return { builtAt: file.builtAt, count: decks.length, skippedCount: skipped.length, stale: false }
}
