// Bridge to the java-bridge/ sidecar process (see that folder's pom.xml/Main.java) — a
// long-lived headless XMage instance that plays real, rules-accurate Commander games. Started
// lazily (first Playtest-tab use, not app launch) since its one-time card-database scan costs
// ~35-70s; kept running for the rest of the app session so later games/checks are near-instant,
// rather than paying that cost per request the way a fresh-process-per-game design would.
//
// Protocol: newline-delimited JSON on stdin/stdout, correlated by a request "id" — see
// java-bridge's Main.java for the exact request/response shapes. This is deliberately the same
// "one long-running child process, request/response over its stdio" shape as any other subprocess
// bridge would use; there's no HTTP server involved.
//
// Packaging: the jar and a bundled Windows JRE both ship via electron-builder's extraResources
// (see package.json's "build.extraResources" and "build.win.extraResources") — findJavaBridgeJar
// and findJavaExecutable below both check the packaged (process.resourcesPath) location first,
// falling back to the dev-mode (project-relative) / system-installed paths respectively. In dev,
// process.resourcesPath points at Electron's own bundled resources, not this project's, so those
// packaged-path checks naturally find nothing there and fall through to the existing dev logic
// without needing an isPackaged branch.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, readdirSync, appendFileSync } from 'fs'

// PATH isn't reliable here: Electron (and this whole dev process tree) can easily have been
// launched before a freshly-installed JDK's PATH entry actually took effect for new processes,
// which showed up in practice as `spawn java ENOENT` even though `java -version` worked fine
// from a fresh terminal. Checking a couple of well-known install locations directly sidesteps
// that timing problem entirely — falls back to bare "java" (relying on PATH) if none match,
// which is the right behavior on a machine where Java was already properly on PATH already.
function findJavaExecutable(): string {
  // Packaged build: use the bundled Temurin JRE (same 8u502-b07 build as dev) so a tester never
  // needs Java installed at all — see this file's top comment.
  const bundled = join(process.resourcesPath ?? '', 'jre-win-x64', 'bin', 'java.exe')
  if (existsSync(bundled)) return bundled

  const candidateDirs = ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java']
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const exe = join(dir, entry, 'bin', 'java.exe')
      if (existsSync(exe)) return exe
    }
  }
  return 'java'
}

export interface GameSimStatus {
  // 'idle': never started. 'starting': process spawned, still scanning cards. 'ready': can
  // accept requests now. 'error': the process died or failed to start.
  phase: 'idle' | 'starting' | 'ready' | 'error'
  error?: string
}

// Mirrors deckStore.ts's LogicRule — kept as a local structural type rather than importing
// across the main/renderer boundary, same as the rest of this file's request/response shapes.
export interface GameSimLogicRule {
  type: 'holdInstantUntilAttackTrigger'
  permanentNames: string[]
}

export interface GameSimPlayerInput {
  name: string
  commanderNames: string[]
  cardNames: string[]
  // Deck-specific strategic guidance for the bot AI, parsed from a Logic file (see
  // docs/logic-file-guide.md) — empty/absent for decks without one, which behaves identically
  // to today's default (no held instants).
  logicRules?: GameSimLogicRule[]
}

export interface GameSimResult {
  winner: string
  turns: number
  gameMs: number
}

export interface GameSimError {
  error: true
  details: string
}

export interface GameSimPermanent {
  id: string
  name: string
  tapped: boolean
  attacking: boolean
  land: boolean
  token: boolean
  power: number
  toughness: number
  counters: number
  damage: number
  attachedTo?: string
  typeRank: number
  setCode: string
  collectorNumber: string
  // Only present when attacking === true and XMage resolved a defender for this attacker's
  // combat group — see java-bridge's Main.java emitSnapshot(). defendingPermanentId is only
  // set when the attack target is a planeswalker/battle rather than the player directly.
  defendingPlayerName?: string
  defendingPermanentId?: string
  // Only present once blockers have actually been declared for this attacker's combat group —
  // empty/absent through the declare-attackers step, populated from declare-blockers onward.
  blockerIds?: string[]
}

// A card identified by exact printing (not just name) — used wherever XMage gives us a real
// Card object (hand, graveyard, command zone) rather than a battlefield Permanent, so the
// renderer can resolve the same right-art/right-foil logic it already has for permanents instead
// of a name-only guess (a name-only lookup can't tell a foil copy from a non-foil one, or two
// differently-printed copies of the same card name apart).
export interface GameSimCardRef {
  name: string
  setCode: string
  collectorNumber: string
}

