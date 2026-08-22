import type { ScryfallSetList } from './types'
import { isError } from './types'

// Cached for the renderer's lifetime — the set list rarely changes within a session, and
// this avoids re-fetching all ~700 sets every time a printing dropdown is opened.
let cachedMap: Promise<Record<string, string>> | null = null

/** Maps a set code (e.g. "tla") to its icon SVG URL. */
export function getSetIconMap(): Promise<Record<string, string>> {
  if (!cachedMap) {
    cachedMap = window.api.getSets().then((result: unknown) => {
      if (isError(result)) return {}
      const map: Record<string, string> = {}
      for (const set of (result as ScryfallSetList).data) {
        map[set.code] = set.icon_svg_uri
      }
      return map
    })
  }
  return cachedMap
}
