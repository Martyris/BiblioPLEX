import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isError, type ScryfallCard, type StoredDeck } from '../types'
import { deriveTokens, isBasicLand, type DerivedToken } from '../deckLogic'
import {
  addCounterType,
  addToken,
  adjustCommanderTax,
  adjustCounterAt,
  adjustPtBoost,
  copyCard,
  drawCard,
  flipCard,
  moveCard,
  newGame,
  nextTurn,
  removeCounterType,
  setLife,
  setPowerOverride,
  shuffleLibrary,
  toggleTap,
  transformCard,
  type GoldfishCard,
  type GoldfishState,
  type GoldfishZone
} from '../goldfishState'
import CardContextMenu from './CardContextMenu'
import CardDetail from './CardDetail'
import {
  playCounterSound,
  playDrawSound,
  playEtbSound,
  playExileSound,
  playFlipSound,
  playGraveyardSound,
  playShuffleSound
} from '../playtestSound'
import { manaSymbolUrl, parseManaCostSymbols } from '../manaSymbol'

// Same asset PlaytestTabView.tsx uses for its own library card-back — declared locally rather
// than shared/exported, matching this app's existing "hand-duplicate a small constant across
// renderer files" convention (see e.g. PlaytestTabView's own locally-duplicated GameSimProgress).
const CARD_BACK_URL = 'https://cards.scryfall.io/back.png'

// One color per counter type, assigned by index (first type added, first color) so a card
// tracking several kinds of counters (+1/+1, loyalty, poison, ...) reads as distinct badges at a
// glance rather than a wall of identical dark chips. Reuses hues already established elsewhere
// in the app (pool/want markers, the goldfish selection blue, nav accents) instead of inventing
// a new palette. Cycles if a card somehow ends up with more types than colors — vanishingly rare.
const COUNTER_TYPE_COLORS = ['#e6c229', '#7ee787', '#f04747', '#4dabf7', '#b388ff', '#f0824f']

interface Props {
  storedDeck: StoredDeck
  cardDataById: Record<string, ScryfallCard>
  onBack: () => void
}

function cardImageSmall(card: ScryfallCard | undefined, faceIndex = 0): string | undefined {
  if (faceIndex > 0) return card?.card_faces?.[faceIndex]?.image_uris?.small
  return card?.image_uris?.small ?? card?.card_faces?.[0]?.image_uris?.small
}

function cardImageNormal(card: ScryfallCard | undefined, faceIndex = 0): string | undefined {
  if (faceIndex > 0) return card?.card_faces?.[faceIndex]?.image_uris?.normal
  return card?.image_uris?.normal ?? card?.card_faces?.[0]?.image_uris?.normal
}

// Same heuristic CardDetail.tsx uses for its own flip button — a card is physically flippable
// whenever it has exactly two faces that each carry their own art, which in practice covers
// transform (werewolves, etc.) and modal DFCs while excluding split/adventure/flip layouts
// (their faces share one combined image, so there's no second face art to flip to).
function isTransformable(cardData: ScryfallCard | undefined): boolean {
  const faces = cardData?.card_faces
  return faces?.length === 2 && Boolean(faces[0]?.image_uris) && Boolean(faces[1]?.image_uris)
}

/** Underlines the first occurrence of `letter` in `label` — marks which key is that button/zone's
 *  keyboard shortcut, the same idea as a classic menu accelerator key. */
function withShortcut(label: string, letter: string) {
  const idx = label.toLowerCase().indexOf(letter.toLowerCase())
  if (idx === -1) return label
  return (
    <>
      {label.slice(0, idx)}
      <u>{label[idx]}</u>
      {label.slice(idx + 1)}
    </>
  )
}

// Must track .goldfish-card's width and .goldfish-zone__strip's gap in styles.css — used to
// decide when the hand needs to fan (overlap) rather than grow past the strip's width.
const HAND_CARD_WIDTH = 105
const HAND_CARD_GAP = 8
// Smallest left-edge-to-left-edge spacing we'll compress a large hand down to before just
// letting the strip's own overflow-x scroll take over.
const HAND_MIN_PITCH = 28
// .goldfish-zone__strip's horizontal padding (2px + 2px) plus its border (1px + 1px) —
// getBoundingClientRect() includes both, but cards only ever sit in the space left over once
// they're subtracted out, so leaving this out was letting the fitted hand run a few px too wide.
const HAND_STRIP_INSET = 6

const ZONE_MODAL_LABELS: Record<'library' | 'graveyard' | 'exile', string> = {
  library: 'Library',
  graveyard: 'Graveyard',
  exile: 'Exile'
}

interface EffectiveStats {
  power: number
  toughness: number
  basePower: number
}

/** Printed power/toughness, "Set Power" override, and +1/+1 (or -1/-1, if negative) counters
 *  combined into what should actually be shown. Returns null only when there's truly nothing to
 *  overlay — a non-creature (or variable-power "*") that hasn't had "Set Power" used on it. A
 *  card with no printed stats CAN still get an override, though — that's how animating a land
 *  (or any other non-creature) into a creature gets goldfished: "Set Power" gives it a P/T where
 *  there wasn't one, and it behaves like any other creature from then on. */
function effectiveStats(card: GoldfishCard, cardData: ScryfallCard | undefined): EffectiveStats | null {
  const activeFace = card.transformed ? cardData?.card_faces?.[1] : undefined
  const powerRaw = activeFace?.power ?? cardData?.power ?? cardData?.card_faces?.[0]?.power
  const toughnessRaw = activeFace?.toughness ?? cardData?.toughness ?? cardData?.card_faces?.[0]?.toughness
  const printedPower = powerRaw !== undefined ? parseInt(powerRaw, 10) : NaN
  const printedToughness = toughnessRaw !== undefined ? parseInt(toughnessRaw, 10) : NaN
  const hasPrintedStats = !Number.isNaN(printedPower) && !Number.isNaN(printedToughness)
  // `?? 0` guards a card created before ptBoost existed (a game started, then the app
  // hot-reloaded mid-session) from showing NaN/NaN the first time this renders.
  const ptBoost = card.ptBoost ?? 0

  if (!hasPrintedStats) {
    if (card.powerOverride === null) return null
    // No printed stats to reference, so the override itself becomes the "original" baseline
    // that ptBoost then buffs/debuffs away from — a freshly-animated 3/3 shouldn't show as
    // "buffed" just for existing.
    const base = card.powerOverride
    return { power: base + ptBoost, toughness: base + ptBoost, basePower: base }
  }

  // An override replaces the printed base that ptBoost then stacks on top of, but the "is this
  // buffed/debuffed" comparison below always reads against the true printed value. `counters`
  // deliberately doesn't factor in here — it's a separate, purely cosmetic tracker.
  const overriddenPower = card.powerOverride ?? printedPower
  const overriddenToughness = card.powerOverride !== null ? printedToughness + (card.powerOverride - printedPower) : printedToughness
  return { power: overriddenPower + ptBoost, toughness: overriddenToughness + ptBoost, basePower: printedPower }
}

