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
  consideringIds?: string[]
  lastScore?: { overall: number; grade: string; recordedAt: string } | null
  archetypeKey?: string
}

const api = {
  searchCards: (query: string, options?: SearchOptions) =>
    ipcRenderer.invoke('scryfall:search', query, options),
  getCard: (id: string) => ipcRenderer.invoke('scryfall:card', id),
  getCardByFuzzyName: (name: string) => ipcRenderer.invoke('scryfall:named-fuzzy', name),
  getSets: () => ipcRenderer.invoke('scryfall:sets'),
  autocompleteCardNames: (query: string) => ipcRenderer.invoke('scryfall:autocomplete', query),
  getCardNameCatalog: () => ipcRenderer.invoke('scryfall:card-name-catalog'),
  getCardTypeCatalog: () => ipcRenderer.invoke('scryfall:card-type-catalog'),
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
  getCardTagIndexBuildProgress: () => ipcRenderer.invoke('cardtagindex:build-progress'),
  cancelCardTagIndexBuild: () => ipcRenderer.invoke('cardtagindex:cancel-build'),
  ensureCardTagIndexFresh: () => ipcRenderer.invoke('cardtagindex:ensure-fresh'),
  searchCardsByTags: (tags: string[]) => ipcRenderer.invoke('cardtagindex:search', tags),
  getAllTagValues: () => ipcRenderer.invoke('cardtagindex:all-tags'),
  // Scryfall Tagger data — not yet wired into the live tag-search index or resolveCardTags,
  // see src/main/tagIndex.ts.
  getTaggerTagsForOracleId: (oracleId: string) => ipcRenderer.invoke('taggerindex:tags-for-oracle-id', oracleId),
  getTaggerRollupCategories: (slugs: string[]) => ipcRenderer.invoke('taggerindex:rollup-categories', slugs),
  isKnownTaggerSlug: (slug: string) => ipcRenderer.invoke('taggerindex:is-known-slug', slug),
  getAllTaggerTags: () => ipcRenderer.invoke('taggerindex:all-tags'),
  getTaggerDataBatch: (oracleIds: string[]) => ipcRenderer.invoke('taggerindex:batch', oracleIds),
  getComboIndexStatus: () => ipcRenderer.invoke('comboindex:status'),
  getComboIndexBuildProgress: () => ipcRenderer.invoke('comboindex:build-progress'),
  buildComboIndex: () => ipcRenderer.invoke('comboindex:build'),
  cancelComboIndexBuild: () => ipcRenderer.invoke('comboindex:cancel-build'),
  getComboHeavyOracleIds: () => ipcRenderer.invoke('comboindex:heavy-oracle-ids'),
  warmUpGameSim: () => ipcRenderer.invoke('gamesim:warm-up'),
  getGameSimStatus: () => ipcRenderer.invoke('gamesim:status'),
  checkGameSimCards: (cardNames: string[]) => ipcRenderer.invoke('gamesim:check-cards', cardNames),
  runGameSim: (
    players: {
      name: string
      commanderNames: string[]
      cardNames: string[]
      logicRules?: { type: 'holdInstantUntilAttackTrigger'; permanentNames: string[] }[]
    }[],
    requestId: string
  ) => ipcRenderer.invoke('gamesim:run-game', players, requestId),
  abortGameSim: () => ipcRenderer.invoke('gamesim:abort'),
  onGameSimProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, progress: unknown): void => callback(progress)
    ipcRenderer.on('gamesim:progress', listener)
    return (): void => {
      ipcRenderer.removeListener('gamesim:progress', listener)
    }
  },
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  getCurrentAccount: () => ipcRenderer.invoke('accounts:current'),
  createAccount: (username: string) => ipcRenderer.invoke('accounts:create', username),
  switchAccount: (id: string) => ipcRenderer.invoke('accounts:switch', id),
  signOutAccount: () => ipcRenderer.invoke('accounts:sign-out'),
  setUsername: (id: string, username: string) => ipcRenderer.invoke('accounts:set-username', id, username),
  isUsernameAvailable: (username: string, excludingId?: string) =>
    ipcRenderer.invoke('accounts:username-available', username, excludingId),
  setProfilePictureCard: (id: string, cardName: string) =>
    ipcRenderer.invoke('accounts:set-profile-picture-card', id, cardName),
  setProfilePictureUpload: (id: string, dataUrl: string) =>
    ipcRenderer.invoke('accounts:set-profile-picture-upload', id, dataUrl),
  setSchool: (id: string, school: string | null) => ipcRenderer.invoke('accounts:set-school', id, school),
  setAppLocale: (locale: string) => ipcRenderer.invoke('locale:set', locale),
  getLocalizedCardArt: (set: string, collectorNumber: string) =>
    ipcRenderer.invoke('scryfall:localized-art', set, collectorNumber),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return (): void => {
      ipcRenderer.removeListener('window:maximized-changed', listener)
    }
  }
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
