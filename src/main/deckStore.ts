import { app } from 'electron'
import { join } from 'path'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'

// Electron derives userData from the app's package.json "name" by default, so renaming the
// app (as happened going from "mtg-platform" to "biblioplex") silently points every user at
// a brand-new, empty profile folder — orphaning decks.json in the old one. This list lets a
// fresh profile recover data from any prior app-name folder automatically, once, on startup.
const LEGACY_APP_NAMES = ['mtg-platform']

// Decks are stored as specific Scryfall printing ids (not oracle ids), so a saved deck
// always reflects exactly the printings the user picked. Full card data (oracle text,
// legality, images, tokens produced) is re-fetched from Scryfall on load rather than
// duplicated here — that way it never goes stale.
export interface DeckTag {
  slug: string
  value: string
  weight: number
}

// Commander Bracket (1-5): Wizards' official power-level scale — 1 Exhibition, 2 Core,
// 3 Upgraded, 4 Optimized, 5 cEDH. Set manually by the player, not derived.
export type Bracket = 1 | 2 | 3 | 4 | 5

export interface StoredDeck {
  id: string
  name: string
  commanderId: string
  commanderName: string
  // Set when the commander has Partner / "Choose a Background" and the player picked a
  // second commander (or a Background enchantment) to pair with it.
  partnerCommanderId: string | null
  partnerCommanderName: string | null
  cardIds: string[]
  tags: DeckTag[]
  bracket: Bracket | null
  wins: number
  losses: number
  // Manual display order in the "My Decks" list (lower = earlier). Independent of
  // updatedAt/createdAt so drag-reordering isn't undone by editing a deck.
  order: number
  createdAt: string
  updatedAt: string
  tokenPrintingOverrides: Record<string, string>
  cardPoolIds: string[]
  wantIds: string[]
  foilIds: string[]
  lastScore: { overall: number; grade: string; recordedAt: string } | null
}

let cache: StoredDeck[] | null = null

function decksPath(): string {
  return join(app.getPath('userData'), 'decks.json')
}

/** If this profile has no decks.json yet, checks prior app-name folders for one and copies
 *  it in. Runs once per process (guarded by the in-memory cache in `load`). */
async function migrateLegacyDecksIfNeeded(): Promise<void> {
  const currentPath = decksPath()
  try {
    await readFile(currentPath, 'utf-8')
    return // already have data at the current path — nothing to migrate
  } catch {
    // fall through and look for a legacy copy
  }

  const appDataDir = join(app.getPath('userData'), '..')
  for (const legacyName of LEGACY_APP_NAMES) {
    const legacyPath = join(appDataDir, legacyName, 'decks.json')
    try {
      await readFile(legacyPath, 'utf-8') // just to confirm it exists and is readable
      await mkdir(app.getPath('userData'), { recursive: true })
      await copyFile(legacyPath, currentPath)
      console.log(`[decks] migrated deck data from legacy profile "${legacyName}"`)
      return
    } catch {
      // no data under this legacy name — try the next one
    }
  }
}

async function load(): Promise<StoredDeck[]> {
  if (cache) return cache
  await migrateLegacyDecksIfNeeded()
  try {
    const raw = await readFile(decksPath(), 'utf-8')
    const parsed = JSON.parse(raw) as StoredDeck[]
    // Backfill for decks saved before the `tags`/`bracket`/`wins`/`losses`/`order` fields
    // existed. Decks without an explicit order keep their existing array position.
    cache = parsed.map((d, i) => ({
      ...d,
      tags: d.tags ?? [],
      bracket: d.bracket ?? null,
      wins: d.wins ?? 0,
      losses: d.losses ?? 0,
      order: d.order ?? i,
      partnerCommanderId: d.partnerCommanderId ?? null,
      partnerCommanderName: d.partnerCommanderName ?? null,
      tokenPrintingOverrides: d.tokenPrintingOverrides ?? {},
      cardPoolIds: d.cardPoolIds ?? [],
      wantIds: d.wantIds ?? [],
      foilIds: d.foilIds ?? [],
      lastScore: d.lastScore ?? null
    }))
  } catch {
    cache = []
  }
  return cache as StoredDeck[]
}

async function persist(decks: StoredDeck[]): Promise<void> {
  cache = decks
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8')
}

export async function listDecks(): Promise<StoredDeck[]> {
  return load()
}

export async function getDeck(id: string): Promise<StoredDeck | null> {
  const decks = await load()
  return decks.find((d) => d.id === id) ?? null
}

export async function createDeck(
  name: string,
  commanderId: string,
  commanderName: string,
  partnerCommanderId: string | null = null,
  partnerCommanderName: string | null = null
): Promise<StoredDeck> {
  const decks = await load()
  const now = new Date().toISOString()
  const maxOrder = decks.reduce((max, d) => Math.max(max, d.order), -1)
  const deck: StoredDeck = {
    id: randomUUID(),
    name,
    commanderId,
    commanderName,
    partnerCommanderId,
    partnerCommanderName,
    cardIds: [],
    tags: [],
    bracket: null,
    wins: 0,
    losses: 0,
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
    tokenPrintingOverrides: {},
    cardPoolIds: [],
    wantIds: [],
    foilIds: [],
    lastScore: null
  }
  await persist([...decks, deck])
  return deck
}

export interface DeckPatch {
  name?: string
  commanderId?: string
  commanderName?: string
  partnerCommanderId?: string | null
  partnerCommanderName?: string | null
  cardIds?: string[]
  tags?: DeckTag[]
  bracket?: Bracket | null
  wins?: number
  losses?: number
  tokenPrintingOverrides?: Record<string, string>
  cardPoolIds?: string[]
  wantIds?: string[]
  foilIds?: string[]
  lastScore?: { overall: number; grade: string; recordedAt: string } | null
}

export async function updateDeck(id: string, patch: DeckPatch): Promise<StoredDeck | null> {
  const decks = await load()
  const idx = decks.findIndex((d) => d.id === id)
  if (idx === -1) return null

  const updated: StoredDeck = { ...decks[idx], ...patch, updatedAt: new Date().toISOString() }
  const next = [...decks]
  next[idx] = updated
  await persist(next)
  return updated
}

export async function deleteDeck(id: string): Promise<void> {
  const decks = await load()
  await persist(decks.filter((d) => d.id !== id))
}

/** Reassigns `order` for every deck to match the given id sequence (drag-reorder in the
 *  decks list). Ids not present in `orderedIds` keep their relative order, appended after. */
export async function reorderDecks(orderedIds: string[]): Promise<StoredDeck[]> {
  const decks = await load()
  const byId = new Map(decks.map((d) => [d.id, d]))
  const rest = decks.filter((d) => !orderedIds.includes(d.id))
  const sequence = [...orderedIds.map((id) => byId.get(id)).filter((d): d is StoredDeck => Boolean(d)), ...rest]

  const next = sequence.map((d, i) => ({ ...d, order: i }))
  await persist(next)
  return next
}