export interface GameSimCommandZoneCard extends GameSimCardRef {
  tax: number
}

export interface GameSimCommanderDamage {
  commanderName: string
  amount: number
}

// Exactly one of playerName/permanentId is set — whichever kind of thing this chosen target
// resolved to (see java-bridge's Main.java emitSnapshot()). A target that isn't a player or a
// battlefield permanent (a card in a graveyard/hand, another stack object) is omitted entirely,
// since the renderer has no stable on-screen anchor to draw an arrow to for those.
export interface GameSimStackTarget {
  playerName?: string
  permanentId?: string
}

export interface GameSimStackObject {
  id: string
  name: string
  sourceName: string
  controller: string
  setCode: string
  collectorNumber: string
  targets: GameSimStackTarget[]
}

export interface GameSimProgressPlayer {
  name: string
  life: number
  lost: boolean
  active: boolean
  poison: number
  hand: GameSimCardRef[]
  graveyard: GameSimCardRef[]
  graveyardSize: number
  librarySize: number
  commandZone: GameSimCommandZoneCard[]
  commanderDamage: GameSimCommanderDamage[]
  battlefield: GameSimPermanent[]
}

export interface GameSimProgress {
  turn: number
  step: string
  stack: GameSimStackObject[]
  players: GameSimProgressPlayer[]
  // One action's worth of narration (empty string for the bookend before/after-game snapshots)
  // — see java-bridge's Main.java: each snapshot now pairs 1:1 with the action that produced it,
  // rather than a batch of lines accumulated over a fixed time window.
  logLine: string
}

// Per-seat display info the renderer already has at game-start (see PlaytestTabView's
// gamePlayersRef) but that never reaches java-bridge itself — GameSimPlayerInput only carries
// what the engine needs. Threaded through runGame purely so it can be handed back verbatim to
// whichever PlaytestTabView instance later reattaches to this game (see getActiveGame below);
// gameSim.ts itself never reads these fields.
export interface GameSimSeatMeta {
  engineName: string
  deckName: string
  commanderName: string
  cardNames: string[]
}

export interface ActiveGameSim {
  requestId: string
  seatMeta: GameSimSeatMeta[]
  // Every progress snapshot seen so far, in order — lets a PlaytestTabView that (re)mounts after
  // the game already started jump straight to the current board state, and rebuild the narrator
  // log, without having replayed the game live itself.
  history: GameSimProgress[]
  result: GameSimResult | GameSimError | null
  done: boolean
}

function isGameSimError(x: unknown): x is GameSimError {
  return typeof x === 'object' && x !== null && (x as { error?: unknown }).error === true
}

let child: ChildProcessWithoutNullStreams | null = null
let status: GameSimStatus = { phase: 'idle' }
let readyResolvers: (() => void)[] = []
let stdoutBuffer = ''
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 1
const progressListeners = new Set<(progress: GameSimProgress) => void>()
// The game currently running (or the last one to finish, until a new one starts or this one is
// aborted) — see ActiveGameSim's own comment for why. Only one game runs at a time (java-bridge
// is single-threaded), so there's never more than one of these to track.
let activeGame: ActiveGameSim | null = null

/** Lets a freshly-(re)mounted Playtest tab discover a game that's still running (or already
 *  finished) in the background — e.g. the user switched away mid-game and came back. */
export function getActiveGame(): ActiveGameSim | null {
  return activeGame
}

/** Subscribed once from index.ts to forward progress ticks to the renderer via
 *  webContents.send — gameSim.ts itself has no window reference, so it just fans this out to
 *  whoever's listening rather than owning that plumbing. Returns an unsubscribe function. */
export function onGameSimProgress(listener: (progress: GameSimProgress) => void): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

function findJavaBridgeJar(): string {
  // Dev layout: java-bridge/ sits next to src/ at the project root. app.getAppPath() in dev
  // resolves to the project root (electron-vite doesn't relocate it the way a packaged asar
  // does), so this is stable across dev runs without hardcoding an absolute path.
  const devPath = join(app.getAppPath(), 'java-bridge', 'target', 'java-bridge-1.0-jar-with-dependencies.jar')
  if (existsSync(devPath)) return devPath
  // Packaged-build path — see this file's top comment for how it gets there.
  const packagedPath = join(process.resourcesPath ?? '', 'java-bridge', 'java-bridge-1.0-jar-with-dependencies.jar')
  return packagedPath
}

