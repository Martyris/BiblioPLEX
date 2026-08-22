import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  searchCards,
  getCardById,
  getCardByFuzzyName,
  getCardsByIds,
  getSets,
  fetchScryfallUrl,
  type SearchOptions
} from './scryfall'
import { getCommanderData, getTopCommanders, getCommanderTagIndex } from './edhrec'
import { findMyCombos } from './commanderSpellbook'
import { listDecks, getDeck, createDeck, updateDeck, deleteDeck, reorderDecks, type DeckPatch } from './deckStore'
import {
  getCardTagOverride,
  setCardTagOverride,
  getCardTagOverridesBatch,
  type CardTagOverride
} from './cardTagStore'
import {
  getCardTagIndexStatus,
  buildCardTagIndex,
  ensureCardTagIndexFresh,
  searchIndexedCardsByTags,
  getAllTagValues
} from './cardTagIndex'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.biblioplex.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('scryfall:search', async (_event, query: string, options?: SearchOptions) => {
    return searchCards(query, options)
  })

  ipcMain.handle('scryfall:card', async (_event, id: string) => {
    return getCardById(id)
  })

  ipcMain.handle('scryfall:named-fuzzy', async (_event, name: string) => {
    return getCardByFuzzyName(name)
  })

  ipcMain.handle('scryfall:sets', async () => {
    return getSets()
  })

  ipcMain.handle('scryfall:url', async (_event, url: string) => {
    return fetchScryfallUrl(url)
  })

  ipcMain.handle('edhrec:commander', async (_event, cardName: string, tagSlug?: string) => {
    return getCommanderData(cardName, tagSlug)
  })

  ipcMain.handle('edhrec:top-commanders', async () => {
    return getTopCommanders()
  })

  ipcMain.handle('edhrec:tag-index', async (_event, cardName: string) => {
    return getCommanderTagIndex(cardName)
  })

  ipcMain.handle('spellbook:find-combos', async (_event, mainCardNames: string[], commanderCardNames: string[]) => {
    return findMyCombos(mainCardNames, commanderCardNames)
  })

  ipcMain.handle('scryfall:collection', async (_event, ids: string[]) => {
    return getCardsByIds(ids)
  })

  ipcMain.handle('decks:list', async () => {
    return listDecks()
  })

  ipcMain.handle('decks:get', async (_event, id: string) => {
    return getDeck(id)
  })

  ipcMain.handle(
    'decks:create',
    async (
      _event,
      name: string,
      commanderId: string,
      commanderName: string,
      partnerCommanderId?: string | null,
      partnerCommanderName?: string | null
    ) => {
      return createDeck(name, commanderId, commanderName, partnerCommanderId, partnerCommanderName)
    }
  )

  ipcMain.handle('decks:update', async (_event, id: string, patch: DeckPatch) => {
    return updateDeck(id, patch)
  })

  ipcMain.handle('decks:delete', async (_event, id: string) => {
    return deleteDeck(id)
  })

  ipcMain.handle('decks:reorder', async (_event, orderedIds: string[]) => {
    return reorderDecks(orderedIds)
  })

  ipcMain.handle('cardtags:get-override', async (_event, oracleId: string) => {
    return getCardTagOverride(oracleId)
  })

  ipcMain.handle('cardtags:set-override', async (_event, oracleId: string, override: CardTagOverride) => {
    return setCardTagOverride(oracleId, override)
  })

  ipcMain.handle('cardtags:get-overrides-batch', async (_event, oracleIds: string[]) => {
    return getCardTagOverridesBatch(oracleIds)
  })

  ipcMain.handle('cardtagindex:status', async () => {
    return getCardTagIndexStatus()
  })

  ipcMain.handle('cardtagindex:build', async () => {
    return buildCardTagIndex()
  })

  ipcMain.handle('cardtagindex:ensure-fresh', async () => {
    return ensureCardTagIndexFresh()
  })

  ipcMain.handle('cardtagindex:search', async (_event, tags: string[]) => {
    return searchIndexedCardsByTags(tags)
  })

  ipcMain.handle('cardtagindex:all-tags', async () => {
    return getAllTagValues()
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
