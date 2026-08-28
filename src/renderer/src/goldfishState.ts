// Pure state/logic for the Deck Editor's local goldfish-testing sandbox (PlaytestGoldfishView) —
// no rules engine, no opponent, entirely client-side. Kept separate from the component so the
// component stays a thin rendering/event layer, matching how deckLogic.ts is used elsewhere in
// this app (logic functions the UI calls, not a full reducer/store library this app doesn't use
// anywhere else).

export type GoldfishZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'

export interface GoldfishCard {
  // Stable across zone moves and re-renders — independent of cardId, since a deck can (rarely,
  // for basics) contain the same printing more than once, and each physical copy needs its own
  // identity once cards start moving between zones independently.
  instanceId: string
  cardId: string
  tapped: boolean
  // Battlefield position, as a percentage (0-100) of the battlefield's own width/height —
  // meaningless for any other zone, left at whatever it last was.
  x: number
  y: number
  // Generic counter tracker (bottom-left badge) — purely a number the player is keeping track
  // of (loyalty, charge, etc.); deliberately does NOT affect power/toughness. Positive/negative
  // both allowed since not every counter type is a +1/+1.
  counters: number
  // +1/+1 (positive) or -1/-1 (negative) from clicking the P/T badge directly — independent of
  // `counters` above. Stacks on top of `powerOverride` (or the printed stats if that's null).
  ptBoost: number
  // "Set Power" context-menu override — replaces the printed power AND toughness as the base
  // that `ptBoost` then stacks on top of. Null means "use the printed values".
  powerOverride: number | null
  faceDown: boolean
  // Cosmetic only — drives the "COPY" badge; a copy behaves like any other card once created.
  isCopy: boolean
  // True for both "Add Token" tokens and card copies (a copy is, mechanically, a token copy of
  // whatever it copied) — governs the "vanishes instead of going to hand/library/graveyard/exile"
  // rule in moveCard, since neither kind of token exists once it leaves the battlefield.
  isToken: boolean
}

export interface GoldfishState {
  zones: Record<GoldfishZone, GoldfishCard[]>
  life: number
  turn: number
  // Cast count per commander cardId — persists independently of where that commander currently
  // is (battlefield, command zone, hand, ...), matching how commander tax works for real.
  commanderTax: Record<string, number>
}

let nextInstanceId = 1
function makeInstanceId(): string {
  nextInstanceId += 1
  return `g${nextInstanceId}-${Date.now().toString(36)}`
}

function newCard(cardId: string, x = 0, y = 0, isToken = false): GoldfishCard {
  return {
    instanceId: makeInstanceId(),
    cardId,
    tapped: false,
    x,
    y,
    counters: 0,
    ptBoost: 0,
    powerOverride: null,
    faceDown: false,
    isCopy: false,
    isToken
  }
}

function shuffled<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const STARTING_HAND_SIZE = 7
const STARTING_LIFE = 40 // Commander default

/** Fresh game: commander(s) to the command zone, the rest of the deck shuffled into the library,
 *  an opening hand of 7 drawn off the top. Used for both the initial mount and Restart. */
export function newGame(cardIds: string[], commanderIds: string[]): GoldfishState {
  const library = shuffled(cardIds).map((cardId) => newCard(cardId))
  const hand = library.splice(0, Math.min(STARTING_HAND_SIZE, library.length))
  const command = commanderIds.map((cardId) => newCard(cardId))
  return {
    zones: { library, hand, battlefield: [], graveyard: [], exile: [], command },
    life: STARTING_LIFE,
    turn: 1,
    commanderTax: {}
  }
}

export function drawCard(state: GoldfishState): GoldfishState {
  const [drawn, ...rest] = state.zones.library
  if (!drawn) return state
  return { ...state, zones: { ...state.zones, library: rest, hand: [...state.zones.hand, drawn] } }
}