/** A local goldfish-testing sandbox for one deck — shuffle, draw, drag cards onto a freeform
 *  battlefield, tap, move things to graveyard/exile, track life/turn. No rules engine and no
 *  opponent (see goldfishState.ts for the pure state logic); this component is just the
 *  rendering/drag-and-drop/hover-preview layer over it. */
export default function PlaytestGoldfishView({ storedDeck, cardDataById, onBack }: Props) {
  const commanderIds = [storedDeck.commanderId, ...(storedDeck.partnerCommanderId ? [storedDeck.partnerCommanderId] : [])]
  const [state, setState] = useState<GoldfishState>(() => newGame(storedDeck.cardIds, commanderIds))
  const battlefieldRef = useRef<HTMLDivElement>(null)
  // Library/Graveyard/Exile all stack down to their top card in the zone strip itself (see the
  // ZONE_STACK_LABELS render below) — clicking that stack opens the full list here.
  const [zoneModalOpen, setZoneModalOpen] = useState<'library' | 'graveyard' | 'exile' | null>(null)

  // Tokens this deck can create (Rat, Treasure, etc. — anything reachable via a card's own
  // all_parts) aren't part of cardDataById, which only covers the deck's own cards, so their art
  // is fetched lazily the first time each one is actually added and cached here.
  const tokens = useMemo(() => deriveTokens(Object.values(cardDataById), storedDeck.tokenPrintingOverrides), [cardDataById, storedDeck])
  const [tokenCardsById, setTokenCardsById] = useState<Record<string, ScryfallCard>>({})
  const [tokenMenuAnchor, setTokenMenuAnchor] = useState<{ x: number; y: number } | null>(null)

  // Distinct basic land names anywhere in the deck (by name, not printing — a deck can run
  // several different Island arts) — drives the "Fetch <Basic>" entries on the deck's own
  // right-click menu.
  const presentBasics = useMemo(() => {
    const names = new Set<string>()
    for (const id of storedDeck.cardIds) {
      const card = cardDataById[id]
      if (card && isBasicLand(card)) names.add(card.name)
    }
    return [...names]
  }, [storedDeck.cardIds, cardDataById])
  const [deckMenuAnchor, setDeckMenuAnchor] = useState<{ x: number; y: number } | null>(null)

  function resolveCardData(cardId: string): ScryfallCard | undefined {
    return cardDataById[cardId] ?? tokenCardsById[cardId]
  }

  // The keydown listener below only re-subscribes when hoveredInstanceId changes (see its own
  // effect deps), so it would otherwise read a stale `state` if some other action fired in
  // between — a ref always holding the latest value sidesteps that.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Looked up wherever a handler only has an instanceId (drag-and-drop, keyboard shortcuts) but
  // needs to know the card's cardId/isToken/current zone before deciding what to do.
  function findAnyCard(instanceId: string): { card: GoldfishCard; zone: GoldfishZone } | undefined {
    for (const zone of Object.keys(stateRef.current.zones) as GoldfishZone[]) {
      const card = stateRef.current.zones[zone].find((c) => c.instanceId === instanceId)
      if (card) return { card, zone }
    }
    return undefined
  }

  // Fans (overlaps) the hand's cards instead of letting the strip scroll sideways once they no
  // longer fit at full spacing — tracks the strip's own width via ResizeObserver since it's a
  // flexible (flex: 1) element that resizes with the window.
  const handStripRef = useRef<HTMLDivElement>(null)
  const [handStripWidth, setHandStripWidth] = useState(0)

  useLayoutEffect(() => {
    function measure(): void {
      if (handStripRef.current) setHandStripWidth(handStripRef.current.getBoundingClientRect().width - HAND_STRIP_INSET)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state.zones.hand.length])

  // Hover-to-enlarge preview — shown in a fixed panel to the right of the play area (see
  // .goldfish-preview-panel), not a tooltip that follows the cursor/card. Starts after a short
  // beat of hovering any tile, cleared immediately on mouse-leave. No existing pattern for this
  // elsewhere in the app to reuse; self-contained here.
  const [hoverPreview, setHoverPreview] = useState<{ card: ScryfallCard; faceIndex: number; proxyArt?: string } | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  // Separate from the (delayed) preview above — tracks whichever tile the mouse is over right
  // now, with no delay, so the T/F/E/G/X keyboard shortcuts know which card to act on.
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null)

  // Rubber-band multi-select on the battlefield — drag from empty space to select every card
  // whose tile the drag rectangle touches. Once non-empty, T/F/E/G/X (and the bulk right-click
  // menu) act on the whole selection instead of just hoveredInstanceId. Battlefield-only by
  // construction (only ever populated from battlefield tile rects), independent of zone at the
  // data level otherwise.
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<Set<string>>(new Set())
  const [bulkContextMenu, setBulkContextMenu] = useState<{ x: number; y: number } | null>(null)
  // Drag-in-progress bookkeeping lives in a ref (not state) so mousemove doesn't re-render on
  // every pixel — marqueeRect (below) is the only piece that actually needs to trigger renders,
  // and only once real dragging (past MARQUEE_DRAG_THRESHOLD) is confirmed.
  const marqueeDragRef = useRef<{
    startX: number
    startY: number
    additive: boolean
    started: boolean
    baseSelection: Set<string>
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  )

  // Mana cost pips shown right above a hand/command-zone card on hover — position: fixed,
  // computed from the tile's own rect, so it floats free of the zone strip's overflow-x:auto
  // (which would otherwise clip anything trying to escape the strip's box vertically) without
  // needing to resize any zone. Immediate, not on the same 500ms delay as the big art preview.
  const [manaCostHover, setManaCostHover] = useState<{ manaCost: string; rect: DOMRect } | null>(null)

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    }
  }, [])

  // Only a drag that starts on empty battlefield space begins a marquee — a mousedown on a card
  // tile (or its positioned slot wrapper) is left alone entirely, so tap-toggle and the
  // existing HTML5 drag-to-reposition still work exactly as before.
  const MARQUEE_DRAG_THRESHOLD = 4

  function handleBattlefieldMouseDown(e: React.MouseEvent): void {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.goldfish-battlefield__slot')) return
    marqueeDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      additive: e.shiftKey,
      started: false,
      // Captured once, here, rather than read from selectedInstanceIds later inside the
      // mousemove/mouseup listeners below — those are only ever subscribed once (see the
      // effect's empty deps), so reading component state directly in them would see whatever
      // it was at mount forever, not this drag's actual starting selection.
      baseSelection: e.shiftKey ? new Set(selectedInstanceIds) : new Set<string>()
    }
  }

  useEffect(() => {
    function hitTest(
      drag: NonNullable<typeof marqueeDragRef.current>,
      left: number,
      top: number,
      right: number,
      bottom: number
    ): Set<string> {
      const hits = new Set(drag.baseSelection)
      const board = battlefieldRef.current
      if (!board) return hits
      board.querySelectorAll<HTMLElement>('.goldfish-battlefield__slot').forEach((tile) => {
        const r = tile.getBoundingClientRect()
        const intersects = r.left < right && r.right > left && r.top < bottom && r.bottom > top
        if (intersects && tile.dataset.instanceId) hits.add(tile.dataset.instanceId)
      })
      return hits
    }

    // getBoundingClientRect forces a synchronous layout — calling that (and the state updates
    // that follow) on every single raw mousemove event was enough to starve the browser's own
    // paint until the drag actually stopped, so the highlight only ever appeared to "catch up"
    // on mouseup instead of tracking live. Coalescing to once per animation frame is the
    // standard fix: cheap arithmetic runs on every mousemove, but the expensive DOM query + the
    // React updates it drives only run at most 60 times a second, using whichever position was
    // most recent when the frame actually executes.
    let rafHandle: number | null = null
    let latestRect: { left: number; top: number; width: number; height: number } | null = null

    function flush(drag: NonNullable<typeof marqueeDragRef.current>): void {
      rafHandle = null
      if (!latestRect) return
      const { left, top, width, height } = latestRect
      setMarqueeRect({ left, top, width, height })
      setSelectedInstanceIds(hitTest(drag, left, top, left + width, top + height))
    }

    function onMouseMove(e: MouseEvent): void {
      const drag = marqueeDragRef.current
      if (!drag) return
      const left = Math.min(drag.startX, e.clientX)
      const top = Math.min(drag.startY, e.clientY)
      const width = Math.abs(e.clientX - drag.startX)
      const height = Math.abs(e.clientY - drag.startY)
      // Below threshold and never yet confirmed as a real drag — skip entirely so a plain click
      // never flashes a 0-ish-size box or touches the selection.
      if (!drag.started && width < MARQUEE_DRAG_THRESHOLD && height < MARQUEE_DRAG_THRESHOLD) return
      drag.started = true
      latestRect = { left, top, width, height }
      if (rafHandle === null) rafHandle = requestAnimationFrame(() => flush(drag))
    }

    function onMouseUp(): void {
      const drag = marqueeDragRef.current
      marqueeDragRef.current = null
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      setMarqueeRect(null)
      // A plain click on empty battlefield space (never crossed the drag threshold) clears the
      // selection, unless shift was held — shift-clicking empty space shouldn't wipe out what's
      // already selected. A real drag already left selectedInstanceIds exactly right as of the
      // last flushed frame, so there's nothing further to compute here.
      if (drag && !drag.started && !drag.additive) setSelectedInstanceIds(new Set())
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (rafHandle !== null) cancelAnimationFrame(rafHandle)
    }
  }, [])

  function handleHoverStart(cardData: ScryfallCard | undefined, faceIndex: number, proxyArt?: string): void {
    if (!cardData) return
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => setHoverPreview({ card: cardData, faceIndex, proxyArt }), 500)
  }

  function handleHoverEnd(): void {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHoverPreview(null)
  }

  // Yellow "card drawn" / "library shuffled" callout above the battlefield — see
  // .goldfish-action-toast. Self-clears after a couple of seconds.
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const actionTimerRef = useRef<number | null>(null)

  function showAction(message: string): void {
    if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current)
    setActionMessage(message)
    actionTimerRef.current = window.setTimeout(() => setActionMessage(null), 2200)
  }

  useEffect(() => {
    return () => {
      if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current)
    }
  }, [])

  function handleShuffle(): void {
    setState(shuffleLibrary)
    showAction('Library shuffled')
    playShuffleSound()
  }

  function handleDraw(): void {
    setState((s) => (s.zones.library.length > 0 ? drawCard(s) : s))
    showAction('Card drawn')
    playDrawSound()
  }

  function handleNextTurn(): void {
    setState(nextTurn)
    showAction('Turn advanced — card drawn')
    playDrawSound()
  }

  // Sound for wherever a card actually lands after a move — skipped by callers when the move is
  // just a same-zone reposition (battlefield drag) or a token vanishing instead of relocating.
  function playZoneSound(toZone: GoldfishZone): void {
    if (toZone === 'graveyard') playGraveyardSound()
    else if (toZone === 'exile') playExileSound()
    else if (toZone === 'battlefield') playEtbSound()
    else if (toZone === 'hand') playDrawSound()
  }

  // T/F/E/G/X act on the marquee selection when one exists, falling back to whichever card the
  // mouse is currently over otherwise; S/D/V/N mirror the side buttons and work regardless of
  // hover/selection. Ignored while typing into a field (the Set Power prompt) or while a
  // modifier key is held, so this doesn't fight the OS/browser's own shortcuts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const key = e.key.toLowerCase()
      if (key === 's') return handleShuffle()
      if (key === 'd') return handleDraw()
      if (key === 'v') return setZoneModalOpen('library')
      if (key === 'n') return handleNextTurn()
      if (e.key === 'Escape' && selectedInstanceIds.size > 0) {
        setSelectedInstanceIds(new Set())
        return
      }
      if (selectedInstanceIds.size > 0) {
        const ids = [...selectedInstanceIds]
        if (key === 't') {
          setState((s) => ids.reduce((acc, id) => toggleTap(acc, id), s))
        } else if (key === 'f') {
          setState((s) => ids.reduce((acc, id) => flipCard(acc, id), s))
          playFlipSound()
        } else if (key === 'e') {
          setState((s) => ids.reduce((acc, id) => moveCard(acc, id, 'exile'), s))
          showAction(`${ids.length} cards exiled`)
          playZoneSound('exile')
        } else if (key === 'g') {
          setState((s) => ids.reduce((acc, id) => moveCard(acc, id, 'graveyard'), s))
          showAction(`${ids.length} cards sent to graveyard`)
          playZoneSound('graveyard')
        } else if (key === 'x') {
          setState((s) => ids.reduce((acc, id) => copyCard(acc, id), s))
          playEtbSound()
          showAction(`${ids.length} cards copied`)
        }
        return
      }
      if (!hoveredInstanceId) return
      if (key === 't') setState((s) => toggleTap(s, hoveredInstanceId))
      else if (key === 'f') {
        setState((s) => flipCard(s, hoveredInstanceId))
        playFlipSound()
      } else if (key === 'e') {
        const found = findAnyCard(hoveredInstanceId)
        setState((s) => moveCard(s, hoveredInstanceId, 'exile'))
        if (found?.card.isToken && found.zone !== 'exile') showAction('Token removed')
        else {
          showAction('Card exiled')
          playZoneSound('exile')
        }
      } else if (key === 'g') {
        const found = findAnyCard(hoveredInstanceId)
        setState((s) => moveCard(s, hoveredInstanceId, 'graveyard'))
        if (found?.card.isToken && found.zone !== 'graveyard') showAction('Token removed')
        else {
          showAction('Card sent to graveyard')
          playZoneSound('graveyard')
        }
      } else if (key === 'x') {
        setState((s) => copyCard(s, hoveredInstanceId))
        playEtbSound()
        showAction('Card copied')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredInstanceId, selectedInstanceIds])

  function handleDragStart(e: React.DragEvent, instanceId: string): void {
    e.dataTransfer.setData('text/plain', instanceId)
    e.dataTransfer.effectAllowed = 'move'
  }

  // Library is face-down (a card-back stack, not a per-card renderTile), but dragging it out
  // means the top card is being drawn/peeked, so the drag ghost should show its actual face —
  // an off-screen <img> (see the hidden element in the Library zone below) doubles as the
  // pre-loaded source setDragImage needs.
  const topLibraryCard = state.zones.library[0] as GoldfishCard | undefined
  const topLibraryArt = topLibraryCard ? cardImageSmall(resolveCardData(topLibraryCard.cardId)) : undefined
  const libraryDragImgRef = useRef<HTMLImageElement>(null)

  function handleLibraryDragStart(e: React.DragEvent): void {
    if (!topLibraryCard) return
    e.dataTransfer.setData('text/plain', topLibraryCard.instanceId)
    e.dataTransfer.effectAllowed = 'move'
    if (libraryDragImgRef.current) e.dataTransfer.setDragImage(libraryDragImgRef.current, 42, 58)
  }

  function handleZoneDrop(e: React.DragEvent, zone: GoldfishZone): void {
    e.preventDefault()
    const instanceId = e.dataTransfer.getData('text/plain')
    if (!instanceId) return
    const found = findAnyCard(instanceId)
    // The command zone only ever holds this deck's own commander(s) — everything else (a token,
    // a land you dragged there by mistake) just bounces off, dimensions unchanged either way.
    if (zone === 'command' && (!found || !commanderIds.includes(found.card.cardId))) {
      showAction('Only the commander can go to the Command Zone')
      return
    }
    const isTokenRemoval = found?.card.isToken && found.zone !== zone && zone !== 'battlefield'
    if (isTokenRemoval) showAction('Token removed')
    else if (found && found.zone !== zone) playZoneSound(zone)
    setState((s) => moveCard(s, instanceId, zone))
  }

  function handleBattlefieldDrop(e: React.DragEvent): void {
    e.preventDefault()
    const instanceId = e.dataTransfer.getData('text/plain')
    if (!instanceId || !battlefieldRef.current) return
    const found = findAnyCard(instanceId)
    if (found && found.zone !== 'battlefield') playEtbSound()
    const rect = battlefieldRef.current.getBoundingClientRect()
    const x = Math.min(96, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(92, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100))
    setState((s) => moveCard(s, instanceId, 'battlefield', { x, y }))
  }

  async function handleAddToken(token: DerivedToken): Promise<void> {
    setTokenMenuAnchor(null)
    let data = tokenCardsById[token.id]
    if (!data) {
      const result = await window.api.getCard(token.id)
      if (isError(result)) return
      data = result as ScryfallCard
      setTokenCardsById((prev) => ({ ...prev, [token.id]: data! }))
    }
    const x = 45 + Math.random() * 10
    const y = 20 + Math.random() * 10
    setState((s) => addToken(s, token.id, { x, y }))
    showAction(`${token.name} token created`)
    playEtbSound()
  }

  // "Fetch <Basic>" — searches the LIBRARY specifically (not the whole deck; copies already
  // drawn/in play aren't available to fetch), by name since a deck can run several arts of the
  // same basic.
  function handleFetchBasic(name: string): void {
    setDeckMenuAnchor(null)
    const match = state.zones.library.find((c) => resolveCardData(c.cardId)?.name === name)
    if (!match) {
      showAction(`No ${name} left in library`)
      return
    }
    setState((s) => moveCard(s, match.instanceId, 'hand'))
    showAction(`${name} fetched to hand`)
    playDrawSound()
  }

  function handleMillTopCard(toZone: 'graveyard' | 'exile'): void {
    setDeckMenuAnchor(null)
    const top = state.zones.library[0]
    if (!top) return
    setState((s) => moveCard(s, top.instanceId, toZone))
    showAction(toZone === 'graveyard' ? 'Card sent to graveyard' : 'Card exiled')
    playZoneSound(toZone)
  }

  function deckMenuActions(): { label: string; onSelect: () => void }[] {
    return [
      ...presentBasics.map((name) => ({ label: `Fetch ${name}`, onSelect: () => handleFetchBasic(name) })),
      { label: 'Move Top Card to Graveyard', onSelect: () => handleMillTopCard('graveyard') },
      { label: 'Move Top Card to Exile', onSelect: () => handleMillTopCard('exile') }
    ]
  }

  // Left-edge-to-left-edge distance between consecutive hand cards. Full spacing (card width +
  // the strip's normal gap) as long as the hand fits; otherwise shrinks — cards overlapping —
  // just enough to make the whole hand span exactly the strip's measured width.
  function handCardPitch(count: number): number {
    const fullPitch = HAND_CARD_WIDTH + HAND_CARD_GAP
    if (count <= 1 || handStripWidth <= 0) return fullPitch
    const naturalWidth = HAND_CARD_WIDTH + (count - 1) * fullPitch
    if (naturalWidth <= handStripWidth) return fullPitch
    return Math.max(HAND_MIN_PITCH, (handStripWidth - HAND_CARD_WIDTH) / (count - 1))
  }

  const [contextMenu, setContextMenu] = useState<{ card: GoldfishCard; zone: GoldfishZone; x: number; y: number } | null>(null)
  const [powerPrompt, setPowerPrompt] = useState<{ instanceId: string; value: string } | null>(null)
  // instanceIds (plural) so the same prompt serves both the single-card "Add Counter Type" menu
  // item and the bulk "Add Counter Type to All" one — one label typed once, applied to every id.
  const [counterTypePrompt, setCounterTypePrompt] = useState<{ instanceIds: string[]; value: string } | null>(null)
  const [inspectingCard, setInspectingCard] = useState<ScryfallCard | null>(null)

  // A token leaving the battlefield for anywhere else just vanishes (see moveCard) — the caller
  // still has to pick the right toast message for that instead of the normal "Card exiled" etc.
  function moveAndAnnounce(card: GoldfishCard, fromZone: GoldfishZone, toZone: GoldfishZone, message: string | null, libraryEdge?: 'top' | 'bottom'): void {
    const isTokenRemoval = card.isToken && fromZone !== toZone && toZone !== 'battlefield'
    if (isTokenRemoval) showAction('Token removed')
    else {
      if (message) showAction(message)
      if (fromZone !== toZone) playZoneSound(toZone)
    }
    setState((s) => moveCard(s, card.instanceId, toZone, undefined, libraryEdge))
  }

  function contextMenuActions(card: GoldfishCard, zone: GoldfishZone): { label: string; onSelect: () => void }[] {
    const close = () => setContextMenu(null)
    const actions: { label: string; onSelect: () => void }[] = [
      {
        label: 'Add Counter Type',
        onSelect: () => {
          close()
          setCounterTypePrompt({ instanceIds: [card.instanceId], value: '' })
        }
      },
      // +1/-1 on an existing type happens directly on its own badge (click/right-click, see
      // renderTile) — this only ever needs to offer removing a type entirely, one entry per
      // type the card actually has.
      ...card.counters.map((entry, index) => ({
        label: `Remove "${entry.label}" Counters`,
        onSelect: () => {
          setState((s) => removeCounterType(s, card.instanceId, index))
          close()
        }
      })),
      {
        label: 'Set Power',
        onSelect: () => {
          close()
          const stats = effectiveStats(card, resolveCardData(card.cardId))
          setPowerPrompt({ instanceId: card.instanceId, value: stats ? String(stats.power) : '' })
        }
      },
      { label: card.tapped ? 'Untap' : 'Tap', onSelect: () => { setState((s) => toggleTap(s, card.instanceId)); close() } },
      {
        label: card.faceDown ? 'Flip Face Up' : 'Flip',
        onSelect: () => { setState((s) => flipCard(s, card.instanceId)); playFlipSound(); close() }
      }
    ]
    if (isTransformable(resolveCardData(card.cardId))) {
      actions.push({
        label: card.transformed ? 'Transform Back' : 'Transform',
        onSelect: () => { setState((s) => transformCard(s, card.instanceId)); playFlipSound(); close() }
      })
    }
    if (zone !== 'graveyard') {
      actions.push({ label: 'Send to Graveyard', onSelect: () => { moveAndAnnounce(card, zone, 'graveyard', 'Card sent to graveyard'); close() } })
    }
    if (zone !== 'exile') {
      actions.push({ label: 'Move to Exile', onSelect: () => { moveAndAnnounce(card, zone, 'exile', 'Card exiled'); close() } })
    }
    if (zone !== 'hand') {
      actions.push({ label: 'Move to Hand', onSelect: () => { moveAndAnnounce(card, zone, 'hand', null); close() } })
    }
    actions.push(
      { label: 'Move to Top of Library', onSelect: () => { moveAndAnnounce(card, zone, 'library', null, 'top'); close() } },
      { label: 'Move to Bottom of Library', onSelect: () => { moveAndAnnounce(card, zone, 'library', null, 'bottom'); close() } },
      {
        label: 'Copy Card',
        onSelect: () => { setState((s) => copyCard(s, card.instanceId)); showAction('Card copied'); playEtbSound(); close() }
      },
      {
        label: 'Inspect Card',
        onSelect: () => {
          close()
          const data = resolveCardData(card.cardId)
          if (data) setInspectingCard(data)
        }
      }
    )
    return actions
  }

  // Bulk equivalents of contextMenuActions' per-card actions, for the marquee-selection right-
  // click menu — each just loops the same single-card state function over every selected
  // instance in one setState call, matching how the T/F/E/G/X keyboard shortcuts treat a
  // selection the same way (see the keydown handler below). Deliberately narrower than the
  // single-card menu: Set Power and Inspect Card don't generalize to a group of different cards,
  // and bulk library placement is skipped since repeatedly prepending "to the top" one at a time
  // would just reverse the selection's order for no real benefit.
  function bulkContextMenuActions(ids: string[]): { label: string; onSelect: () => void }[] {
    const close = () => setBulkContextMenu(null)
    const count = ids.length
    const anyTransformable = ids.some((id) => {
      const card = state.zones.battlefield.find((c) => c.instanceId === id)
      return card ? isTransformable(resolveCardData(card.cardId)) : false
    })
    const actions: { label: string; onSelect: () => void }[] = [
      {
        label: `Toggle Tap (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => toggleTap(acc, id), s))
          close()
        }
      },
      {
        label: `Flip (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => flipCard(acc, id), s))
          playFlipSound()
          close()
        }
      }
    ]
    if (anyTransformable) {
      actions.push({
        label: `Transform (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => transformCard(acc, id), s))
          playFlipSound()
          close()
        }
      })
    }
    actions.push(
      {
        // Adds a brand-new counter type to every selected card at once (one label, typed once)
        // — bulk +1/-1 on an EXISTING type doesn't generalize the same way single-card actions
        // do, since different cards in a selection can be tracking entirely different types.
        label: `Add Counter Type to All (${count})`,
        onSelect: () => {
          close()
          setCounterTypePrompt({ instanceIds: ids, value: '' })
        }
      },
      {
        label: `Send to Graveyard (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => moveCard(acc, id, 'graveyard'), s))
          showAction(`${count} cards sent to graveyard`)
          playGraveyardSound()
          close()
        }
      },
      {
        label: `Move to Exile (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => moveCard(acc, id, 'exile'), s))
          showAction(`${count} cards exiled`)
          playExileSound()
          close()
        }
      },
      {
        label: `Move to Hand (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => moveCard(acc, id, 'hand'), s))
          showAction(`${count} cards returned to hand`)
          playDrawSound()
          close()
        }
      },
      {
        label: `Copy All (${count})`,
        onSelect: () => {
          setState((s) => ids.reduce((acc, id) => copyCard(acc, id), s))
          showAction(`${count} cards copied`)
          playEtbSound()
          close()
        }
      }
    )
    return actions
  }

  function handleConfirmPower(): void {
    if (!powerPrompt) return
    const value = parseInt(powerPrompt.value, 10)
    if (!Number.isNaN(value)) setState((s) => setPowerOverride(s, powerPrompt.instanceId, value))
    setPowerPrompt(null)
  }

  function handleConfirmCounterType(): void {
    if (!counterTypePrompt) return
    const label = counterTypePrompt.value.trim()
    if (label) {
      setState((s) => counterTypePrompt.instanceIds.reduce((acc, id) => addCounterType(acc, id, label), s))
    }
    setCounterTypePrompt(null)
  }

  function renderTile(card: GoldfishCard, zone: GoldfishZone, onClick?: () => void) {
    const cardData = resolveCardData(card.cardId)
    const faceIndex = card.transformed && isTransformable(cardData) ? 1 : 0
    const displayName = cardData?.card_faces?.[faceIndex]?.name ?? cardData?.name
    // A user-uploaded skin (see StoredDeck.proxyArtByKey) always wins over the card's real art —
    // but not over face-down (that's hidden information, not a skin) or a token/copy (nothing
    // in the deck's own proxy art list was ever meant for a card that doesn't really exist).
    // transformed picks the back skin the same way it already picks the back's real art above.
    const proxyArtEntry = cardData && !card.isToken ? storedDeck.proxyArtByKey?.[cardData.oracle_id] : undefined
    const proxyArt = faceIndex === 1 ? proxyArtEntry?.back : proxyArtEntry?.front
    const art = card.faceDown ? CARD_BACK_URL : proxyArt ?? cardImageSmall(cardData, faceIndex)
    const onBattlefield = zone === 'battlefield'
    const stats = onBattlefield ? effectiveStats(card, cardData) : null
    const isSelected = onBattlefield && selectedInstanceIds.has(card.instanceId)
    return (
      <div
        key={card.instanceId}
        className={`goldfish-card ${card.tapped ? 'is-tapped' : ''} ${isSelected ? 'is-selected' : ''}`}
        draggable
        onDragStart={(e) => handleDragStart(e, card.instanceId)}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          // Right-clicking a card that's part of a multi-card selection opens the bulk menu
          // instead of the normal single-card one — right-clicking anything else (including a
          // selected card while nothing else is selected) keeps the single-card menu, same as
          // before this feature existed.
          if (onBattlefield && selectedInstanceIds.size > 1 && selectedInstanceIds.has(card.instanceId)) {
            setBulkContextMenu({ x: e.clientX, y: e.clientY })
          } else {
            setContextMenu({ card, zone, x: e.clientX, y: e.clientY })
          }
        }}
        onMouseEnter={(e) => {
          handleHoverStart(cardData, faceIndex, proxyArt)
          setHoveredInstanceId(card.instanceId)
          const manaCost = cardData?.mana_cost ?? cardData?.card_faces?.[0]?.mana_cost
          if ((zone === 'hand' || zone === 'command') && manaCost) {
            setManaCostHover({ manaCost, rect: e.currentTarget.getBoundingClientRect() })
          }
        }}
        onMouseLeave={() => {
          handleHoverEnd()
          setHoveredInstanceId((id) => (id === card.instanceId ? null : id))
          setManaCostHover(null)
        }}
        title={displayName}
      >
        {art ? <img src={art} alt={displayName ?? ''} draggable={false} /> : <div className="goldfish-card__placeholder" />}
        {card.isCopy && <div className="goldfish-card__copy-badge">COPY</div>}
        {stats && (
          <div
            className={`goldfish-card__power ${stats.power > stats.basePower ? 'is-buffed' : stats.power < stats.basePower ? 'is-debuffed' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setState((s) => adjustPtBoost(s, card.instanceId, 1))
              playCounterSound()
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setState((s) => adjustPtBoost(s, card.instanceId, -1))
              playCounterSound()
            }}
            title="Left-click: +1/+1 · Right-click: -1/-1"
          >
            {stats.power}/{stats.toughness}
          </div>
        )}
        {onBattlefield &&
          card.counters.map((entry, index) => (
            <div
              key={index}
              className="goldfish-card__counter"
              style={{
                bottom: `${3 + index * 18}px`,
                // Border + text color, not a solid fill — a couple of the palette entries
                // (gold, light green) are too light for the badge's own number to stay readable
                // against them as a background, so the dark base fill stays constant and the
                // per-type color shows as a colored ring instead.
                borderColor: COUNTER_TYPE_COLORS[index % COUNTER_TYPE_COLORS.length],
                color: COUNTER_TYPE_COLORS[index % COUNTER_TYPE_COLORS.length]
              }}
              onClick={(e) => {
                e.stopPropagation()
                setState((s) => adjustCounterAt(s, card.instanceId, index, 1))
                playCounterSound()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setState((s) => adjustCounterAt(s, card.instanceId, index, -1))
                playCounterSound()
              }}
              title={`${entry.label} · Left-click: +1 · Right-click: -1`}
            >
              {entry.count}
            </div>
          ))}
      </div>
    )
  }

  return (
    <div className="app__results goldfish-page">
      <div className="app__results-toolbar">
        <button className="back-link back-link--nav" onClick={onBack}>
          ← Back to Deck
        </button>
        <h2 className="set-detail__title">Playtest — {storedDeck.name}</h2>
        <div className="goldfish-controls">
          <div className="goldfish-life">
            <span className="app__hint">Life</span>
            <button className="secondary-button" onClick={() => setState((s) => setLife(s, -1))}>
              −
            </button>
            <span className="goldfish-life__value">{state.life}</span>
            <button className="secondary-button" onClick={() => setState((s) => setLife(s, 1))}>
              +
            </button>
          </div>
          <div className="goldfish-turn">
            <span className="app__hint">Turn {state.turn}</span>
            <button className="primary-button" onClick={handleNextTurn} title="Shortcut: N">
              {withShortcut('Next Turn', 'N')}
            </button>
          </div>
          <button className="secondary-button" onClick={() => setState(newGame(storedDeck.cardIds, commanderIds))}>
            Restart
          </button>
        </div>
      </div>

      <div className="goldfish-layout">
        <div
          className="goldfish-battlefield"
          ref={battlefieldRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleBattlefieldDrop}
          onMouseDown={handleBattlefieldMouseDown}
        >
          {actionMessage && <div className="goldfish-action-toast">{actionMessage}</div>}
          {state.zones.battlefield.map((card) => (
            <div
              key={card.instanceId}
              className="goldfish-battlefield__slot"
              data-instance-id={card.instanceId}
              style={{ left: `${card.x}%`, top: `${card.y}%` }}
            >
              {renderTile(card, 'battlefield', () => setState((s) => toggleTap(s, card.instanceId)))}
            </div>
          ))}
          {marqueeRect &&
            createPortal(
              <div
                className="goldfish-marquee"
                style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
              />,
              document.body
            )}
        </div>

        {/* Buttons and the hover preview share one right-hand column so the preview's left edge
            lines up with the buttons' left edge for free, and the battlefield only loses width
            to a single gap instead of two separate side columns. */}
        <div className="goldfish-side-panel">
          <div className="goldfish-actions">
            <button className="secondary-button" onClick={handleShuffle} title="Shortcut: S">
              {withShortcut('Shuffle', 'S')}
            </button>
            <button className="secondary-button" onClick={handleDraw} disabled={state.zones.library.length === 0} title="Shortcut: D">
              {withShortcut('Draw', 'D')}
            </button>
            <button className="secondary-button" onClick={() => setZoneModalOpen('library')} title="Shortcut: V">
              {withShortcut('View Library', 'V')}
            </button>
            <button
              className="secondary-button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setTokenMenuAnchor({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              Add Token ▾
            </button>
          </div>

          {/* Bottom-anchored (see .goldfish-preview-panel) so the preview lines up with the
              battlefield's own bottom edge, not wherever the hovered card happens to sit. */}
          <div className="goldfish-preview-panel">
            {hoverPreview && (
              <img
                src={hoverPreview.proxyArt ?? cardImageNormal(hoverPreview.card, hoverPreview.faceIndex)}
                alt={hoverPreview.card.card_faces?.[hoverPreview.faceIndex]?.name ?? hoverPreview.card.name}
              />
            )}
          </div>
        </div>
      </div>

      <div className="goldfish-zones">
        <div
          className="goldfish-zone goldfish-zone--hand"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => handleZoneDrop(e, 'hand')}
        >
          <h3 className="section-heading">Hand ({state.zones.hand.length})</h3>
          <div className="goldfish-zone__strip goldfish-zone__strip--hand" ref={handStripRef}>
            {state.zones.hand.map((card, index) => {
              const pitch = handCardPitch(state.zones.hand.length)
              return (
                <div
                  key={card.instanceId}
                  className="goldfish-hand-slot"
                  style={{ marginLeft: index === 0 ? 0 : `${pitch - HAND_CARD_WIDTH}px`, zIndex: index }}
                >
                  {renderTile(card, 'hand')}
                </div>
              )
            })}
          </div>
        </div>

        <div className="goldfish-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleZoneDrop(e, 'library')}>
          <h3 className="section-heading">Library ({state.zones.library.length})</h3>
          <div className="goldfish-zone__strip">
            {state.zones.library.length > 0 ? (
              <div
                className="goldfish-card goldfish-card--library-stack"
                title="Library"
                draggable
                onDragStart={handleLibraryDragStart}
                onClick={() => setZoneModalOpen('library')}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setDeckMenuAnchor({ x: e.clientX, y: e.clientY })
                }}
                onMouseEnter={() => topLibraryCard && setHoveredInstanceId(topLibraryCard.instanceId)}
                onMouseLeave={() => setHoveredInstanceId((id) => (id === topLibraryCard?.instanceId ? null : id))}
              >
                <img src={CARD_BACK_URL} alt="Library" draggable={false} />
              </div>
            ) : (
              <div className="goldfish-card goldfish-card--library-stack">
                <div className="goldfish-card__placeholder" />
              </div>
            )}
            {/* Off-screen but loaded — setDragImage needs an already-decoded <img> to show the
                top card's real face while it's being dragged out, instead of the face-down back
                the stack itself displays. */}
            {topLibraryArt && (
              <img ref={libraryDragImgRef} src={topLibraryArt} alt="" className="goldfish-drag-source" />
            )}
          </div>
        </div>

        <div className="goldfish-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleZoneDrop(e, 'graveyard')}>
          <h3 className="section-heading" title="Shortcut: G (while hovering a card)">
            {withShortcut(`Graveyard (${state.zones.graveyard.length})`, 'G')}
          </h3>
          <div className="goldfish-zone__strip" onClick={() => state.zones.graveyard.length > 0 && setZoneModalOpen('graveyard')}>
            {state.zones.graveyard.length > 0 ? (
              renderTile(state.zones.graveyard[state.zones.graveyard.length - 1], 'graveyard')
            ) : (
              <div className="goldfish-card goldfish-card--library-stack">
                <div className="goldfish-card__placeholder" />
              </div>
            )}
          </div>
        </div>

        <div className="goldfish-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleZoneDrop(e, 'exile')}>
          <h3 className="section-heading" title="Shortcut: E (while hovering a card)">
            {withShortcut(`Exile (${state.zones.exile.length})`, 'E')}
          </h3>
          <div className="goldfish-zone__strip" onClick={() => state.zones.exile.length > 0 && setZoneModalOpen('exile')}>
            {state.zones.exile.length > 0 ? (
              renderTile(state.zones.exile[state.zones.exile.length - 1], 'exile')
            ) : (
              <div className="goldfish-card goldfish-card--library-stack">
                <div className="goldfish-card__placeholder" />
              </div>
            )}
          </div>
        </div>

        <div className="goldfish-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleZoneDrop(e, 'command')}>
          <h3 className="section-heading">Command Zone</h3>
          <div className="goldfish-zone__strip goldfish-zone__strip--command">
            {state.zones.command.length > 0 ? (
              state.zones.command.map((card) => renderTile(card, 'command'))
            ) : (
              <div className="goldfish-card goldfish-card--library-stack">
                <div className="goldfish-card__placeholder" />
              </div>
            )}
            {commanderIds.map((id, i) =>
              (state.commanderTax[id] ?? 0) > 0 ? (
                <div
                  key={id}
                  className="goldfish-command-tax"
                  style={{ top: `${2 + i * 16}px` }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setState((s) => adjustCommanderTax(s, id, 1))
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setState((s) => adjustCommanderTax(s, id, -1))
                  }}
                  title="Commander tax · Left-click: +1 cast · Right-click: -1 cast"
                >
                  +{(state.commanderTax[id] ?? 0) * 2}
                </div>
              ) : null
            )}
          </div>
        </div>
      </div>

      {zoneModalOpen && (
        <div className="card-detail-overlay" onClick={() => setZoneModalOpen(null)}>
          <div className="playtest-analysis-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={() => setZoneModalOpen(null)}>
              ×
            </button>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              {ZONE_MODAL_LABELS[zoneModalOpen]} ({state.zones[zoneModalOpen].length})
            </h3>
            {zoneModalOpen === 'library' && <p className="app__hint">Top of library first.</p>}
            <div className="card-grid card-grid--compact">
              {state.zones[zoneModalOpen].map((card) => {
                const cardData = resolveCardData(card.cardId)
                return cardData ? (
                  <div
                    key={card.instanceId}
                    className="goldfish-card"
                    title={cardData.name}
                    draggable
                    onDragStart={(e) => {
                      handleDragStart(e, card.instanceId)
                      // Deferred a tick — closing synchronously here unmounts this element
                      // before the browser finishes capturing the drag image/starting the drag,
                      // which was cancelling the drag outright instead of letting it continue.
                      // By the time this fires the drag is already underway, so removing the
                      // modal (revealing the real zone underneath, not its darkened backdrop)
                      // no longer disturbs it.
                      setTimeout(() => setZoneModalOpen(null), 0)
                    }}
                  >
                    <img src={cardImageSmall(cardData)} alt={cardData.name} draggable={false} />
                  </div>
                ) : null
              })}
            </div>
          </div>
        </div>
      )}

      {deckMenuAnchor && (
        <CardContextMenu x={deckMenuAnchor.x} y={deckMenuAnchor.y} onClose={() => setDeckMenuAnchor(null)} actions={deckMenuActions()} />
      )}

      {tokenMenuAnchor && (
        <CardContextMenu
          x={tokenMenuAnchor.x}
          y={tokenMenuAnchor.y}
          onClose={() => setTokenMenuAnchor(null)}
          actions={
            tokens.length > 0
              ? tokens.map((token) => ({ label: token.name, onSelect: () => handleAddToken(token) }))
              : [{ label: 'This deck creates no tokens', onSelect: () => setTokenMenuAnchor(null) }]
          }
        />
      )}

      {contextMenu && (
        <CardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={contextMenuActions(contextMenu.card, contextMenu.zone)}
        />
      )}

      {bulkContextMenu && (
        <CardContextMenu
          x={bulkContextMenu.x}
          y={bulkContextMenu.y}
          onClose={() => setBulkContextMenu(null)}
          actions={bulkContextMenuActions([...selectedInstanceIds])}
        />
      )}

      {powerPrompt && (
        <div className="card-detail-overlay" onClick={() => setPowerPrompt(null)}>
          <div className="goldfish-power-prompt" onClick={(e) => e.stopPropagation()}>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Set Power/Toughness
            </h3>
            <input
              type="number"
              className="goldfish-power-prompt__input"
              value={powerPrompt.value}
              autoFocus
              onChange={(e) => setPowerPrompt({ ...powerPrompt, value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmPower()}
            />
            <div className="goldfish-power-prompt__actions">
              <button className="secondary-button" onClick={() => setPowerPrompt(null)}>
                Cancel
              </button>
              <button className="primary-button" onClick={handleConfirmPower}>
                Set
              </button>
            </div>
          </div>
        </div>
      )}

      {counterTypePrompt && (
        <div className="card-detail-overlay" onClick={() => setCounterTypePrompt(null)}>
          <div className="goldfish-power-prompt" onClick={(e) => e.stopPropagation()}>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              Add Counter Type
            </h3>
            <input
              type="text"
              className="goldfish-power-prompt__input"
              placeholder="e.g. +1/+1, Loyalty, Poison…"
              value={counterTypePrompt.value}
              autoFocus
              onChange={(e) => setCounterTypePrompt({ ...counterTypePrompt, value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmCounterType()}
            />
            <div className="goldfish-power-prompt__actions">
              <button className="secondary-button" onClick={() => setCounterTypePrompt(null)}>
                Cancel
              </button>
              <button className="primary-button" onClick={handleConfirmCounterType} disabled={!counterTypePrompt.value.trim()}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {inspectingCard && <CardDetail card={inspectingCard} onClose={() => setInspectingCard(null)} minimal />}

      {manaCostHover && (
        <div
          className="goldfish-mana-hover"
          style={{ top: manaCostHover.rect.top, left: manaCostHover.rect.left + manaCostHover.rect.width / 2 }}
        >
          {parseManaCostSymbols(manaCostHover.manaCost).map((symbol, i) => (
            <img key={i} src={manaSymbolUrl(symbol)} alt={symbol} className="goldfish-mana-hover__pip" />
          ))}
        </div>
      )}
    </div>
  )
}
