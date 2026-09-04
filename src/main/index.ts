import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname, normalize } from 'path'
import { readFile, writeFile, unlink } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  searchCards,
  getCardById,
  getCardByFuzzyName,
  getCardsByIds,
  getCardsByNames,
  getCardsBySetAndNumber,
  getSets,
  fetchScryfallUrl,
  autocompleteCardNames,
  getCardNameCatalog,
  getCardTypeCatalog,
  getLocalizedCardArt,
  type SearchOptions
} from './scryfall'
import { generateDecklistPdf, extractPdfText, sanitizeFileName, type DecklistPdfOptions } from './deckExport'
import { setMainLocale } from './localePreference'
import { getCommanderData, getTopCommanders, getCommanderTagIndex } from './edhrec'
import { findMyCombos } from './commanderSpellbook'
import {
  listDecks,
  getDeck,
  createDeck,
  updateDeck,
  deleteDeck,
  duplicateDeck,
  reorderDecks,
  createDeckFromPrecon,
  type DeckPatch
} from './deckStore'
import {
  getPreconStatus,
  getPreconBuildProgress,
  buildPreconLibrary,
  listPrecons,
  getPrecon
} from './precons'
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
  getAllTagValues,
  getCardTagIndexBuildProgress,
  cancelCardTagIndexBuild
} from './cardTagIndex'
import {
  getComboIndexStatus,
  getComboIndexBuildProgress,
  buildComboIndex,
  getComboHeavyOracleIds,
  cancelComboIndexBuild
} from './comboIndex'
import { getTaggerTagsForOracleId, getRollupCategoriesForSlugs, isKnownTaggerSlug, getAllTaggerTags, getTaggerDataBatch } from './tagIndex'
import {
  warmUpGameSim,
  getGameSimStatus,
  checkCards as checkGameSimCards,
  runGame as runGameSim,
  stopGameSim,
  abortGame as abortGameSim,
  onGameSimProgress,
  getActiveGame,
  type GameSimPlayerInput,
  type GameSimSeatMeta
} from './gameSim'
import {
  listAccounts,
  getCurrentAccount,
  createAccount,
  switchAccount,
  signOut,
  setUsername,
  isUsernameAvailable,
  setProfilePictureCard,
  setProfilePictureUpload,
  setSchool,
  type School
} from './accounts'
import { checkForUpdate, downloadUpdate, installUpdate, DELETE_OLD_EXE_ENV_VAR, type UpdateInfo } from './updater'

// Portable-style storage: packaged builds keep decks.json/accounts.json/precons.json/the card-
// tag index in a "data" folder next to wherever the .exe is actually being run from, instead of
// the OS's per-user AppData — the whole app plus its data is then one relocatable folder (a USB
// stick, a zip handed to a tester, whatever) rather than tied to a specific Windows profile.
// Every module that touches userData already does `mkdir(..., { recursive: true })` before its
// first write, so this "data" folder gets created on its own — nothing else to seed it.
//
// electron-builder's "portable" Windows target is a self-extracting launcher: it unpacks the
// real app into a %TEMP% folder and runs it from there, so app.getPath('exe') resolves inside
// that (ephemeral, can differ per launch) temp copy — NOT the .exe the user actually
// double-clicked. electron-builder sets PORTABLE_EXECUTABLE_DIR to the real location precisely
// for cases like this, so that's used first when present. Dev builds are left on the normal
// AppData path: app.getPath('exe') there points at node_modules/electron's raw binary, not
// anywhere useful to write app data next to.
if (!is.dev) {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const baseDir = portableDir ?? dirname(app.getPath('exe'))
  app.setPath('userData', join(baseDir, 'data'))
}

