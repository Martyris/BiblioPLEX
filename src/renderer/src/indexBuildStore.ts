// Module-level store (not React Context) for the two long-running index builds — Card Tag
// Index and Combo Index. Needs to live outside any one component's tree because the persistent
// bottom progress bar (IndexBuildStatusBar, mounted once in App.tsx) and the "Build"/"Rebuild"
// buttons (TagSearchView, mounted only while that view is open) both need to see/drive the same
// in-flight build even after the user navigates away from Tag Search — an IPC build call keeps
// running in the main process regardless of what's mounted in the renderer, so the polling and
// the "is anything building" flag need to survive that navigation too.

export interface CardTagBuildProgress {
  phase: 'idle' | 'fetching' | 'tagging' | 'done'
  current: number
  total: number
}

export interface ComboBuildProgress {
  phase: 'idle' | 'crawling' | 'rate-limited' | 'done'
  current: number
  total: number
}

interface BuildSlice<P> {
  building: boolean
  progress: P
  error: string | null
}

interface StoreState {
  cardTag: BuildSlice<CardTagBuildProgress>
  combo: BuildSlice<ComboBuildProgress>
}

const IDLE_CARD_TAG: CardTagBuildProgress = { phase: 'idle', current: 0, total: 0 }
const IDLE_COMBO: ComboBuildProgress = { phase: 'idle', current: 0, total: 0 }

let state: StoreState = {
  cardTag: { building: false, progress: IDLE_CARD_TAG, error: null },
  combo: { building: false, progress: IDLE_COMBO, error: null }
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function patch(partial: Partial<StoreState>): void {
  state = { ...state, ...partial }
  emit()
}

export function subscribeToIndexBuilds(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getIndexBuildSnapshot(): StoreState {
  return state
}

let cardTagPollHandle: number | null = null

export async function startCardTagBuild(): Promise<void> {
  if (state.cardTag.building) return
  patch({ cardTag: { building: true, progress: { phase: 'fetching', current: 0, total: 0 }, error: null } })
  cardTagPollHandle = window.setInterval(async () => {
    const p = (await window.api.getCardTagIndexBuildProgress()) as CardTagBuildProgress
    patch({ cardTag: { ...state.cardTag, progress: p } })
  }, 400)
  try {
    await window.api.buildCardTagIndex()
  } catch (err) {
    console.error('[tag index] build failed:', err)
    patch({ cardTag: { ...state.cardTag, error: 'Failed to build the index — check your connection and try again.' } })
  } finally {
    if (cardTagPollHandle) window.clearInterval(cardTagPollHandle)
    cardTagPollHandle = null
    patch({ cardTag: { building: false, progress: IDLE_CARD_TAG, error: state.cardTag.error } })
  }
}

export function cancelCardTagBuild(): void {
  window.api.cancelCardTagIndexBuild()
}

let comboPollHandle: number | null = null

export async function startComboBuild(): Promise<void> {
  if (state.combo.building) return
  patch({ combo: { building: true, progress: { phase: 'crawling', current: 0, total: 0 }, error: null } })
  comboPollHandle = window.setInterval(async () => {
    const p = (await window.api.getComboIndexBuildProgress()) as ComboBuildProgress
    patch({ combo: { ...state.combo, progress: p } })
  }, 400)
  try {
    await window.api.buildComboIndex()
  } catch (err) {
    console.error('[combo index] build failed:', err)
    patch({
      combo: { ...state.combo, error: 'Failed to build the combo index — check your connection and try again.' }
    })
  } finally {
    if (comboPollHandle) window.clearInterval(comboPollHandle)
    comboPollHandle = null
    patch({ combo: { building: false, progress: IDLE_COMBO, error: state.combo.error } })
  }
}

export function cancelComboBuild(): void {
  window.api.cancelComboIndexBuild()
}
