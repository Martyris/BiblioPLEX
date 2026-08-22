// Commander Spellbook (commanderspellbook.com) — a community-maintained database of known
// EDH combos, queried via its public `find-my-combos` endpoint. No API key required. We only
// ask for the two buckets that matter for deckbuilding feedback: combos already fully
// assembled in the deck, and combos missing exactly the pieces the deck doesn't have yet.

const API_BASE = 'https://backend.commanderspellbook.com'

export interface SpellbookCardUse {
  cardName: string
  quantity: number
}

export interface SpellbookFeature {
  name: string
  quantity: number
}

export interface SpellbookVariant {
  id: string
  uses: SpellbookCardUse[]
  produces: SpellbookFeature[]
  description: string
  easyPrerequisites: string
  notablePrerequisites: string
  manaNeeded: string
  popularity: number | null
}

export interface SpellbookComboResult {
  included: SpellbookVariant[]
  almostIncluded: SpellbookVariant[]
}

export interface SpellbookError {
  error: true
  details: string
}

function toVariant(raw: unknown): SpellbookVariant {
  const v = raw as {
    id?: string
    uses?: { card?: { name?: string }; quantity?: number }[]
    produces?: { feature?: { name?: string }; quantity?: number }[]
    description?: string
    easyPrerequisites?: string
    notablePrerequisites?: string
    manaNeeded?: string
    popularity?: number | null
  }
  return {
    id: v.id ?? '',
    uses: (v.uses ?? []).map((u) => ({ cardName: u.card?.name ?? 'Unknown card', quantity: u.quantity ?? 1 })),
    produces: (v.produces ?? []).map((p) => ({ name: p.feature?.name ?? 'Unknown effect', quantity: p.quantity ?? 1 })),
    description: v.description ?? '',
    easyPrerequisites: v.easyPrerequisites ?? '',
    notablePrerequisites: v.notablePrerequisites ?? '',
    manaNeeded: v.manaNeeded ?? '',
    popularity: v.popularity ?? null
  }
}

/** `mainCardNames` should exclude the commander(s) — those go in `commanderCardNames` so
 *  Spellbook can also surface combos that only work because of the commander specifically. */
export async function findMyCombos(
  mainCardNames: string[],
  commanderCardNames: string[]
): Promise<SpellbookComboResult | SpellbookError> {
  try {
    const body = {
      main: mainCardNames.map((card) => ({ card, quantity: 1 })),
      commanders: commanderCardNames.map((card) => ({ card, quantity: 1 }))
    }
    const res = await fetch(`${API_BASE}/find-my-combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      return { error: true, details: `Commander Spellbook returned HTTP ${res.status}` }
    }
    const json = (await res.json()) as { results?: Record<string, unknown> }
    const results = json.results ?? (json as unknown as Record<string, unknown>)
    const included = (results.included as unknown[] | undefined) ?? []
    const almostIncluded = (results.almostIncluded as unknown[] | undefined) ?? []
    return {
      included: included.map(toVariant),
      almostIncluded: almostIncluded.map(toVariant)
    }
  } catch (err) {
    return { error: true, details: err instanceof Error ? err.message : String(err) }
  }
}