export function shuffleLibrary(state: GoldfishState): GoldfishState {
  return { ...state, zones: { ...state.zones, library: shuffled(state.zones.library) } }
}

/** Drops a freshly-created token (from the "Add Token" menu) straight onto the battlefield. */
export function addToken(state: GoldfishState, cardId: string, position: { x: number; y: number }): GoldfishState {
  return {
    ...state,
    zones: { ...state.zones, battlefield: [...state.zones.battlefield, newCard(cardId, position.x, position.y, true)] }
  }
}

function findCard(state: GoldfishState, instanceId: string): { zone: GoldfishZone; card: GoldfishCard } | null {
  for (const zone of Object.keys(state.zones) as GoldfishZone[]) {
    const card = state.zones[zone].find((c) => c.instanceId === instanceId)
    if (card) return { zone, card }
  }
  return null
}

function updateCard(state: GoldfishState, instanceId: string, updater: (card: GoldfishCard) => GoldfishCard): GoldfishState {
  const found = findCard(state, instanceId)
  if (!found) return state
  return {
    ...state,
    zones: {
      ...state.zones,
      [found.zone]: state.zones[found.zone].map((c) => (c.instanceId === instanceId ? updater(c) : c))
    }
  }
}

/** Moves a card to a different zone (or just repositions it within the same one, if `toZone`
 *  matches its current zone — the battlefield-drag-to-reposition case). Cards always move to the
 *  END of their destination zone's array (most-recent-in-hand, etc.) except when repositioning
 *  within the battlefield (position is purely x/y, order doesn't matter) or moving onto the
 *  library, where `libraryEdge` picks which end.
 *
 *  Two special cases live here rather than at the call sites, since every mover (drag-and-drop,
 *  the context menu, keyboard shortcuts) funnels through this one function:
 *  - A token (or a copy — copies are tokens too) leaving the battlefield for anywhere other than
 *    the battlefield just ceases to exist, same as a token does in a real game, instead of
 *    actually taking up residence in hand/library/graveyard/exile.
 *  - A commander leaving the command zone specifically for the battlefield bumps its commander
 *    tax — see `commanderTax`. */
export function moveCard(
  state: GoldfishState,
  instanceId: string,
  toZone: GoldfishZone,
  position?: { x: number; y: number },
  libraryEdge: 'top' | 'bottom' = 'top'
): GoldfishState {
  const found = findCard(state, instanceId)
  if (!found) return state
  const changingZone = found.zone !== toZone

  if (changingZone && found.card.isToken && toZone !== 'battlefield') {
    return {
      ...state,
      zones: { ...state.zones, [found.zone]: state.zones[found.zone].filter((c) => c.instanceId !== instanceId) }
    }
  }

  const updatedCard: GoldfishCard = {
    ...found.card,
    x: position?.x ?? found.card.x,
    y: position?.y ?? found.card.y,
    // None of tap/counters/power-override/face-down carry meaning once a card leaves the zone it
    // was in — leaving them behind on a zone change matches how a real game works (a permanent's
    // modifications don't survive it dying, bouncing, etc.).
    tapped: toZone === 'battlefield' ? found.card.tapped : false,
    counters: changingZone ? 0 : found.card.counters,
    ptBoost: changingZone ? 0 : found.card.ptBoost,
    powerOverride: changingZone ? null : found.card.powerOverride,
    faceDown: changingZone ? false : found.card.faceDown
  }

  if (!changingZone) {
    return {
      ...state,
      zones: {
        ...state.zones,
        [toZone]: state.zones[toZone].map((c) => (c.instanceId === instanceId ? updatedCard : c))
      }
    }
  }

  const commanderTax =
    found.zone === 'command' && toZone === 'battlefield'
      ? { ...state.commanderTax, [found.card.cardId]: (state.commanderTax[found.card.cardId] ?? 0) + 1 }
      : state.commanderTax

  // Dropping a card onto the library means "put it on top" by default (a scry/tuck effect being
  // goldfished) — drawCard() takes from index 0, so top = front of the array; the "Move to Bottom
  // of Library" context-menu action passes 'bottom' explicitly. Every other zone just appends.
  const destination =
    toZone === 'library'
      ? libraryEdge === 'top'
        ? [updatedCard, ...state.zones.library]
        : [...state.zones.library, updatedCard]
      : [...state.zones[toZone], updatedCard]

  return {
    ...state,
    commanderTax,
    zones: {
      ...state.zones,
      [found.zone]: state.zones[found.zone].filter((c) => c.instanceId !== instanceId),
      [toZone]: destination
    }
  }
}

