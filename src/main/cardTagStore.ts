import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

// Keyed by oracle_id, not printing id — tags describe what a card does, which is the same
// across every printing of it.
export interface CardTagOverride {
  added: string[]
  removed: string[]
}

type OverrideMap = Record<string, CardTagOverride>

let cache: OverrideMap | null = null

function overridesPath(): string {
  return join(app.getPath('userData'), 'cardTagOverrides.json')
}

async function load(): Promise<OverrideMap> {
  if (cache) return cache
  try {
    const raw = await readFile(overridesPath(), 'utf-8')
    cache = JSON.parse(raw) as OverrideMap
  } catch {
    cache = {}
  }
  return cache
}

async function persist(map: OverrideMap): Promise<void> {
  cache = map
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(overridesPath(), JSON.stringify(map, null, 2), 'utf-8')
}

export async function getCardTagOverride(oracleId: string): Promise<CardTagOverride> {
  const map = await load()
  return map[oracleId] ?? { added: [], removed: [] }
}

export async function getCardTagOverridesBatch(oracleIds: string[]): Promise<Record<string, CardTagOverride>> {
  const map = await load()
  const result: Record<string, CardTagOverride> = {}
  for (const id of oracleIds) {
    if (map[id]) result[id] = map[id]
  }
  return result
}

/** Used by the bulk tag index search — merges every override into the index's auto-computed
 *  tags at query time, so improving the index doesn't require re-touching hand-edited cards. */
export async function getAllCardTagOverrides(): Promise<OverrideMap> {
  return load()
}

export async function setCardTagOverride(oracleId: string, override: CardTagOverride): Promise<CardTagOverride> {
  const map = await load()
  const isEmpty = override.added.length === 0 && override.removed.length === 0
  const next = { ...map }
  if (isEmpty) {
    delete next[oracleId]
  } else {
    next[oracleId] = override
  }
  await persist(next)
  return override
}