function handleStdoutData(chunk: Buffer): void {
  stdoutBuffer += chunk.toString('utf-8')
  let newlineIndex: number
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim()
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
    if (!line) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // stray non-JSON output — shouldn't happen (java-bridge's own logs go to stderr), ignore rather than crash
    }
    const obj = parsed as Record<string, unknown>

    if (obj.ready === true) {
      status = { phase: 'ready' }
      const resolvers = readyResolvers
      readyResolvers = []
      resolvers.forEach((r) => r())
      continue
    }

    if (obj.event === 'progress') {
      const progress = obj as unknown as GameSimProgress
      // Progress events aren't request/response (they don't go through `pending`), but they do
      // carry the id of whichever runGame request is currently in flight (see runGame's
      // requestId comment) — that's how a reattaching renderer's history lines up with what it
      // sees live afterward.
      if (activeGame && (obj as { id?: string }).id === activeGame.requestId) {
        activeGame.history.push(progress)
      }
      progressListeners.forEach((listener) => listener(progress))
      continue
    }

    const id = obj.id as string | undefined
    if (id && pending.has(id)) {
      pending.get(id)!.resolve(obj)
      pending.delete(id)
    }
  }
}

function ensureProcessStarted(): Promise<void> {
  if (status.phase === 'ready') return Promise.resolve()
  if (child && status.phase === 'starting') {
    return new Promise((resolve) => readyResolvers.push(resolve))
  }

  const jarPath = findJavaBridgeJar()
  if (!existsSync(jarPath)) {
    status = { phase: 'error', error: `java-bridge jar not found at ${jarPath} — run "mvn package" in java-bridge/` }
    return Promise.reject(new Error(status.error))
  }

  status = { phase: 'starting' }
  // cwd matters: XMage writes its card database to a `db/` folder *relative to the process's
  // working directory* (see java-bridge's Main.java / XMage's DatabaseUtils). Pinning it next to
  // the jar means the (slow, ~35-70s) card scan only ever needs to run again if that folder is
  // deleted — not on every Electron restart just because Electron's own cwd differs.
  const proc = spawn(findJavaExecutable(), ['-cp', jarPath, 'com.biblioplex.bridge.Main'], { cwd: dirname(jarPath) })
  child = proc

  proc.stdout.on('data', handleStdoutData)
  proc.stderr.on('data', (chunk: Buffer) => {
    // java-bridge's own logging (XMage's log4j output + our scan-timing lines) — useful for
    // debugging a stuck/slow game, not surfaced to the user; swallow rather than spam Electron's
    // own console. TEMPORARY: appended to a file instead while chasing the "process exited"
    // crash — remove this appendFileSync once that's diagnosed, back to a no-op.
    appendFileSync(join(dirname(jarPath), 'stderr-debug.log'), chunk)
  })
  proc.on('exit', (code) => {
    // Guard against a stale process's exit event: abortGame() kills the old process and
    // immediately spawns + tracks a new one, but kill() is async — the old process's own exit
    // event can still fire afterward. Without this check, that late event would null out (or
    // error-out) the NEW process's state instead of being a no-op for an already-replaced one.
    if (child !== proc) return
    child = null
    if (status.phase !== 'error') {
      status = { phase: 'error', error: `java-bridge process exited unexpectedly (code ${code})` }
    }
    // Any in-flight requests will never get a response now — fail them rather than hang forever.
    pending.forEach(({ reject }) => reject(new Error('java-bridge process exited')))
    pending.clear()
  })
  proc.on('error', (err) => {
    if (child !== proc) return
    status = { phase: 'error', error: err.message }
  })

  return new Promise((resolve, reject) => {
    readyResolvers.push(resolve)
    // If the process errors before ever becoming ready, don't leave the caller hanging.
    const checkError = setInterval(() => {
      if (status.phase === 'error') {
        clearInterval(checkError)
        reject(new Error(status.error))
      } else if (status.phase === 'ready') {
        clearInterval(checkError)
      }
    }, 250)
  })
}