export function adjustCommanderTax(state: GoldfishState, cardId: string, delta: number): GoldfishState {
  const next = Math.max(0, (state.commanderTax[cardId] ?? 0) + delta)
  return { ...state, commanderTax: { ...state.commanderTax, [cardId]: next } }
}

/** Tap works in any zone, not just the battlefield — the T shortcut fires wherever the mouse
 *  happens to be hovering, and there's no reason to special-case that here. */
export function toggleTap(state: GoldfishState, instanceId: string): GoldfishState {
  return updateCard(state, instanceId, (c) => ({ ...c, tapped: !c.tapped }))
}

export function flipCard(state: GoldfishState, instanceId: string): GoldfishState {
  return updateCard(state, instanceId, (c) => ({ ...c, faceDown: !c.faceDown }))
}

/** Add Counter (+1, left-click on the counter badge) / Remove Counter (-1, right-click) — a
 *  generic tracker, independent of power/toughness. */
export function adjustCounters(state: GoldfishState, instanceId: string, delta: number): GoldfishState {
  // `?? 0` guards a card created before this field existed (a game started, then the app
  // hot-reloaded mid-session) from turning into NaN the first time it's touched.
  return updateCard(state, instanceId, (c) => ({ ...c, counters: (c.counters ?? 0) + delta }))
}

/** Left/right-click on the P/T badge itself — +1/+1 or -1/-1, independent of `counters`. */
export function adjustPtBoost(state: GoldfishState, instanceId: string, delta: number): GoldfishState {
  return updateCard(state, instanceId, (c) => ({ ...c, ptBoost: (c.ptBoost ?? 0) + delta }))
}

export function setPowerOverride(state: GoldfishState, instanceId: string, value: number | null): GoldfishState {
  return updateCard(state, instanceId, (c) => ({ ...c, powerOverride: value }))
}

/** Duplicates a card in place (same zone), a couple of percent off in position so a battlefield
 *  copy doesn't land in a dead stack directly on top of the original. A copy IS a token —
 *  mechanically a token copy of whatever it copied — so it keeps that card's own art (isCopy,
 *  for the "COPY" badge) while also getting isToken (so it vanishes instead of relocating if it
 *  ever leaves the battlefield). */
export function copyCard(state: GoldfishState, instanceId: string): GoldfishState {
  const found = findCard(state, instanceId)
  if (!found) return state
  const copy: GoldfishCard = {
    ...found.card,
    instanceId: makeInstanceId(),
    isCopy: true,
    isToken: true,
    x: found.card.x + 3,
    y: found.card.y + 3
  }
  return { ...state, zones: { ...state.zones, [found.zone]: [...state.zones[found.zone], copy] } }
}

/** Untaps everything on the battlefield and advances the turn counter — goldfishing has no
 *  opponent/priority to simulate, so "Next Turn" is just this one manual step. */
export function nextTurn(state: GoldfishState): GoldfishState {
  return {
    ...state,
    turn: state.turn + 1,
    zones: { ...state.zones, battlefield: state.zones.battlefield.map((c) => ({ ...c, tapped: false })) }
  }
}

export function setLife(state: GoldfishState, delta: number): GoldfishState {
  return { ...state, life: state.life + delta }
}
