import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface SearchOptions {
  order?: string
  dir?: 'asc' | 'desc'
  page?: number
}

interface DeckTag {
  slug: string
  value: string
  weight: number
}

interface CardTagOverride {
  added: string[]
  removed: string[]
}

interface DeckPatch {
  name?: string
  commanderId?: string
  commanderName?: string
  partnerCommanderId?: string | null
  partnerCommanderName?: string | null
  cardIds?: string[]
  tags?: DeckTag[]
  bracket?: 1 | 2 | 3 | 4 | 5 | null
  wins?: number
  losses?: number
  tokenPrintingOverrides?: Record<string, string>
  cardPoolIds?: string[]
  wantIds?: string[]
  foilIds?: string[]
  lastScore?: { overall: number; grade: string; recordedAt: string } | null
  coreMechanicTags?: string[]
}

const api = {
  searchCards: (query: string, options?: SearchOptions) =>
    ipcRenderer.invoke('scryfall:search', query, options),
  getCard: (id: string) => ipcRenderer.invoke('scryfall:card', id),
  getCardByFuzzyName: (name: string) => ipcRenderer.invoke('scryfall:named-fuzzy', name),
  getSets: () => ipcRenderer.invoke('scryfall:sets'),
  autocompleteCardNames: (query: string) => ipcRenderer.invoke('scryfall:autocomplete', query),
  getCardNameCatalog: () => ipcRenderer.invoke('scryfall:card-name-catalog'),
  fetchScryfallUrl: (url: string) => ipcRenderer.invoke('scryfall:url', url),
  getCardsByIds: (ids: string[]) => ipcRenderer.invoke('scryfall:collection', ids),
  getCardsByNames: (names: string[]) => ipcRenderer.invoke('scryfall:collection-by-name', names),
  getCommanderData: (cardName: string, tagSlug?: string) =>
    ipcRenderer.invoke('edhrec:commander', cardName, tagSlug),
  getTopCommanders: () => ipcRenderer.invoke('edhrec:top-commanders'),
  getCommanderTagIndex: (cardName: string) => ipcRenderer.invoke('edhrec:tag-index', cardName),
  findCombos: (mainCardNames: string[], commanderCardNames: string[]) =>
    ipcRenderer.invoke('spellbook:find-combos', mainCardNames, commanderCardNames),
  listDecks: () => ipcRenderer.invoke('decks:list'),
  getDeck: (id: string) => ipcRenderer.invoke('decks:get', id),
  createDeck: (
    name: string,
    commanderId: string,
    commanderName: string,
    partnerCommanderId?: string | null,
    partnerCommanderName?: string | null
  ) => ipcRenderer.invoke('decks:create', name, commanderId, commanderName, partnerCommanderId, partnerCommanderName),
  updateDeck: (id: string, patch: DeckPatch) => ipcRenderer.invoke('decks:update', id, patch),
  deleteDeck: (id: string) => ipcRenderer.invoke('decks:delete', id),
  duplicateDeck: (id: string) => ipcRenderer.invoke('decks:duplicate', id),
  reorderDecks: (orderedIds: string[]) => ipcRenderer.invoke('decks:reorder', orderedIds),
  getPreconStatus: () => ipcRenderer.invoke('precons:status'),
  getPreconBuildProgress: () => ipcRenderer.invoke('precons:build-progress'),
  buildPreconLibrary: () => ipcRenderer.invoke('precons:build'),
  listPrecons: () => ipcRenderer.invoke('precons:list'),
  copyPreconToMyDecks: (id: string) => ipcRenderer.invoke('precons:copy-to-my-decks', id),
  getCardTagOverride: (oracleId: string) => ipcRenderer.invoke('cardtags:get-override', oracleId),
  setCardTagOverride: (oracleId: string, override: CardTagOverride) =>
    ipcRenderer.invoke('cardtags:set-override', oracleId, override),
  getCardTagOverridesBatch: (oracleIds: string[]) =>
    ipcRenderer.invoke('cardtags:get-overrides-batch', oracleIds),
  getCardTagIndexStatus: () => ipcRenderer.invoke('cardtagindex:status'),
  buildCardTagIndex: () => ipcRenderer.invoke('cardtagindex:build'),
  ensureCardTagIndexFresh: () => ipcRenderer.invoke('cardtagindex:ensure-fresh'),
  searchCardsByTags: (tags: string[]) => ipcRenderer.invoke('cardtagindex:search', tags),
  getAllTagValues: () => ipcRenderer.invoke('cardtagindex:all-tags')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api