async function sendRequest<T>(type: string, payload: Record<string, unknown>, explicitId?: string): Promise<T> {
  await ensureProcessStarted()
  if (!child) throw new Error('java-bridge process is not running')

  const id = explicitId ?? String(nextId++)
  const request = { id, type, ...payload }
  const responsePromise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
  })
  child.stdin.write(JSON.stringify(request) + '\n')
  return responsePromise
}

/** Called opportunistically when the Playtest tab is opened — starts the sidecar process ahead
 *  of the user actually clicking "start game", so the ~35-70s cold scan happens in the
 *  background while they're still picking decks rather than as a blocking wait later. Safe to
 *  call repeatedly; a second call while already starting/ready is a no-op. */
export function warmUpGameSim(): void {
  if (status.phase === 'idle') {
    ensureProcessStarted().catch(() => {
      // Errors surface through getGameSimStatus() polling instead — nothing to do with a
      // rejected promise from a fire-and-forget warm-up call.
    })
  }
}

export function getGameSimStatus(): GameSimStatus {
  return status
}

export async function checkCards(cardNames: string[]): Promise<string[] | GameSimError> {
  try {
    const response = await sendRequest<{ missing?: string[]; error?: string }>('checkCards', { cardNames })
    if (response.error) return { error: true, details: response.error }
    return response.missing ?? []
  } catch (err) {
    return { error: true, details: err instanceof Error ? err.message : String(err) }
  }
}

// requestId is caller-supplied (not auto-generated here) specifically so the renderer can know
// it *before* the game even starts and use it to filter incoming progress events — java-bridge
// processes one request at a time on a single thread, so if a caller starts a new game while a
// previous one is still finishing (its request just queued behind the old one in java-bridge's
// stdin), that old game's progress keeps streaming through the same onGameSimProgress channel in
// the meantime. Without filtering by id, a "new" game's board would show the old game's
// still-in-flight state under the new UI — this was a real bug (a freshly started game appeared
// to open mid-game, at whatever turn the stale run happened to be on).
export async function runGame(
  players: GameSimPlayerInput[],
  requestId: string,
  seatMeta: GameSimSeatMeta[]
): Promise<GameSimResult | GameSimError> {
  activeGame = { requestId, seatMeta, history: [], result: null, done: false }
  try {
    const response = await sendRequest<{ winner?: string; turns?: number; gameMs?: number; error?: string }>(
      'runGame',
      { players },
      requestId
    )
    const result: GameSimResult | GameSimError =
      response.error || !response.winner
        ? { error: true, details: response.error ?? 'No result returned' }
        : { winner: response.winner, turns: response.turns ?? 0, gameMs: response.gameMs ?? 0 }
    if (activeGame?.requestId === requestId) {
      activeGame.result = result
      activeGame.done = true
    }
    return result
  } catch (err) {
    const result: GameSimError = { error: true, details: err instanceof Error ? err.message : String(err) }
    if (activeGame?.requestId === requestId) {
      activeGame.result = result
      activeGame.done = true
    }
    return result
  }
}

export { isGameSimError }

/** Called once from index.ts on app quit — a live java subprocess left behind would otherwise
 *  orphan itself (Electron quitting doesn't kill child processes on its own). */
export function stopGameSim(): void {
  child?.kill()
  child = null
  status = { phase: 'idle' }
  activeGame = null
}

/** Called when the user ends a game while it's still actually simulating (Playtest's "End
 *  Game") — XMage's game loop is synchronous and runs on java-bridge's single processing thread
 *  (see runGame's comment above), so there's no clean way to cancel just the in-flight game from
 *  inside the engine; killing and respawning the whole process is the only way to actually
 *  guarantee it stops computing; not just stop watching it. `child = null` happens synchronously
 *  before the kill so the old process's own (async) exit event — guarded by `child !== proc`
 *  above — can't clobber the freshly-spawned replacement's state. The on-disk card database
 *  (db/, next to the jar) survives the process restart, so the new process's CardScanner.scan()
 *  is fast rather than paying the full ~35-70s cold-start cost again. */
export function abortGame(): void {
  const dying = child
  child = null
  status = { phase: 'idle' }
  activeGame = null
  pending.forEach(({ reject }) => reject(new Error('Game aborted')))
  pending.clear()
  dying?.kill()
  ensureProcessStarted().catch(() => {
    // Same as warmUpGameSim — errors surface through getGameSimStatus() polling instead of a
    // rejected promise from this fire-and-forget respawn.
  })
}