// After an in-app update (see updater.ts's installUpdate), the OLD version's exe is still
// sitting right next to the new one — it can't delete itself while running, so it hands this
// (newly-launched) process its own path via an env var and trusts this process to finish the
// job. The old process needs a moment to actually exit and release its exe's execution lock
// after quitting, so a delete attempt failing isn't the end of it — a few retries with a short
// wait between them covers that without ever blocking startup on it.
async function cleanupOldExeIfRequested(): Promise<void> {
  const oldExePath = process.env[DELETE_OLD_EXE_ENV_VAR]
  if (!oldExePath) return
  // Guards against ever deleting the exe this very process is running from, however that could
  // theoretically happen (e.g. an update "to" the same version already running).
  const currentExePath = process.env.PORTABLE_EXECUTABLE_FILE ?? app.getPath('exe')
  // Windows paths are case-insensitive — a straight string comparison would miss a same-file
  // match that only differs by case.
  if (normalize(oldExePath).toLowerCase() === normalize(currentExePath).toLowerCase()) return

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await unlink(oldExePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 816,
    show: false,
    autoHideMenuBar: true,
    // Only affects Linux/Windows at runtime (macOS takes its dock icon from the app bundle at
    // build time instead) — see resources/icon.png/.ico, generated from src/renderer/src/assets/logo.png.
    icon: join(__dirname, '../../resources/icon.png'),
    // Fully frameless — no OS title bar, no OS-drawn window buttons at all. Windows enforces a
    // minimum height (~32px) on titleBarOverlay's native buttons that can't be shrunk below, so
    // getting genuinely small controls means drawing our own in the renderer (see
    // WindowControls.tsx) and driving them via the window:* IPC handlers below instead.
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized-changed', false))

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
  // Fire-and-forget — it retries for up to ~5s on its own and has nothing to do with getting a
  // window on screen, so there's no reason to hold up startup on it.
  void cleanupOldExeIfRequested()

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

  ipcMain.handle('scryfall:autocomplete', async (_event, query: string) => {
    return autocompleteCardNames(query)
  })

  ipcMain.handle('scryfall:card-name-catalog', async () => {
    return getCardNameCatalog()
  })

  ipcMain.handle('scryfall:card-type-catalog', async () => {
    return getCardTypeCatalog()
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

  ipcMain.handle('scryfall:collection-by-name', async (_event, names: string[]) => {
    return getCardsByNames(names)
  })

  ipcMain.handle('scryfall:collection-by-set-number', async (_event, pairs: { set: string; collectorNumber: string }[]) => {
    return getCardsBySetAndNumber(pairs)
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

  ipcMain.handle('decks:duplicate', async (_event, id: string) => {
    return duplicateDeck(id)
  })

  ipcMain.handle('decks:reorder', async (_event, orderedIds: string[]) => {
    return reorderDecks(orderedIds)
  })

  ipcMain.handle('decks:export-pdf', async (event, pdfOptions: DecklistPdfOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: 'Export Decklist PDF',
      defaultPath: `${sanitizeFileName(pdfOptions.deckName)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    const buffer = await generateDecklistPdf(pdfOptions)
    await writeFile(result.filePath, buffer)
    return result.filePath
  })

  ipcMain.handle('decks:pick-import-pdf', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions = {
      title: 'Import Decklist PDF',
      properties: ['openFile' as const],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    const buffer = await readFile(result.filePaths[0])
    return extractPdfText(buffer)
  })

  ipcMain.handle('precons:status', async () => {
    return getPreconStatus()
  })

  ipcMain.handle('precons:build-progress', async () => {
    return getPreconBuildProgress()
  })

  ipcMain.handle('precons:build', async () => {
    return buildPreconLibrary()
  })

  ipcMain.handle('precons:list', async () => {
    return listPrecons()
  })

  ipcMain.handle('precons:copy-to-my-decks', async (_event, id: string) => {
    const precon = await getPrecon(id)
    if (!precon) return null
    return createDeckFromPrecon(precon)
  })

  ipcMain.handle('accounts:list', async () => listAccounts())
  ipcMain.handle('accounts:current', async () => getCurrentAccount())
  ipcMain.handle('accounts:create', async (_event, username: string) => createAccount(username))
  ipcMain.handle('accounts:switch', async (_event, id: string) => switchAccount(id))
  ipcMain.handle('accounts:sign-out', async () => signOut())
  ipcMain.handle('accounts:set-username', async (_event, id: string, username: string) => setUsername(id, username))
  ipcMain.handle('accounts:username-available', async (_event, username: string, excludingId?: string) =>
    isUsernameAvailable(username, excludingId)
  )
  ipcMain.handle('accounts:set-profile-picture-card', async (_event, id: string, cardName: string) =>
    setProfilePictureCard(id, cardName)
  )
  ipcMain.handle('accounts:set-profile-picture-upload', async (_event, id: string, dataUrl: string) =>
    setProfilePictureUpload(id, dataUrl)
  )
  ipcMain.handle('accounts:set-school', async (_event, id: string, school: School | null) => setSchool(id, school))

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  ipcMain.handle('locale:set', (_event, locale: string) => {
    setMainLocale(locale)
  })

  ipcMain.handle('updater:check', async () => {
    return checkForUpdate()
  })

  ipcMain.handle('updater:download', async (event, info: UpdateInfo) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return downloadUpdate(info, (received, total) => {
      win?.webContents.send('updater:progress', { received, total })
    })
  })

  ipcMain.handle('updater:install', (_event, filePath: string) => {
    installUpdate(filePath)
  })

  ipcMain.handle('scryfall:localized-art', async (_event, set: string, collectorNumber: string) => {
    return getLocalizedCardArt(set, collectorNumber)
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

  ipcMain.handle('cardtagindex:build-progress', async () => {
    return getCardTagIndexBuildProgress()
  })

  ipcMain.handle('cardtagindex:cancel-build', async () => {
    cancelCardTagIndexBuild()
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

  // Scryfall Tagger data (see tagIndex.ts) — not yet wired into the live tag-search index or
  // resolveCardTags; exposed here so it's reachable for testing/incremental integration.
  ipcMain.handle('taggerindex:tags-for-oracle-id', async (_event, oracleId: string) => {
    return getTaggerTagsForOracleId(oracleId)
  })

  ipcMain.handle('taggerindex:rollup-categories', async (_event, slugs: string[]) => {
    return getRollupCategoriesForSlugs(slugs)
  })

  ipcMain.handle('taggerindex:is-known-slug', async (_event, slug: string) => {
    return isKnownTaggerSlug(slug)
  })

  ipcMain.handle('taggerindex:all-tags', async () => {
    return getAllTaggerTags()
  })

  ipcMain.handle('taggerindex:batch', async (_event, oracleIds: string[]) => {
    return getTaggerDataBatch(oracleIds)
  })

  ipcMain.handle('comboindex:status', async () => {
    return getComboIndexStatus()
  })

  ipcMain.handle('comboindex:build-progress', async () => {
    return getComboIndexBuildProgress()
  })

  ipcMain.handle('comboindex:build', async () => {
    return buildComboIndex()
  })

  ipcMain.handle('comboindex:heavy-oracle-ids', async () => {
    return getComboHeavyOracleIds()
  })

  ipcMain.handle('comboindex:cancel-build', async () => {
    cancelComboIndexBuild()
  })

  ipcMain.handle('gamesim:warm-up', () => {
    warmUpGameSim()
  })

  ipcMain.handle('gamesim:status', () => {
    return getGameSimStatus()
  })

  ipcMain.handle('gamesim:check-cards', async (_event, cardNames: string[]) => {
    return checkGameSimCards(cardNames)
  })

  ipcMain.handle(
    'gamesim:run-game',
    async (_event, players: GameSimPlayerInput[], requestId: string, seatMeta: GameSimSeatMeta[]) => {
      return runGameSim(players, requestId, seatMeta)
    }
  )

  ipcMain.handle('gamesim:abort', () => {
    abortGameSim()
  })

  ipcMain.handle('gamesim:active', () => {
    return getActiveGame()
  })

  // Pushed (not request/response — ipcMain.handle can't stream) to whatever windows exist while
  // a game is running, so the Playtest tab can show live turn/life updates instead of a frozen
  // "Playing…" state. See gameSim.ts's emitProgress/onGameSimProgress for where this originates.
  onGameSimProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('gamesim:progress', progress)
    }
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

// The java-bridge sidecar process (see gameSim.ts) doesn't die on its own when Electron
// quits — orphaning it would leave a stray java.exe running in the background indefinitely.
app.on('before-quit', () => {
  stopGameSim()
})
