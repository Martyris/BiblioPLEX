import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isError, type LogicRule, type ScryfallCard, type StoredDeck } from '../types'
import { deriveTokens, landTier, producedColorKey } from '../deckLogic'
import { scryfallImageUrl } from '../scryfallImage'
import { cardImageCache, cardDataByName } from '../playtestCardCache'
import CardDetail from './CardDetail'
import PlaytestAnalysisView from './PlaytestAnalysisView'
import ColorPips from './ColorPips'
import { colorIdentityGradient } from '../colorIdentityName'
import { bracketColor } from '../bracketColor'
import { winRate, winRateColor } from '../winRate'
import { scoreColor } from '../deckScore'
import {
  playCastSound,
  playCounterSound,
  playDamageSound,
  playDiscardSound,
  playDrawSound,
  playEtbSound,
  playExileSound,
  playGraveyardSound
} from '../playtestSound'

// Locally declared, same "hand-duplicate rather than share" convention as PreconsBrowser.tsx —
// only the fields this view actually needs.
interface PreconDeck {
  id: string
  name: string
  commanderId: string
  commanderName: string
  partnerCommanderId: string | null
  partnerCommanderName: string | null
  cardIds: string[]
}

type SourceKind = 'deck' | 'precon'

interface ParticipantSlot {
  source: SourceKind
  id: string | null
}

interface GameSimStatus {
  phase: 'idle' | 'starting' | 'ready' | 'error'
  error?: string
}

interface GameSimResult {
  winner: string
  turns: number
  gameMs: number
}

interface GameSimPermanent {
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
interface GameSimCardRef {
  name: string
  setCode: string
  collectorNumber: string
}

interface GameSimCommandZoneCard extends GameSimCardRef {
  tax: number
}

interface GameSimCommanderDamage {
  commanderName: string
  amount: number
}

// Exactly one of playerName/permanentId is set — whichever kind of thing this chosen target
// resolved to (see java-bridge's Main.java emitSnapshot()). A target that isn't a player or a
// battlefield permanent (a card in a graveyard/hand, another stack object) is omitted entirely,
// since there's no stable on-screen anchor to draw an arrow to for those.
interface GameSimStackTarget {
  playerName?: string
  permanentId?: string
}

interface GameSimStackObject {
  id: string
  name: string
  sourceName: string
  controller: string
  setCode: string
  collectorNumber: string
  targets: GameSimStackTarget[]
}

interface GameSimProgressPlayer {
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

interface GameSimProgress {
  id: string
  turn: number
  step: string
  stack: GameSimStackObject[]
  players: GameSimProgressPlayer[]
  // One action's worth of narration (empty for the before/after-game bookend snapshots) — each
  // progress tick now pairs 1:1 with the action that produced it (see java-bridge's Main.java),
  // not a batch of lines accumulated over a fixed time window.
  logLine: string
}

const SLOT_LABELS = ['Player 1', 'Player 2', 'Player 3', 'Player 4']

// A floating "+3"/"-5" badge shown next to a seat's life total right after it changes — nonce
// (not just delta) is what the flash span keys off, so two changes of the same size in a row
// (e.g. two separate 1-damage pings) each get their own pop-in animation instead of the second
// one being a no-op re-render of an unchanged prop value.
interface LifeFlash {
  delta: number
  nonce: number
}

// Permanents only carry a name over the wire (that's all XMage gives us) — resolved to Scryfall
// art via a fuzzy-name lookup, cached module-wide since the same name (e.g. "Goblin Token"
// repeated 30 times on one board) should only ever be fetched once for the whole app session.
// cardImageCache/cardDataByName live in playtestCardCache.ts (not here) so PlaytestAnalysisView
// can import them too without a circular import between the two components.

// Populated once per game (see handleWatchGame) from the same card data already fetched for
// deck-building — real token art keyed by the token's name, since XMage only ever gives us a
// bare name for a battlefield permanent and a generic Scryfall name search for something like
// "Clue Token" typically doesn't resolve (the real card is usually just named "Clue"). Using
// the exact tokens THESE decks actually produce (deriveTokens, already used by the deck
// builder's own Tokens Needed panel) sidesteps that entirely.
const tokenImageCache = new Map<string, string>()

// Keyed by `${setCode}|${collectorNumber}` — the EXACT printing XMage reports a permanent as
// being (see Main.java's setCode/collectorNumber fields), populated in handleWatchGame from the
// same getCardsByIds fetch that already resolves every deck card by its real printing id. A
// bare card name can't tell two differently-arted copies of the same card apart (most commonly
// basic lands — a deck can freely mix several different Forest arts), which was a real bug:
// battlefield lands were always showing whichever one printing happened to win the name-keyed
// cache, ignoring what was actually chosen in deck building.
const cardDataBySetNumber = new Map<string, ScryfallCard>()

function setNumberKey(setCode: string, collectorNumber: string): string {
  return `${setCode}|${collectorNumber}`
}

// Which printing ids (Scryfall card ids) each XMage-internal "Player N" has marked owned-in-foil
// in their own deck — reset and rebuilt fresh at the start of every game (see handleWatchGame).
// Precon participants never populate this (foil is a personal-collection concept), so their
// cards just never render as foil.
const foilIdsByPlayerName = new Map<string, Set<string>>()

// Permanent ids that took damage / got stronger on the MOST RECENTLY drained tick — cleared and
// repopulated once per tick (see handleWatchGame's tick(), right before setProgress), read
// directly by PermanentThumb the same way foilIdsByPlayerName is. A flash naturally lasts exactly
// one tick (until the next snapshot renders and this gets cleared again), which already matches
// the game's own narrated pace without needing a separate timer the way the life-total flash
// does (that one has to outlive several ticks to be readable, since a life NUMBER alone doesn't
// carry its own "this just changed" signal the way a CSS class transition does).
const damageFlashIds = new Set<string>()
const buffFlashIds = new Set<string>()
// Permanent ids that newly started attacking on the most recently drained tick. A plain CSS
// mount/class-toggle trigger was tried here first (matching the ETB glow's approach) but proved
// unreliable — a creature that starts attacking is USUALLY an update to an already-mounted node,
// and while a genuine class-toggle should replay a declared animation, it's not something to
// keep gambling on when the exact same tick-diff approach already confirmed working for
// damage/buff is right there and unambiguous. permId -> the attacker's defendingPlayerName-style
// target isn't needed here, just "did this one just start attacking."
const attackFlashIds = new Set<string>()
// Permanent ids belonging to a token that just joined the battlefield this tick — including a
// token that merged into an ALREADY-EXISTING identical-token group (see groupIdenticalPermanents
// and its `ids` field), which never gets its own fresh DOM mount and so would otherwise never
// show any "something new arrived" signal at all beyond the ×N count silently incrementing.
const tokenFlashIds = new Set<string>()
// The SOURCE side of a damage event — an attacker whose blocker just took damage (damageFlashIds
// already has the blocker), a blocker whose attacker just took damage, or an unblocked attacker
// whose defending player's life just dropped this same tick. damageFlashIds alone only ever
// showed the recipient; this is what a creature DEALING damage flashes with instead, so both
// sides of a combat exchange read as distinct events rather than only the one getting hit.
const dealtDamageFlashIds = new Set<string>()

function isFoilPrinting(playerName: string | undefined, printingId: string | undefined): boolean {
  if (!playerName || !printingId) return false
  return foilIdsByPlayerName.get(playerName)?.has(printingId) ?? false
}

// For inspect specifically, the click site doesn't always know which player's card this is
// (narrator log name clicks, graveyard popup entries) — checking across every participant's
// foil list instead of one specific owner. EDH's singleton rule means the same printing id
// showing up as foil for two different players simultaneously isn't a real scenario worth
// engineering around.
// XMage embeds player-name mentions in its own log text as <font color='...'>Name</font> — but
// in practice it uses the SAME color for every player, making a multi-player log hard to scan
// at a glance ("who did what" isn't visually distinct). Overriding just the color attribute for
// "Player 1".."Player 4" specifically (leaving XMage's own coloring on everything else — card
// names, etc. — untouched) gives each player a consistent, distinct color throughout the log.
const PLAYER_LOG_COLORS = ['#4fd8c4', '#e6a23c', '#7c9eff', '#f0648c']

function recolorPlayerNames(html: string): string {
  return html.replace(/(<font color=['"])[^'"]*(['"]>Player )(\d)(<\/font>)/g, (match, prefix, mid, num, suffix) => {
    const color = PLAYER_LOG_COLORS[Number(num) - 1]
    return color ? `${prefix}${color}${mid}${num}${suffix}` : match
  })
}

function isFoilPrintingAny(printingId: string | undefined): boolean {
  if (!printingId) return false
  for (const ids of foilIdsByPlayerName.values()) {
    if (ids.has(printingId)) return true
  }
  return false
}

function resolveTokenImageUrl(name: string): string | undefined {
  return tokenImageCache.get(name) ?? tokenImageCache.get(name.replace(/ Token$/i, ''))
}

// Same reactive shape as useCardImage below (cache-hit renders synchronously, cache-miss falls
// back to a fuzzy-name fetch and re-renders once it resolves), but for the bigger, readable-text
// image size the floating stack cards need instead of a small thumbnail. A plain one-shot
// cardDataByName.get() (no hook, no fallback fetch, no re-render on resolve) was the actual bug
// behind stack cards sometimes showing the name placeholder forever — if the card wasn't already
// cached at the exact instant that render happened, nothing ever retried it.
const cardImageLargeCache = new Map<string, string | null>()

// Knowing a card's large-image URL (a JS string sitting in a Map) is NOT the same as the
// browser actually having fetched those bytes — every other Playtest surface uses the small
// thumbnail size, which gets reused/warmed across many tiles already, but nothing else in the
// app ever requests the large size. So even with cardDataByName fully "preloaded," the FIRST
// time a stack card's <img> tag actually appeared was still a genuinely fresh network fetch —
// exactly the "still seems to be loading" symptom. Firing off an Image() object per URL forces
// the browser to fetch (and decode) it in the background well before any <img> tag needs it.
// Kept in a Set (not left to fall out of scope) so nothing can garbage-collect the Image object
// — and therefore risk the browser aborting its in-flight request — before the load finishes;
// self-removes once it settles.
const inFlightPreloads = new Set<HTMLImageElement>()

function preloadImage(url: string | null | undefined): void {
  if (!url) return
  const img = new Image()
  inFlightPreloads.add(img)
  img.onload = img.onerror = () => inFlightPreloads.delete(img)
  img.src = url
}

function useCardImageLarge(name: string): string | null | undefined {
  const fromData = cardDataByName.get(name)
  // "normal" preferred over the bigger "large" — stack cards only ever render at 150px wide
  // (see .playtest-stack-card), so "large"'s extra resolution is pure wasted download time that
  // was making the very delay this hook exists to avoid worse, not better.
  const dataUrl =
    fromData?.image_uris?.normal ??
    fromData?.image_uris?.large ??
    fromData?.card_faces?.[0]?.image_uris?.normal ??
    fromData?.card_faces?.[0]?.image_uris?.large ??
    null
  // A token's own activated/triggered ability (a Clue's "sacrifice, draw a card", a Treasure's
  // "sacrifice, add mana") can go on the stack with the token as its source — that's not a real
  // Scryfall card, so the getCardByFuzzyName fallback below can't resolve it (this was a real
  // bug: stack cards for token-sourced abilities rendered blank). resolveTokenImageUrl reuses
  // the same tokenImageCache already populated at game start for battlefield token art.
  const tokenUrl = resolveTokenImageUrl(name)
  const [src, setSrc] = useState<string | null | undefined>(dataUrl ?? tokenUrl ?? cardImageLargeCache.get(name))

  useEffect(() => {
    if (dataUrl) {
      setSrc(dataUrl)
      return
    }
    if (tokenUrl) {
      setSrc(tokenUrl)
      return
    }
    if (cardImageLargeCache.has(name)) {
      setSrc(cardImageLargeCache.get(name) ?? null)
      return
    }
    let cancelled = false
    window.api.getCardByFuzzyName(name).then((result) => {
      if (cancelled) return
      let url: string | null = null
      if (!isError(result)) {
        const card = result as ScryfallCard
        url = card.image_uris?.normal ?? card.image_uris?.large ?? card.card_faces?.[0]?.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.large ?? null
      }
      cardImageLargeCache.set(name, url)
      setSrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [name, dataUrl, tokenUrl])

  return src
}

// setCode/collectorNumber (when known — see PermanentThumb) resolve the EXACT printing first,
// ahead of the name-keyed cache/fetch below — a bare name can't distinguish two different arts
// of the same card (see cardDataBySetNumber's own comment).
function useCardImage(name: string, setCode?: string, collectorNumber?: string): string | null | undefined {
  const exactCard = setCode && collectorNumber ? cardDataBySetNumber.get(setNumberKey(setCode, collectorNumber)) : undefined
  const exactUrl = exactCard?.image_uris?.small ?? exactCard?.card_faces?.[0]?.image_uris?.small
  const tokenUrl = resolveTokenImageUrl(name)
  const [src, setSrc] = useState<string | null | undefined>(exactUrl ?? tokenUrl ?? cardImageCache.get(name))

  useEffect(() => {
    if (exactUrl) {
      setSrc(exactUrl)
      return
    }
    if (tokenUrl) {
      setSrc(tokenUrl)
      return
    }
    if (cardImageCache.has(name)) {
      setSrc(cardImageCache.get(name) ?? null)
      return
    }
    let cancelled = false
    window.api.getCardByFuzzyName(name).then((result) => {
      if (cancelled) return
      let url: string | null = null
      if (!isError(result)) {
        const card = result as ScryfallCard
        url = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null
      }
      cardImageCache.set(name, url)
      setSrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [name, tokenUrl, exactUrl])

  return src
}

/** Printed base power/toughness for a named card, from the same cardDataByName cache already
 *  populated for art — null for anything unresolvable (tokens, which never get a Scryfall
 *  lookup, and variable-P/T cards like "*", where there's no fixed baseline to compare against).
 *  Used to tell a real stat boost/reduction (a pump spell, an anthem, -1/-1 counters as a
 *  continuous effect) apart from the printed value, so only genuine deviations get colored. */
function resolveBaseStats(name: string): { power: number | null; toughness: number | null } {
  const card = cardDataByName.get(name)
  const powerStr = card?.power ?? card?.card_faces?.[0]?.power
  const toughnessStr = card?.toughness ?? card?.card_faces?.[0]?.toughness
  const power = powerStr !== undefined ? Number(powerStr) : NaN
  const toughness = toughnessStr !== undefined ? Number(toughnessStr) : NaN
  return { power: Number.isFinite(power) ? power : null, toughness: Number.isFinite(toughness) ? toughness : null }
}

function PermanentThumb({
  perm,
  variant,
  style,
  count,
  ownerName,
  tokenFlash,
  onInspect
}: {
  perm: GameSimPermanent
  variant?: 'small' | 'peek'
  style?: React.CSSProperties
  count?: number
  // Whose deck this permanent belongs to (an XMage-internal "Player N") — needed to check
  // foilIdsByPlayerName, since foil is tracked per-deck, not globally per-card.
  ownerName?: string
  // See PermanentGroup's own comment — only ever passed for a group's main tile (lands pass it
  // directly since they don't go through PermanentGroup at all).
  tokenFlash?: boolean
  onInspect?: () => void
}) {
  const src = useCardImage(perm.name, perm.setCode, perm.collectorNumber)
  const showPT = perm.power !== 0 || perm.toughness !== 0
  const exactCard = cardDataBySetNumber.get(setNumberKey(perm.setCode, perm.collectorNumber))
  const isFoil = isFoilPrinting(ownerName, exactCard?.id)
  // Marked damage doesn't change the "toughness" stat itself (a real rules distinction — it's
  // tracked and compared separately, cleared at cleanup), but showing the REMAINING effective
  // toughness before death, in red, is the useful thing for a spectator to see at a glance —
  // same convention other MTG clients use. A stat above/below its printed baseline (buffs,
  // anthems, -1/-1 counters as a continuous effect) gets colored independently of damage.
  const { power: basePower, toughness: baseToughness } = resolveBaseStats(perm.name)
  const powerState = basePower === null ? 'normal' : perm.power > basePower ? 'boosted' : perm.power < basePower ? 'reduced' : 'normal'
  const displayToughness = perm.damage > 0 ? Math.max(perm.toughness - perm.damage, 0) : perm.toughness
  const toughnessState =
    perm.damage > 0
      ? 'damaged'
      : baseToughness === null
        ? 'normal'
        : perm.toughness > baseToughness
          ? 'boosted'
          : perm.toughness < baseToughness
            ? 'reduced'
            : 'normal'

  const isDamageFlash = damageFlashIds.has(perm.id)
  const isBuffFlash = buffFlashIds.has(perm.id)
  const isAttackFlash = attackFlashIds.has(perm.id)
  const isDealtDamageFlash = dealtDamageFlashIds.has(perm.id)

  return (
    <div
      className={`playtest-perm ${variant ? `playtest-perm--${variant}` : ''} ${perm.tapped ? 'is-tapped' : ''} ${perm.attacking ? 'is-attacking' : ''} ${isFoil ? 'is-foil' : ''} ${isDamageFlash ? 'is-damage-flash' : ''} ${isBuffFlash ? 'is-buff-flash' : ''} ${isAttackFlash ? 'is-attack-flash' : ''} ${tokenFlash ? 'is-token-flash' : ''} ${isDealtDamageFlash ? 'is-dealt-damage-flash' : ''}`}
      style={style}
      data-perm-id={perm.id}
      title={count && count > 1 ? `${perm.name} ×${count}` : perm.name}
      onClick={(e) => {
        e.stopPropagation()
        onInspect?.()
      }}
    >
      {src ? <img src={src} alt={perm.name} /> : <div className="playtest-perm__placeholder">{perm.name}</div>}
      {isFoil && <span className="playtest-perm__foil-sheen" />}
      {count !== undefined && count > 1 && <span className="playtest-perm__count">×{count}</span>}
      {/* Separate from the P/T boost/reduction coloring above — plenty of counters (charge,
          loyalty already shown via P/T for planeswalkers, etc.) don't affect P/T at all, so a
          card like Elementalist's Palette (an artifact — no P/T shown either way) would
          otherwise track counters with no visible indication whatsoever. */}
      {perm.counters > 0 && (
        <span className="playtest-perm__counters" title={`${perm.counters} counter${perm.counters === 1 ? '' : 's'}`}>
          {perm.counters}
        </span>
      )}
      {showPT && (
        <span className="playtest-perm__pt">
          <span className={`playtest-perm__pt-value playtest-perm__pt-value--${powerState}`}>{perm.power}</span>/
          <span className={`playtest-perm__pt-value playtest-perm__pt-value--${toughnessState}`}>{displayToughness}</span>
        </span>
      )}
    </div>
  )
}

// A land that's ALSO a creature (Dryad Arbor, an animated Celestial Colonnade, etc.) belongs on
// the battlefield with the other creatures, not sorted into the Lands row — it's a creature that
// happens to be a land, not the other way around, and typeRank already ranks it 0 (creature)
// independent of the `land` flag (see Main.java's typeRank comment). The Lands row is for actual
// mana sources only.
function isCreatureLand(perm: GameSimPermanent): boolean {
  return perm.land && perm.typeRank === 0
}

/** Collapses permanents that are visually indistinguishable (same card, same tapped/attacking
 *  state, same power/toughness — e.g. a board with 50 identical 1/1 tokens) into one
 *  representative tile with a ×N badge, instead of rendering 50 identical tiles that would
 *  otherwise eat the whole row. A token that's since been pumped or singled out (different P/T,
 *  tapped, or attacking state) breaks off into its own group rather than staying lumped in —
 *  order-preserving (first-seen position), so this doesn't fight the typeRank sort already
 *  applied before grouping. */
function groupIdenticalPermanents(
  perms: GameSimPermanent[],
  extraKey: (perm: GameSimPermanent) => string = () => ''
): { rep: GameSimPermanent; count: number; ids: string[] }[] {
  const groups: { rep: GameSimPermanent; count: number; ids: string[] }[] = []
  const indexByKey = new Map<string, number>()
  for (const p of perms) {
    const key = `${p.name}|${p.tapped}|${p.attacking}|${p.power}|${p.toughness}|${p.counters}|${extraKey(p)}`
    const idx = indexByKey.get(key)
    if (idx !== undefined) {
      groups[idx].count++
      groups[idx].ids.push(p.id)
    } else {
      indexByKey.set(key, groups.length)
      groups.push({ rep: p, count: 1, ids: [p.id] })
    }
  }
  return groups
}

interface CombatArrow {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'attack' | 'blocked' | 'target'
}

/** Draws attacker → defender lines for every currently-attacking permanent, plus source → target
 *  lines for every spell/ability on the stack. Positions are read straight from the DOM
 *  (`data-perm-id` on PermanentThumb, `data-stack-id` on StackCardThumb, `data-seat-player` on
 *  each seat's root — the whole block, not just the life total, is enough to read "this is who
 *  got attacked/targeted") rather than tracked in React state, since the actual visual location
 *  of a permanent or stack card already depends on layout (grouping, wrapping, which zone panel
 *  it's in) that this component has no reason to duplicate.
 *
 *  Once blockers are declared (perm.blockerIds), a combat arrow redirects from the original
 *  defender to the blocking creature(s) instead — one line per blocker — and turns yellow,
 *  matching the "who's actually stopping this" moment rather than the original declared-attack
 *  target. A stack object's targets (so.targets — resolved to a player or a permanent; anything
 *  else, like a card in a graveyard or another stack object, is omitted server-side since there's
 *  no stable anchor for it) get their own blue line per target, one stack object can have several
 *  (e.g. a 3-target Arc Lightning).
 *
 *  Recomputed after every progress tick (once the sibling seats/stack have re-rendered with the
 *  new state) and on resize, since a board reflow moves every card without changing `progress`
 *  at all. */
function CombatArrowsOverlay({
  progress,
  boardRef
}: {
  progress: GameSimProgress | null
  boardRef: React.RefObject<HTMLDivElement | null>
}) {
  const [arrows, setArrows] = useState<CombatArrow[]>([])

  const recompute = useCallback(() => {
    const board = boardRef.current
    if (!board || !progress) {
      setArrows([])
      return
    }
    const boardRect = board.getBoundingClientRect()
    const center = (el: Element): { x: number; y: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2 - boardRect.left, y: r.top + r.height / 2 - boardRect.top }
    }

    const next: CombatArrow[] = []
    for (const player of progress.players) {
      for (const perm of player.battlefield) {
        if (!perm.attacking || !perm.defendingPlayerName) continue
        const attackerEl = board.querySelector(`[data-perm-id="${perm.id}"]`)
        if (!attackerEl) continue
        const from = center(attackerEl)

        if (perm.blockerIds && perm.blockerIds.length > 0) {
          perm.blockerIds.forEach((blockerId, i) => {
            const blockerEl = board.querySelector(`[data-perm-id="${blockerId}"]`)
            if (!blockerEl) return
            const to = center(blockerEl)
            next.push({ key: `${perm.id}-${i}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y, kind: 'blocked' })
          })
          continue
        }

        const defenderEl = perm.defendingPermanentId
          ? board.querySelector(`[data-perm-id="${perm.defendingPermanentId}"]`)
          : board.querySelector(`[data-seat-player="${perm.defendingPlayerName}"]`)
        if (!defenderEl) continue
        const to = center(defenderEl)
        next.push({ key: perm.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y, kind: 'attack' })
      }
    }

    for (const so of progress.stack) {
      if (so.targets.length === 0) continue
      const sourceEl = board.querySelector(`[data-stack-id="${so.id}"]`)
      if (!sourceEl) continue
      const from = center(sourceEl)
      so.targets.forEach((target, i) => {
        const targetEl = target.permanentId
          ? board.querySelector(`[data-perm-id="${target.permanentId}"]`)
          : board.querySelector(`[data-seat-player="${target.playerName}"]`)
        if (!targetEl) return
        const to = center(targetEl)
        next.push({ key: `${so.id}-target-${i}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y, kind: 'target' })
      })
    }

    setArrows(next)
  }, [progress, boardRef])

  useLayoutEffect(() => {
    recompute()
  }, [recompute])

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const observer = new ResizeObserver(() => recompute())
    observer.observe(board)
    return () => observer.disconnect()
  }, [boardRef, recompute])

  if (arrows.length === 0) return null

  const markerFor = (kind: CombatArrow['kind']): string =>
    kind === 'blocked' ? 'url(#playtest-combat-arrowhead-blocked)' : kind === 'target' ? 'url(#playtest-combat-arrowhead-target)' : 'url(#playtest-combat-arrowhead)'

  return (
    <svg className="playtest-combat-arrows" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="playtest-combat-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="playtest-combat-arrows__head" />
        </marker>
        <marker
          id="playtest-combat-arrowhead-blocked"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="playtest-combat-arrows__head playtest-combat-arrows__head--blocked" />
        </marker>
        <marker
          id="playtest-combat-arrowhead-target"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="playtest-combat-arrows__head playtest-combat-arrows__head--target" />
        </marker>
      </defs>
      {arrows.map((a) => (
        <line
          key={a.key}
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          className={`playtest-combat-arrows__line ${a.kind === 'blocked' ? 'is-blocked' : a.kind === 'target' ? 'is-target' : ''}`}
          markerEnd={markerFor(a.kind)}
        />
      ))}
    </svg>
  )
}

interface FlyingCard {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  imageUrl: string
}

/** Renders the in-flight ghosts produced by resolveZoneMoveOrigins/resolveZoneMoveDestinations
 *  (see handleWatchGame's tick()) — a small card image animating in a straight line from where
 *  it left to where it landed. Unlike CombatArrowsOverlay, this doesn't recompute anything
 *  itself from `progress`; the rects are captured by the caller at the two different moments
 *  each half is actually knowable (see those functions' own comments for why takeoff and landing
 *  can't both be measured at the same time), so this component is just a dumb renderer for
 *  whatever's currently in flight. Each entry removes
 *  itself via the timeout in tick() once its animation has had time to finish. */
function FlyingCardsLayer({ flyingCards }: { flyingCards: FlyingCard[] }) {
  if (flyingCards.length === 0) return null
  return (
    <div className="playtest-flying-cards">
      {flyingCards.map((f) => (
        <div
          key={f.id}
          className="playtest-flying-card"
          style={
            {
              left: f.x1,
              top: f.y1,
              '--dx': `${f.x2 - f.x1}px`,
              '--dy': `${f.y2 - f.y1}px`
            } as React.CSSProperties
          }
        >
          <img src={f.imageUrl} alt="" />
        </div>
      ))}
    </div>
  )
}

// Sound cues for a drained snapshot. Two detection strategies, chosen per event based on how
// reliably each is actually narrated: cast/draw/discard/damage have confirmed, stable phrasing
// in XMage's own TableEvent.INFO text ("X casts Y", "X draws N cards", "X discards Y", "X deals
// N damage to Y" / "X gets N damage") so a plain text match is both simple and accurate. ETB,
// graveyard, exile, and counters-gained don't have one universal log phrase to match against
// (XMage's zone-change/counter narration is spread across many individual card/effect classes,
// not centralized) — those are detected instead by diffing this snapshot's battlefield against
// the previously drained one, which is exact regardless of phrasing. One sound per category per
// tick (not per permanent) — a token-maker creating 5 tokens in one action still just gets one
// satisfying pop, not a flood.
/** Life-total deltas between two drained snapshots, one entry per player whose life actually
 *  changed — the log line explains *why* but reading it isn't how anyone tracks life at a
 *  glance, so this feeds a floating +N/-N flash next to each seat's life total instead. */
function computeLifeDeltas(prev: GameSimProgress | null, next: GameSimProgress): { playerName: string; delta: number }[] {
  if (!prev) return []
  const deltas: { playerName: string; delta: number }[] = []
  for (const nextPlayer of next.players) {
    const prevPlayer = prev.players.find((p) => p.name === nextPlayer.name)
    if (!prevPlayer) continue
    const delta = nextPlayer.life - prevPlayer.life
    if (delta !== 0) deltas.push({ playerName: nextPlayer.name, delta })
  }
  return deltas
}

// Where a card was (or is going) — resolved to a DOM anchor by the flying-card layer:
// 'perm' has a stable data-perm-id (the card's own tile, while it's still on a battlefield);
// every other kind is a whole zone container (`data-hand-zone`, `data-graveyard-zone`, etc.,
// keyed by owning player) since hand/graveyard/deck/command-zone cards don't have individually
// addressable tiles the way a battlefield permanent does.
interface ZoneAnchor {
  kind: 'perm' | 'hand' | 'graveyard' | 'deck' | 'command' | 'battlefield'
  playerName: string
  permId?: string
}

interface ZoneMoveEvent {
  cardName: string
  from: ZoneAnchor
  to: ZoneAnchor
}

/** Removes the first occurrence of `name` from `list` (mutates), returning whether it found one
 *  — the building block computeZoneMoves uses to attribute each zone-count change to a specific
 *  cause without double-counting (e.g. a card that left the battlefield AND showed up as a new
 *  graveyard entry gets consumed from graveyardAdded so it isn't also later treated as milled). */
function takeOne(list: string[], name: string): boolean {
  const idx = list.indexOf(name)
  if (idx === -1) return false
  list.splice(idx, 1)
  return true
}

/** Detects zone-to-zone card movement between two drained snapshots — draws (deck→hand), deaths
 *  (battlefield→graveyard), discards (hand→graveyard), bounces (battlefield→hand), and casts
 *  (hand/command-zone→battlefield) — by diffing each player's zone contents. Attribution works by
 *  process of elimination: a battlefield permanent that disappeared is matched against whichever
 *  zone gained a same-named card this tick (graveyard first, since death is the most common
 *  case, then hand for a bounce, then command zone); whatever's left over after that pass is
 *  attributed to the next most specific cause (a still-unattributed new hand card is a draw, a
 *  still-unattributed new graveyard card is a discard if a hand card vanished or otherwise a
 *  mill). A card whose destination can't be attributed to any tracked zone (genuine exile — there
 *  is no exile zone in this UI — or an effect this heuristic doesn't cover) simply gets no flight
 *  animation; it's still fully reflected in the zone counts/contents themselves. */
function computeZoneMoves(prev: GameSimProgress | null, next: GameSimProgress): ZoneMoveEvent[] {
  if (!prev) return []
  const events: ZoneMoveEvent[] = []
  for (const nextPlayer of next.players) {
    const prevPlayer = prev.players.find((p) => p.name === nextPlayer.name)
    if (!prevPlayer) continue
    const playerName = nextPlayer.name

    const nextBattlefieldIds = new Set(nextPlayer.battlefield.map((p) => p.id))
    const prevBattlefieldIds = new Set(prevPlayer.battlefield.map((p) => p.id))
    const departedPerms = prevPlayer.battlefield.filter((p) => !nextBattlefieldIds.has(p.id))
    const enteredPerms = nextPlayer.battlefield.filter((p) => !prevBattlefieldIds.has(p.id))

    const handAdded = nextPlayer.hand.map((c) => c.name)
    for (const c of prevPlayer.hand) takeOne(handAdded, c.name)
    const handRemoved = prevPlayer.hand.map((c) => c.name)
    for (const c of nextPlayer.hand) takeOne(handRemoved, c.name)

    const graveyardAdded = nextPlayer.graveyard.map((c) => c.name)
    for (const c of prevPlayer.graveyard) takeOne(graveyardAdded, c.name)

    const commandAdded = nextPlayer.commandZone.map((c) => c.name)
    for (const c of prevPlayer.commandZone) takeOne(commandAdded, c.name)
    const commandRemoved = prevPlayer.commandZone.map((c) => c.name)
    for (const c of nextPlayer.commandZone) takeOne(commandRemoved, c.name)

    for (const perm of departedPerms) {
      const from: ZoneAnchor = { kind: 'perm', playerName, permId: perm.id }
      if (takeOne(graveyardAdded, perm.name)) {
        events.push({ cardName: perm.name, from, to: { kind: 'graveyard', playerName } })
      } else if (takeOne(handAdded, perm.name)) {
        events.push({ cardName: perm.name, from, to: { kind: 'hand', playerName } })
      } else if (takeOne(commandAdded, perm.name)) {
        events.push({ cardName: perm.name, from, to: { kind: 'command', playerName } })
      }
      // else: exiled, sacrificed to something untracked, etc. — no destination anchor, skip.
    }

    for (const name of handAdded) {
      events.push({ cardName: name, from: { kind: 'deck', playerName }, to: { kind: 'hand', playerName } })
    }

    for (const name of graveyardAdded) {
      if (takeOne(handRemoved, name)) {
        events.push({ cardName: name, from: { kind: 'hand', playerName }, to: { kind: 'graveyard', playerName } })
      } else {
        events.push({ cardName: name, from: { kind: 'deck', playerName }, to: { kind: 'graveyard', playerName } })
      }
    }

    for (const name of handRemoved) {
      const idx = enteredPerms.findIndex((p) => p.name === name)
      if (idx === -1) continue
      const enteredPerm = enteredPerms[idx]
      enteredPerms.splice(idx, 1)
      events.push({ cardName: name, from: { kind: 'hand', playerName }, to: { kind: 'perm', playerName, permId: enteredPerm.id } })
    }

    for (const name of commandRemoved) {
      const idx = enteredPerms.findIndex((p) => p.name === name)
      if (idx === -1) continue
      const enteredPerm = enteredPerms[idx]
      enteredPerms.splice(idx, 1)
      events.push({ cardName: name, from: { kind: 'command', playerName }, to: { kind: 'perm', playerName, permId: enteredPerm.id } })
    }
    // Any remaining enteredPerms (tokens, library/exile-to-battlefield effects, etc.) get no
    // flight — the ETB glow (the plain-CSS mount trigger on .playtest-perm) is the only signal
    // for those, same as before this system existed.
  }
  return events
}

function zoneAnchorSelector(anchor: ZoneAnchor): string {
  return anchor.kind === 'perm' ? `[data-perm-id="${anchor.permId}"]` : `[data-${anchor.kind}-zone="${anchor.playerName}"]`
}

interface ZoneMoveOrigin {
  event: ZoneMoveEvent
  x1: number
  y1: number
  imageUrl: string
}

/** Resolves only the TAKEOFF point of each zone-move event — MUST be called with `board` still
 *  reflecting the PREVIOUS snapshot (before setProgress(next) runs), since a departed
 *  permanent's own `[data-perm-id]` tile only still exists in the DOM at that exact moment; a
 *  tick later, React will have already unmounted it. The landing point is resolved separately
 *  and later (see resolveZoneMoveDestinations) — a hand/command-zone→battlefield event's
 *  destination is the newly-cast permanent's OWN tile, which doesn't exist in the DOM until
 *  after this same tick's render actually commits, so it can't be measured yet at this point. */
function resolveZoneMoveOrigins(board: HTMLElement, events: ZoneMoveEvent[]): ZoneMoveOrigin[] {
  const boardRect = board.getBoundingClientRect()
  const results: ZoneMoveOrigin[] = []
  for (const event of events) {
    const fromEl = board.querySelector(zoneAnchorSelector(event.from))
    if (!fromEl) continue
    const r = fromEl.getBoundingClientRect()
    results.push({
      event,
      x1: r.left + r.width / 2 - boardRect.left,
      y1: r.top + r.height / 2 - boardRect.top,
      imageUrl: cardImageCache.get(event.cardName) ?? CARD_BACK_URL
    })
  }
  return results
}

/** Resolves the LANDING point for each already-originated flight — called from a
 *  requestAnimationFrame scheduled right after setProgress(next), so the DOM has actually
 *  committed the new snapshot's render by the time this runs (a newly-cast permanent's own tile
 *  now exists to target precisely, instead of the whole battlefield zone's center — which is
 *  what made a played card look like it was flying to the middle of the screen rather than
 *  where it actually landed). An event whose anchor still isn't found for some reason is
 *  silently dropped rather than guessed at. */
function resolveZoneMoveDestinations(board: HTMLElement, origins: ZoneMoveOrigin[]): { x1: number; y1: number; x2: number; y2: number; imageUrl: string }[] {
  const boardRect = board.getBoundingClientRect()
  const results: { x1: number; y1: number; x2: number; y2: number; imageUrl: string }[] = []
  for (const origin of origins) {
    const toEl = board.querySelector(zoneAnchorSelector(origin.event.to))
    if (!toEl) continue
    const r = toEl.getBoundingClientRect()
    results.push({
      x1: origin.x1,
      y1: origin.y1,
      x2: r.left + r.width / 2 - boardRect.left,
      y2: r.top + r.height / 2 - boardRect.top,
      imageUrl: origin.imageUrl
    })
  }
  return results
}

/** Clears and repopulates the module-level damageFlashIds/buffFlashIds/attackFlashIds/
 *  tokenFlashIds/dealtDamageFlashIds sets for the tick that just drained — called right before
 *  setProgress so the flash is visible starting with the render that shows the new state. A
 *  permanent that just entered the battlefield this tick (no prevPerm to compare against) never
 *  counts as damaged/buffed/attacking here — those are diffs against a PREVIOUS state that, by
 *  definition, didn't have this permanent at all. Token creation is the one exception: that's
 *  exactly the "no prevPerm" case this function otherwise skips. */
function updatePermanentFlashes(prev: GameSimProgress | null, next: GameSimProgress): void {
  damageFlashIds.clear()
  buffFlashIds.clear()
  attackFlashIds.clear()
  tokenFlashIds.clear()
  dealtDamageFlashIds.clear()
  if (!prev) return
  for (const nextPlayer of next.players) {
    const prevPlayer = prev.players.find((p) => p.name === nextPlayer.name)
    if (!prevPlayer) continue
    const prevById = new Map(prevPlayer.battlefield.map((perm) => [perm.id, perm]))
    for (const perm of nextPlayer.battlefield) {
      const prevPerm = prevById.get(perm.id)
      if (!prevPerm) {
        if (perm.token) tokenFlashIds.add(perm.id)
        continue
      }
      if (perm.damage > prevPerm.damage) damageFlashIds.add(perm.id)
      if (perm.power > prevPerm.power || perm.toughness > prevPerm.toughness) buffFlashIds.add(perm.id)
      if (!prevPerm.attacking && perm.attacking) attackFlashIds.add(perm.id)
    }
  }

  // Second pass, needs damageFlashIds fully populated first (an attacker's blocker can belong to
  // a DIFFERENT player's battlefield than the attacker itself, so this can't be folded into the
  // per-player loop above). Combat only — there's no per-event "who dealt this" data for
  // non-combat damage (burn spells, etc.) to attribute a source from.
  for (const nextPlayer of next.players) {
    for (const perm of nextPlayer.battlefield) {
      if (!perm.attacking) continue
      if (perm.blockerIds && perm.blockerIds.length > 0) {
        if (perm.blockerIds.some((id) => damageFlashIds.has(id))) dealtDamageFlashIds.add(perm.id)
        if (damageFlashIds.has(perm.id)) {
          for (const blockerId of perm.blockerIds) dealtDamageFlashIds.add(blockerId)
        }
      } else if (perm.defendingPlayerName) {
        const prevDefender = prev.players.find((p) => p.name === perm.defendingPlayerName)
        const nextDefender = next.players.find((p) => p.name === perm.defendingPlayerName)
        if (prevDefender && nextDefender && nextDefender.life < prevDefender.life) {
          dealtDamageFlashIds.add(perm.id)
        }
      }
    }
  }
}

function triggerActionSounds(prev: GameSimProgress | null, next: GameSimProgress): void {
  const text = next.logLine.replace(/<[^>]+>/g, '')
  if (/\bcasts\b/.test(text)) playCastSound()
  if (/\bdraws\b/.test(text)) playDrawSound()
  if (/\bdiscards\b/.test(text)) playDiscardSound()
  if (/deals \d+ damage to|gets \d+ damage/.test(text)) playDamageSound()

  if (!prev) return
  let sawEtb = false
  let sawGraveyard = false
  let sawExile = false
  let sawCounterGain = false
  for (const nextPlayer of next.players) {
    const prevPlayer = prev.players.find((p) => p.name === nextPlayer.name)
    if (!prevPlayer) continue
    const prevById = new Map(prevPlayer.battlefield.map((perm) => [perm.id, perm]))
    const nextIds = new Set(nextPlayer.battlefield.map((perm) => perm.id))
    for (const perm of nextPlayer.battlefield) {
      const prevPerm = prevById.get(perm.id)
      if (!prevPerm) sawEtb = true
      else if (perm.counters > prevPerm.counters) sawCounterGain = true
    }
    if (prevPlayer.battlefield.some((perm) => !nextIds.has(perm.id))) {
      if (nextPlayer.graveyardSize > prevPlayer.graveyardSize) sawGraveyard = true
      else sawExile = true
    }
  }
  if (sawEtb) playEtbSound()
  if (sawGraveyard) playGraveyardSound()
  if (sawExile) playExileSound()
  if (sawCounterGain) playCounterSound()
}

// Equipment/Auras render nested behind whatever they're attached to, same idea as the Decks
// list's commander+partner stacked art preview (deck-card__image-stack): the peeking card is
// the SAME size as the main card and absolutely positioned over it (inset:0), offset purely via
// a paint-time `transform` — which never affects layout, so the group's box stays exactly one
// card wide regardless of how many attachments it has. The earlier version reserved extra flex
// width per attachment specifically to avoid clipping, but that inflated the row's whole share
// math and made an equipped/enchanted card visibly bigger than its neighbors — this way nothing
// about the row layout changes; the peek can slightly overflow into neighboring space the same
// way a real fanned stack of cards would.
function PermanentGroup({
  main,
  attachments,
  count,
  ownerName,
  tokenFlash,
  onInspect
}: {
  main: GameSimPermanent
  attachments: GameSimPermanent[]
  count: number
  ownerName: string
  // True when ANY permanent collapsed into this group (not necessarily `main` itself — see
  // groupIdenticalPermanents' `ids`) is a token that joined this tick, whether that's the very
  // first of its kind (a fresh mount) or an additional copy silently folded into an existing
  // ×N group (no fresh mount at all — this is the only signal for that case).
  tokenFlash?: boolean
  onInspect: (perm: GameSimPermanent, equippedWith: string[]) => void
}) {
  return (
    <div className="playtest-perm-group">
      {attachments.map((att, i) => (
        <PermanentThumb
          key={att.id}
          perm={att}
          variant="peek"
          style={{ transform: `translate(${9 + i * 6}px, ${-8 - i * 5}px) rotate(${-7 - i * 4}deg)`, zIndex: i }}
          ownerName={ownerName}
          onInspect={() => onInspect(att, [])}
        />
      ))}
      <PermanentThumb
        perm={main}
        count={count}
        style={{ position: 'relative', zIndex: attachments.length + 1 }}
        ownerName={ownerName}
        tokenFlash={tokenFlash}
        onInspect={() => onInspect(main, attachments.map((a) => a.name))}
      />
    </div>
  )
}

function HandCardThumb({ card, ownerName, onInspect }: { card: GameSimCardRef; ownerName: string; onInspect: () => void }) {
  const src = useCardImage(card.name, card.setCode, card.collectorNumber)
  const exactCard = cardDataBySetNumber.get(setNumberKey(card.setCode, card.collectorNumber))
  const isFoil = isFoilPrinting(ownerName, exactCard?.id)
  return (
    <div
      className={`playtest-perm playtest-perm--small ${isFoil ? 'is-foil' : ''}`}
      title={card.name}
      onClick={(e) => (e.stopPropagation(), onInspect())}
    >
      {src ? <img src={src} alt={card.name} /> : <div className="playtest-perm__placeholder">{card.name}</div>}
      {isFoil && <span className="playtest-perm__foil-sheen" />}
    </div>
  )
}

function GraveyardCardThumb({ card, ownerName, onInspect }: { card: GameSimCardRef; ownerName: string; onInspect: () => void }) {
  const src = useCardImage(card.name, card.setCode, card.collectorNumber)
  const exactCard = cardDataBySetNumber.get(setNumberKey(card.setCode, card.collectorNumber))
  const isFoil = isFoilPrinting(ownerName, exactCard?.id)
  return (
    <div className={`playtest-graveyard-modal__card ${isFoil ? 'is-foil' : ''}`} title={card.name} onClick={onInspect}>
      {src ? <img src={src} alt={card.name} /> : <div className="playtest-perm__placeholder">{card.name}</div>}
      {isFoil && <span className="playtest-perm__foil-sheen" />}
      <span className="playtest-graveyard-modal__card-name">{card.name}</span>
    </div>
  )
}

// Scryfall's own official card-back image — same "everything via Scryfall CDN" pattern the rest
// of the app already uses for real card art, rather than bundling/reproducing WotC's card back
// as a local asset.
const CARD_BACK_URL = 'https://cards.scryfall.io/back.png'

const SPEED_OPTIONS = [0.5, 1, 2, 4]

/** A native `<select>`'s own OPEN dropdown panel is rendered by the OS/browser chrome, not the
 *  page — no amount of CSS on the `<select>` itself can theme it, which was exactly the
 *  mismatched-white-popup-in-a-dark-app look this replaces. A plain button + a small absolutely
 *  positioned menu gives full control instead, closing on an outside click or Escape like any
 *  other custom dropdown. */
function SpeedPicker({ speed, onChange }: { speed: number; onChange: (speed: number) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="playtest-speed-picker" ref={rootRef}>
      <button type="button" className="playtest-speed-picker__button" onClick={() => setOpen((o) => !o)}>
        <span>{speed}×</span>
        <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="playtest-speed-picker__menu">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`playtest-speed-picker__option ${s === speed ? 'is-selected' : ''}`}
              onClick={() => {
                onChange(s)
                setOpen(false)
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeckZoneTile({ count, ownerName }: { count: number; ownerName: string }) {
  return (
    <div className="playtest-zone playtest-zone--deck" data-deck-zone={ownerName}>
      <span className="playtest-zone__label">Deck ({count})</span>
      <div className="playtest-zone__cards">
        <div className="playtest-perm playtest-perm--small">
          <img src={CARD_BACK_URL} alt="Library" />
          <span className="playtest-perm__count">{count}</span>
        </div>
      </div>
    </div>
  )
}

function GraveyardZoneTile({
  count,
  topCard,
  ownerName,
  onOpen
}: {
  count: number
  topCard: GameSimCardRef | null
  ownerName: string
  onOpen: () => void
}) {
  const src = useCardImage(topCard?.name ?? '', topCard?.setCode, topCard?.collectorNumber)
  const exactCard = topCard ? cardDataBySetNumber.get(setNumberKey(topCard.setCode, topCard.collectorNumber)) : undefined
  const isFoil = isFoilPrinting(ownerName, exactCard?.id)
  return (
    <div className="playtest-zone playtest-zone--graveyard" data-graveyard-zone={ownerName}>
      <span className="playtest-zone__label">Graveyard ({count})</span>
      <div className="playtest-zone__cards">
        <div
          className={`playtest-perm playtest-perm--small ${isFoil ? 'is-foil' : ''}`}
          onClick={onOpen}
          title={topCard?.name ?? 'Empty'}
        >
          {topCard && src ? (
            <img src={src} alt={topCard.name} />
          ) : (
            <div className="playtest-perm__placeholder">{topCard?.name ?? 'Empty'}</div>
          )}
          {isFoil && <span className="playtest-perm__foil-sheen" />}
          {count > 0 && <span className="playtest-perm__count">{count}</span>}
        </div>
      </div>
    </div>
  )
}

function CommandZoneThumb({ card, ownerName, onInspect }: { card: GameSimCommandZoneCard; ownerName: string; onInspect: () => void }) {
  const src = useCardImage(card.name, card.setCode, card.collectorNumber)
  const exactCard = cardDataBySetNumber.get(setNumberKey(card.setCode, card.collectorNumber))
  const isFoil = isFoilPrinting(ownerName, exactCard?.id)
  return (
    <div
      className={`playtest-perm playtest-perm--small ${isFoil ? 'is-foil' : ''}`}
      title={card.tax > 0 ? `${card.name} (tax +${card.tax})` : card.name}
      onClick={(e) => (e.stopPropagation(), onInspect())}
    >
      {src ? <img src={src} alt={card.name} /> : <div className="playtest-perm__placeholder">{card.name}</div>}
      {isFoil && <span className="playtest-perm__foil-sheen" />}
      {card.tax > 0 && <span className="playtest-perm__tax">+{card.tax}</span>}
    </div>
  )
}

// Same ring geometry DecksBrowser uses for its Deck Score badge — not exported from there, so
// duplicated here rather than threading a new export through for two small constants.
const SCORE_RING_RADIUS = 16
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS

/** The "My Decks" picker step reuses the real Decks-page tile look (deck-card and friends) in
 *  its simplified (art-hidden) variant — accent bar, name, color identity, bracket, Deck Score,
 *  and win rate, without the per-tile commander art thumbnail. Trimmed relative to
 *  DecksBrowser's own tile: no drag handle or ⋮ menu, and it's a plain select-on-click button
 *  instead of opening the deck. Precons intentionally keep the smaller compact-grid tile
 *  instead (see the picker modal) — they don't carry bracket/score/record data, so this fuller
 *  layout wouldn't add anything for them. */
function DeckPickerRow({ deck, onSelect }: { deck: StoredDeck; onSelect: () => void }) {
  const commander = cardDataByName.get(deck.commanderName)
  const partner = deck.partnerCommanderName ? cardDataByName.get(deck.partnerCommanderName) : undefined
  const colorIdentity = [...new Set([...(commander?.color_identity ?? []), ...(partner?.color_identity ?? [])])]
  const rate = winRate(deck.wins, deck.losses)
  const cardCount = deck.cardIds.length + 1 + (deck.partnerCommanderId ? 1 : 0)

  return (
    <button className="deck-card deck-card--simplified" onClick={onSelect}>
      {commander?.image_uris?.art_crop && (
        <span className="deck-card__art-bg" style={{ backgroundImage: `url(${commander.image_uris.art_crop})` }} />
      )}
      <span className="deck-card__accent" style={{ background: colorIdentityGradient(colorIdentity) }} />
      <div className="deck-card__content">
        <div className="deck-card__body">
          <div className="deck-card__name">{deck.name}</div>
          {commander && <ColorPips colors={colorIdentity} size={16} showName />}
          <div className="deck-card__meta-row">
            <span>
              {deck.commanderName}
              {deck.partnerCommanderName ? ` + ${deck.partnerCommanderName}` : ''}
            </span>
            <span className="deck-card__dot">·</span>
            <span>{cardCount} cards</span>
          </div>
        </div>
        <div className="deck-card__stats">
          {deck.lastScore && (
            <>
              <div className="deck-card__stat deck-card__stat--score">
                <div
                  className="deck-card__score-ring"
                  style={{ '--score-color': scoreColor(deck.lastScore.overall) } as React.CSSProperties}
                >
                  <svg viewBox="0 0 40 40">
                    <circle className="deck-card__score-ring-track" cx="20" cy="20" r={SCORE_RING_RADIUS} />
                    <circle
                      className="deck-card__score-ring-fill"
                      cx="20"
                      cy="20"
                      r={SCORE_RING_RADIUS}
                      style={{
                        stroke: scoreColor(deck.lastScore.overall),
                        strokeDasharray: SCORE_RING_CIRCUMFERENCE,
                        strokeDashoffset: SCORE_RING_CIRCUMFERENCE * (1 - deck.lastScore.overall / 100)
                      }}
                    />
                  </svg>
                  <span className="deck-card__score-grade">{deck.lastScore.grade}</span>
                </div>
              </div>
              <div className="deck-card__stat-divider" />
            </>
          )}
          <div className="deck-card__stat deck-card__stat--bracket">
            <span
              className="deck-card__bracket-text"
              data-empty={deck.bracket == null}
              style={deck.bracket ? { color: bracketColor(deck.bracket) } : undefined}
            >
              {deck.bracket ? `Bracket ${deck.bracket}` : 'No bracket'}
            </span>
          </div>
          <div className="deck-card__stat-divider" />
          <div className="deck-card__stat deck-card__stat--record">
            {rate === null ? (
              <span className="deck-card__stat-value deck-card__stat-value--muted">No games</span>
            ) : (
              <span className="deck-card__record-line">
                <span className="deck-card__record-wl">
                  {deck.wins}W - {deck.losses}L
                </span>
                <span className="deck-card__stat-value" style={{ color: winRateColor(rate) }}>
                  {Math.round(rate * 100)}%
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

/** A labeled card row that gets a proportional share of the seat's height (see the
 *  playtest-zone--* flex rules) with its own overflow-y:auto — a big board can never push the
 *  whole seat panel (or the page) taller; only this one row scrolls internally if it has to. */
function ZoneRow({
  variant,
  label,
  count,
  empty,
  children,
  ownerName
}: {
  variant: 'battlefield' | 'lands' | 'hand' | 'command'
  label: string
  count: number
  empty: string
  children: React.ReactNode
  // Landing/takeoff point for the flying-card zone-move animation (see computeZoneMoves) —
  // battlefield/hand/command are whole-zone anchors since (unlike a battlefield permanent) a
  // hand or command-zone card has no individually addressable tile. Omitted for 'lands', which
  // isn't a flight source/destination in its own right (a land move is still a battlefield move).
  ownerName?: string
}) {
  const anchorAttr = variant === 'battlefield' ? 'data-battlefield-zone' : variant === 'hand' ? 'data-hand-zone' : variant === 'command' ? 'data-command-zone' : undefined
  const anchorProps = anchorAttr && ownerName ? { [anchorAttr]: ownerName } : {}
  return (
    <div className={`playtest-zone playtest-zone--${variant}`} {...anchorProps}>
      <span className="playtest-zone__label">
        {label} ({count})
      </span>
      <div className="playtest-zone__cards">{count === 0 ? <span className="playtest-zone__empty">{empty}</span> : children}</div>
    </div>
  )
}

interface SeatProps {
  index: number
  boardActive: boolean
  slot: ParticipantSlot
  decks: StoredDeck[]
  precons: PreconDeck[]
  playerProgress: GameSimProgressPlayer | undefined
  isWinner: boolean
  // A just-happened life change to flash next to the life total (see computeLifeDeltas) — undefined
  // once its short lifespan (see the setTimeout in handleWatchGame's tick()) has passed.
  lifeFlash: LifeFlash | undefined
  turnInfo: { turn: number; step: string; stack: GameSimStackObject[] } | null
  onInspect: (name: string, equippedWith?: string[], setCode?: string, collectorNumber?: string) => void
  onOpenGraveyard: (playerName: string, cards: GameSimCardRef[]) => void
  onOpenPicker: () => void
  // Equipment/Auras render behind whatever they're attached to — but the *controller* of an
  // Aura/Equipment isn't necessarily the controller of what it's attached to (e.g. an opponent's
  // removal-ish Aura enchanting your creature). XMage's per-player battlefield lists group by
  // controller, so an attachment like that lives in the ATTACHER's list while its target lives
  // in the TARGET's — matching them up needs to look across every seat, not just this one, hence
  // these two maps are computed once (from all 4 players combined) in the parent and passed down.
  globalAttachmentsByTarget: Map<string, GameSimPermanent[]>
  allMainIds: Set<string>
  // Commander name -> "Player N" label, for the commander-damage pills (see its own comment at
  // the call site — a full commander name is unreadable at that size).
  commanderOwnerLabel: Map<string, string>
}

/** The stack is a single shared zone (not per-player), so it's rendered once, floating over the
 *  active player's seat regardless of which player actually controls each object on it —
 *  darkening that seat's own content behind it, per reference. XMage's stack is an ArrayDeque
 *  pushed/peeked at the head, so index 0 (what Main.java sends first) is the TOP of the stack
 *  (resolves next) and the last index is the bottom (resolves last, since it's this turn's very
 *  first spell) — reversed here so the render order reads left-to-right as bottom-to-top,
 *  matching the request ("left is the last card on the stack, right is the top card"). Only the
 *  rightmost (top) card is what's actually resolving right now, so only it gets the outline;
 *  anything not controlled by the seat's own player gets a badge naming whose it is. */
function StackCardThumb({
  item,
  isResolving,
  activePlayerName,
  onInspect
}: {
  item: GameSimStackObject
  isResolving: boolean
  activePlayerName: string
  onInspect: (name: string) => void
}) {
  // sourceName is the actual card (a Spell's own card, or — for a triggered/activated ability —
  // the permanent whose ability this is) — "name" for a non-Spell stack object is the ability's
  // own text, not a real card name, so using it for art/inspect would never resolve anything.
  const src = useCardImageLarge(item.sourceName)
  const exactCard = cardDataBySetNumber.get(setNumberKey(item.setCode, item.collectorNumber))
  const isFoil = isFoilPrinting(item.controller, exactCard?.id)
  return (
    <div
      className={`playtest-stack-card ${isResolving ? 'is-resolving' : ''} ${isFoil ? 'is-foil' : ''}`}
      data-stack-id={item.id}
      title={item.name}
      onClick={(e) => {
        e.stopPropagation()
        onInspect(item.sourceName)
      }}
    >
      {item.controller !== activePlayerName && <span className="playtest-stack-card__badge">{item.controller}</span>}
      {src ? <img src={src} alt={item.sourceName} /> : <div className="playtest-perm__placeholder">{item.sourceName}</div>}
      {isFoil && <span className="playtest-perm__foil-sheen" />}
    </div>
  )
}

function StackOverlay({
  stack,
  activePlayerName,
  onInspect
}: {
  stack: GameSimStackObject[]
  activePlayerName: string
  onInspect: (name: string) => void
}) {
  if (stack.length === 0) return null
  const bottomToTop = [...stack].reverse()
  return (
    <div className="playtest-stack-overlay">
      {bottomToTop.map((item, i) => (
        <StackCardThumb
          key={i}
          item={item}
          isResolving={i === bottomToTop.length - 1}
          activePlayerName={activePlayerName}
          onInspect={onInspect}
        />
      ))}
    </div>
  )
}

function PlaytestSeat({
  index,
  boardActive,
  slot,
  decks,
  precons,
  onOpenPicker,
  playerProgress,
  isWinner,
  lifeFlash,
  turnInfo,
  onInspect,
  onOpenGraveyard,
  globalAttachmentsByTarget,
  allMainIds,
  commanderOwnerLabel
}: SeatProps) {
  // Resolved once, used by both the picker button (art_crop background, commander portrait) and
  // the active-game header/background below — the seat's own DISPLAY identity (real deck and
  // commander name/art) comes from slot+decks/precons regardless of mode, entirely decoupled
  // from whatever XMage-internal name ("Player 1") the live game data is matched by.
  const chosenDeck = slot.id ? (slot.source === 'deck' ? decks : precons).find((d) => d.id === slot.id) : null
  const chosenCard = chosenDeck ? cardDataByName.get(chosenDeck.commanderName) : null

  if (!boardActive) {
    return (
      <div className="playtest-seat playtest-seat--pick">
        {chosenCard?.image_uris?.art_crop && (
          <span className="playtest-seat__art-bg" style={{ backgroundImage: `url(${chosenCard.image_uris.art_crop})` }} />
        )}
        <span className="playtest-seat__label playtest-seat__label--pick">{SLOT_LABELS[index]}</span>
        <button className={`playtest-deck-button ${chosenDeck ? 'playtest-deck-button--chosen' : ''}`} onClick={onOpenPicker}>
          {chosenDeck ? (
            <>
              {chosenCard?.image_uris?.small ? (
                <img src={chosenCard.image_uris.small} alt={chosenDeck.commanderName} />
              ) : (
                <div className="playtest-perm__placeholder">{chosenDeck.commanderName}</div>
              )}
              <span className="playtest-deck-button__name">{chosenDeck.name}</span>
            </>
          ) : (
            <span className="playtest-deck-button__plus">+</span>
          )}
        </button>
      </div>
    )
  }

  if (!playerProgress) {
    return (
      <div className="playtest-seat playtest-seat--empty">
        <span className="playtest-seat__label">{SLOT_LABELS[index]}</span>
        <p className="app__hint">Empty seat</p>
      </div>
    )
  }

  const sortedLands = playerProgress.battlefield
    .filter((p) => p.land && !isCreatureLand(p))
    .sort((a, b) => {
      const cardA = cardDataByName.get(a.name)
      const cardB = cardDataByName.get(b.name)
      // Unresolved (shouldn't normally happen — every land came from a checked deck list)
      // sorts after everything real rather than potentially jumping the queue.
      const tierA = cardA ? landTier(cardA) : 5
      const tierB = cardB ? landTier(cardB) : 5
      if (tierA !== tierB) return tierA - tierB
      const keyA = cardA ? producedColorKey(cardA) : ''
      const keyB = cardB ? producedColorKey(cardB) : ''
      return keyA.localeCompare(keyB)
    })
  const lands = groupIdenticalPermanents(sortedLands)

  const nonlands = playerProgress.battlefield.filter((p) => !p.land || isCreatureLand(p))
  const attachments = nonlands.filter((p) => p.attachedTo)
  const mains = nonlands.filter((p) => !p.attachedTo).sort((a, b) => a.typeRank - b.typeRank)
  // An attachment I control whose target genuinely isn't on ANY seat's battlefield (target died,
  // or otherwise unresolvable) falls back to rendering as its own standalone tile here rather
  // than silently vanishing — but if its target IS found (on this seat or another player's),
  // it's rendered as a peek there instead via globalAttachmentsByTarget, not duplicated here.
  const orphanAttachments = attachments.filter((att) => !allMainIds.has(att.attachedTo as string))
  // Otherwise-visually-identical creatures (same name/tapped/attacking/P-T — e.g. two 1/1
  // tokens) must NOT merge into one group if only one of them actually has something attached —
  // the group's "rep" (whichever copy is first-seen) is what globalAttachmentsByTarget gets
  // looked up by, so if the wrong copy of an identical pair became rep, the peek (and this
  // permanent's "equipped with" context on inspect) would silently vanish for the one that
  // actually has it. Keying on whether each copy has any attachments keeps them apart.
  const mainGroups = groupIdenticalPermanents(mains, (perm) => (globalAttachmentsByTarget.has(perm.id) ? 'attached' : ''))

  return (
    <div
      className={`playtest-seat ${playerProgress.active ? 'is-active-turn' : ''} ${playerProgress.lost ? 'is-lost' : ''} ${isWinner ? 'is-winner' : ''}`}
      data-seat-player={playerProgress.name}
    >
      {chosenCard?.image_uris?.art_crop && (
        <span className="playtest-seat__art-bg" style={{ backgroundImage: `url(${chosenCard.image_uris.art_crop})` }} />
      )}
      <div className="playtest-seat__header">
        <span className="playtest-seat__name">
          {chosenDeck?.name ?? playerProgress.name}
          {playerProgress.lost && <span className="playtest-seat__tag">Eliminated</span>}
          {isWinner && <span className="playtest-seat__tag playtest-seat__tag--winner">Winner</span>}
        </span>
        {/* Deck/Graveyard now have their own dedicated visual zones (see the hand row below) —
            this spot shows commander damage taken instead (903.14a: 21+ from the same commander
            is a loss), which had nowhere to live before. Empty/no-damage-yet shows nothing, so
            it doesn't eat header space until it's actually relevant. */}
        {playerProgress.commanderDamage.length > 0 && (
          <span className="playtest-seat__commander-damage">
            {playerProgress.commanderDamage.map((cd, i) => (
              <span
                key={i}
                className={`playtest-seat__commander-damage-pill ${cd.amount >= 21 ? 'is-lethal' : cd.amount >= 15 ? 'is-warning' : ''}`}
                title={`${cd.amount} commander damage from ${cd.commanderName}`}
              >
                <span className="playtest-seat__commander-damage-pill-name">{commanderOwnerLabel.get(cd.commanderName) ?? cd.commanderName}</span>{' '}
                <span className="playtest-seat__commander-damage-pill-amount">{cd.amount}</span>
              </span>
            ))}
          </span>
        )}
        {/* 104.1a: 10+ poison counters is a loss (infect decks) — has no other visible signal
            (life is a separate track entirely), so a warning color once it's actually dangerous
            matters more than a neutral badge would. */}
        {playerProgress.poison > 0 && (
          <span
            className={`playtest-seat__poison-pill ${playerProgress.poison >= 10 ? 'is-lethal' : playerProgress.poison >= 7 ? 'is-warning' : ''}`}
            title={`${playerProgress.poison} poison counter${playerProgress.poison === 1 ? '' : 's'}`}
          >
            ☠ {playerProgress.poison}
          </span>
        )}
        <span className="playtest-seat__life-wrap">
          <span className="playtest-seat__life">{playerProgress.life}</span>
          {lifeFlash && (
            <span key={lifeFlash.nonce} className={`playtest-seat__life-flash ${lifeFlash.delta > 0 ? 'is-gain' : 'is-loss'}`}>
              {lifeFlash.delta > 0 ? `+${lifeFlash.delta}` : lifeFlash.delta}
            </span>
          )}
        </span>
      </div>
      {playerProgress.active && turnInfo && (
        <div className="playtest-seat__turn">
          <span className="playtest-seat__turn-num">Turn {turnInfo.turn}</span>
          <span className="playtest-seat__turn-step">{turnInfo.step.replace(/_/g, ' ').toLowerCase()}</span>
        </div>
      )}

      {playerProgress.active && turnInfo && (
        <StackOverlay stack={turnInfo.stack} activePlayerName={playerProgress.name} onInspect={(name) => onInspect(name)} />
      )}

      <ZoneRow
        variant="battlefield"
        label="Battlefield"
        count={mains.length + orphanAttachments.length}
        empty="No permanents"
        ownerName={playerProgress.name}
      >
        {mainGroups.map(({ rep, count, ids }, i) => (
          <Fragment key={rep.id}>
            {/* A visible break between creatures/artifacts/enchantments/other (typeRank changing)
                — not just the same uniform 4px every card already gets from each other. */}
            {i > 0 && mainGroups[i - 1].rep.typeRank !== rep.typeRank && <span className="playtest-zone__divider" />}
            <PermanentGroup
              main={rep}
              attachments={globalAttachmentsByTarget.get(rep.id) ?? []}
              count={count}
              ownerName={playerProgress.name}
              tokenFlash={ids.some((id) => tokenFlashIds.has(id))}
              onInspect={(perm, equippedWith) => onInspect(perm.name, equippedWith, perm.setCode, perm.collectorNumber)}
            />
          </Fragment>
        ))}
        {orphanAttachments.map((perm) => (
          <PermanentThumb
            key={perm.id}
            perm={perm}
            ownerName={playerProgress.name}
            onInspect={() => onInspect(perm.name, undefined, perm.setCode, perm.collectorNumber)}
          />
        ))}
      </ZoneRow>

      <ZoneRow variant="lands" label="Lands" count={sortedLands.length} empty="No lands">
        {lands.map(({ rep, count, ids }) => (
          <PermanentThumb
            key={rep.id}
            perm={rep}
            variant="small"
            count={count}
            ownerName={playerProgress.name}
            tokenFlash={ids.some((id) => tokenFlashIds.has(id))}
            onInspect={() => onInspect(rep.name, undefined, rep.setCode, rep.collectorNumber)}
          />
        ))}
      </ZoneRow>

      <div className="playtest-hand-row">
        <ZoneRow variant="hand" label="Hand" count={playerProgress.hand.length} empty="Empty hand" ownerName={playerProgress.name}>
          {playerProgress.hand.map((card, i) => (
            <HandCardThumb
              key={i}
              card={card}
              ownerName={playerProgress.name}
              onInspect={() => onInspect(card.name, undefined, card.setCode, card.collectorNumber)}
            />
          ))}
        </ZoneRow>
        <ZoneRow
          variant="command"
          label="Command"
          count={(playerProgress.commandZone ?? []).length}
          empty="—"
          ownerName={playerProgress.name}
        >
          {(playerProgress.commandZone ?? []).map((c) => (
            <CommandZoneThumb
              key={c.name}
              card={c}
              ownerName={playerProgress.name}
              onInspect={() => onInspect(c.name, undefined, c.setCode, c.collectorNumber)}
            />
          ))}
        </ZoneRow>
        <DeckZoneTile count={playerProgress.librarySize} ownerName={playerProgress.name} />
        <GraveyardZoneTile
          count={playerProgress.graveyardSize}
          topCard={(playerProgress.graveyard ?? []).length > 0 ? (playerProgress.graveyard ?? []).at(-1)! : null}
          ownerName={playerProgress.name}
          onOpen={() => onOpenGraveyard(playerProgress.name, playerProgress.graveyard ?? [])}
        />
      </div>
    </div>
  )
}

export default function PlaytestTabView() {
  const [decks, setDecks] = useState<StoredDeck[]>([])
  const [precons, setPrecons] = useState<PreconDeck[]>([])
  const [slots, setSlots] = useState<ParticipantSlot[]>([
    { source: 'deck', id: null },
    { source: 'deck', id: null },
    { source: 'deck', id: null },
    { source: 'deck', id: null }
  ])
  const [simStatus, setSimStatus] = useState<GameSimStatus>({ phase: 'idle' })
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<GameSimResult | null>(null)
  // Separate from `result` itself — `result !== null` is what keeps the board on-screen
  // (boardActive), so closing the victory popup can't clear `result` without also kicking the
  // whole board back to the picker. This just hides the popup while the final board state stays
  // visible underneath.
  const [victoryDismissed, setVictoryDismissed] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<GameSimProgress | null>(null)
  const [narratorLog, setNarratorLog] = useState<string[]>([])
  const narratorLogRef = useRef<HTMLDivElement | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  // Which deck name (if any) is in each of the 4 seats for the game currently running/just
  // finished — kept separate from `slots` so the picker can be changed for the *next* game
  // without retroactively relabeling a board that's mid-game. Matched by name rather than index
  // since a skipped seat (e.g. only 3 of 4 picked) means progress.players is denser than slots.
  const [seatNames, setSeatNames] = useState<(string | null)[]>([null, null, null, null])
  const pollRef = useRef<number | null>(null)
  const [narratorExpanded, setNarratorExpanded] = useState(false)
  const narratorModalLinesRef = useRef<HTMLDivElement | null>(null)

  // Click-to-inspect: any card on the board, in a hand, in a command zone, in a graveyard
  // popup, or named in the narrator log resolves here. `inspectingEquippedWith` is only ever
  // populated for a battlefield permanent click (see PermanentGroup) — it's extra live-game
  // context CardDetail itself doesn't know about, so it's shown in a small side panel instead
  // of teaching CardDetail (used all over the app) about Playtest-specific state.
  const [inspectingCard, setInspectingCard] = useState<ScryfallCard | null>(null)
  const [inspectingIsFoil, setInspectingIsFoil] = useState(false)
  const [inspectingEquippedWith, setInspectingEquippedWith] = useState<string[]>([])
  const [viewingGraveyard, setViewingGraveyard] = useState<{ playerName: string; cards: GameSimCardRef[] } | null>(null)

  // The fetched game result, held back from `result` (and therefore from the UI) until the
  // playback queue has fully drained — the real simulation finishes almost instantly, so
  // surfacing the winner the moment it's known would spoil a game the visualization hasn't
  // actually reached the end of yet.
  const pendingResultRef = useRef<GameSimResult | null>(null)

  async function inspectCardByName(name: string, equippedWith: string[] = [], setCode?: string, collectorNumber?: string): Promise<void> {
    setInspectingEquippedWith(equippedWith)
    // Exact printing first when known (a battlefield permanent click carries it) — same
    // reasoning as useCardImage: name-only resolution can't tell two different arts of the same
    // card apart, so inspecting a specific-art basic land could otherwise show the wrong one.
    const exact = setCode && collectorNumber ? cardDataBySetNumber.get(setNumberKey(setCode, collectorNumber)) : undefined
    const cached = exact ?? cardDataByName.get(name)
    if (cached) {
      setInspectingCard(cached)
      setInspectingIsFoil(isFoilPrintingAny(cached.id))
      return
    }
    const result = await window.api.getCardByFuzzyName(name)
    if (!isError(result)) {
      const card = result as ScryfallCard
      cardDataByName.set(name, card)
      setInspectingCard(card)
      setInspectingIsFoil(isFoilPrintingAny(card.id))
    }
  }

  // XMage's own log lines embed card names as <font color="...">Name</font> (rendered via
  // dangerouslySetInnerHTML below, since that markup comes from the trusted engine process, not
  // user input). Clicking one of those names inspects that card instead of triggering whatever
  // the surrounding line's own click handler does (open the log modal, in the compact strip).
  function handleNarratorLineClick(e: React.MouseEvent, openModalOtherwise: () => void): void {
    const target = e.target as HTMLElement
    const fontEl = target.closest('font')
    if (fontEl?.textContent) {
      inspectCardByName(fontEl.textContent)
      return
    }
    openModalOtherwise()
  }

  // The actual XMage game computes far faster than anyone would want to watch it (a full game
  // finishes in seconds), so "pause"/"play"/"speed" aren't controls over the simulation itself
  // (which has no pause hook and would already be done) — they're playback controls over the
  // stream of progress snapshots it emits. Snapshots land in this queue as they arrive; a
  // separate timer below drains one at a time onto the screen at a controllable pace. Pausing
  // just stops draining — the queue (and the underlying game) keeps going untouched, so
  // resuming picks up exactly where the display left off rather than skipping ahead.
  const snapshotQueueRef = useRef<GameSimProgress[]>([])
  // Every snapshot for the current game, kept for its full duration regardless of playback speed
  // or pausing — snapshotQueueRef above is drained/discarded as it's displayed, so it alone can't
  // answer "what happened over the whole game" once that's needed for post-match analysis
  // (PlaytestAnalysisView). Populated in the same onGameSimProgress handler snapshotQueueRef is,
  // not in the paced tick() drain below, so it captures the true sequence either way.
  const snapshotHistoryRef = useRef<GameSimProgress[]>([])
  // Each seat's real decklist (and display info) for the current game, set once at game start —
  // see handleWatchGame, where `players` (the same array sent to the engine) is built.
  // PlaytestAnalysisView needs this after the game ends: engineName to match snapshotHistoryRef's
  // player entries (which use XMage's internal "Player N" naming), deckName/commanderName for
  // display (commanderName resolves art the same way the Victory modal already does), cardNames
  // for knowing which cards to look for.
  const gamePlayersRef = useRef<{ engineName: string; deckName: string; commanderName: string; cardNames: string[] }[]>([])
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)

  // java-bridge processes one runGame request at a time on a single thread — if a new game is
  // started while a previous one is still finishing (its request just queued behind the old one
  // rather than rejected), that old game's progress keeps streaming through this same channel in
  // the meantime. Tracking which request id is actually "ours" and dropping anything else is
  // what stops a freshly started game from momentarily showing a stale, already-in-progress
  // board from whatever ran before it.
  const activeRequestIdRef = useRef<string | null>(null)
  // The previously-drained snapshot — kept purely so triggerActionSounds can diff battlefield
  // state to detect ETB/graveyard/exile/counter events (see its own comment for why those can't
  // just be text-matched the way cast/draw/discard/damage are).
  const lastDrainedRef = useRef<GameSimProgress | null>(null)
  // Keyed by (XMage-internal) player name — the current floating life-change badge for that
  // seat, if its short lifespan (see the setTimeout below) hasn't elapsed yet. A ref, not state,
  // tracks the nonce each flash was scheduled to clear under so a rapid second life change to
  // the same player doesn't get wiped early by the first change's stale cleanup timer.
  const [lifeFlashes, setLifeFlashes] = useState<Record<string, LifeFlash>>({})
  const lifeFlashNonceRef = useRef(0)
  // Currently in-flight zone-move animations (see computeZoneMoves/resolveZoneMoveFlights) — a
  // plain incrementing id rather than a nonce-per-source-key like lifeFlashes, since any number
  // of flights can be happening at once (a token-maker creating 5 tokens, or several attackers
  // dying in one combat) and none of them replace each other the way a single life-total flash
  // does.
  const [flyingCards, setFlyingCards] = useState<FlyingCard[]>([])
  const flyingCardIdRef = useRef(0)

  useEffect(() => {
    return window.api.onGameSimProgress((p) => {
      const progress = p as GameSimProgress
      if (progress.id !== activeRequestIdRef.current) return
      snapshotQueueRef.current.push(progress)
      snapshotHistoryRef.current.push(progress)
    })
  }, [])

  useEffect(() => {
    if (!playing) return
    // A plain fixed-interval setInterval can't vary its own pace, but the pre-game stretch
    // (everyone draws seven, decides mulligan or not) genuinely should — nobody wants to sit
    // through that at 2s/action just because that's the chosen speed for the actual game. XMage
    // has no turn structure yet during that stretch, so every one of those snapshots naturally
    // carries an empty `step` (see Main.java) — a real signal to fast-forward through, not a
    // guess based on turn number or log text. Self-rescheduling via setTimeout instead of a
    // fixed setInterval is what lets each tick pick its own delay based on what it just drained.
    let timeoutId: number
    function tick(): void {
      const next = snapshotQueueRef.current.shift()
      if (!next) {
        // Nothing left to play — if the simulation has already finished (result fetched and
        // held back), this is the moment the visualization has actually caught up to it, so
        // reveal it now rather than the instant the engine itself finished computing.
        if (pendingResultRef.current) {
          setResult(pendingResultRef.current)
          pendingResultRef.current = null
          setRunning(false)
        }
        timeoutId = window.setTimeout(tick, 100)
        return
      }
      triggerActionSounds(lastDrainedRef.current, next)
      updatePermanentFlashes(lastDrainedRef.current, next)
      // Must run before setProgress(next) below — resolveZoneMoveOrigins needs the DOM to still
      // reflect the PREVIOUS snapshot to find a departing permanent's tile before React unmounts
      // it. The other half (resolveZoneMoveDestinations) runs the opposite way — AFTER
      // setProgress, once React has committed — see the rAF below.
      const zoneMoves = computeZoneMoves(lastDrainedRef.current, next)
      const zoneMoveOrigins = zoneMoves.length > 0 && boardRef.current ? resolveZoneMoveOrigins(boardRef.current, zoneMoves) : []
      const lifeDeltas = computeLifeDeltas(lastDrainedRef.current, next)
      if (lifeDeltas.length > 0) {
        setLifeFlashes((prevFlashes) => {
          const merged = { ...prevFlashes }
          for (const d of lifeDeltas) {
            const nonce = ++lifeFlashNonceRef.current
            merged[d.playerName] = { delta: d.delta, nonce }
            window.setTimeout(() => {
              setLifeFlashes((cur) => {
                if (cur[d.playerName]?.nonce !== nonce) return cur
                const rest = { ...cur }
                delete rest[d.playerName]
                return rest
              })
            }, 1300)
          }
          return merged
        })
      }
      lastDrainedRef.current = next
      setProgress(next)
      if (zoneMoveOrigins.length > 0) {
        // A newly-cast permanent's own tile doesn't exist in the DOM until the render this
        // setProgress just triggered actually commits — one rAF is enough to land after that.
        window.requestAnimationFrame(() => {
          const board = boardRef.current
          if (!board) return
          const flights = resolveZoneMoveDestinations(board, zoneMoveOrigins)
          if (flights.length === 0) return
          const newCards: FlyingCard[] = flights.map((f) => ({ id: ++flyingCardIdRef.current, ...f }))
          setFlyingCards((prev) => [...prev, ...newCards])
          window.setTimeout(() => {
            const ids = new Set(newCards.map((c) => c.id))
            setFlyingCards((prev) => prev.filter((c) => !ids.has(c.id)))
          }, 550)
        })
      }
      if (next.logLine) {
        setNarratorLog((prev) => [...prev, recolorPlayerNames(next.logLine)])
      }
      const delay = next.step === '' ? 30 : 2000 / speed
      timeoutId = window.setTimeout(tick, delay)
    }
    timeoutId = window.setTimeout(tick, 0)
    return () => window.clearTimeout(timeoutId)
  }, [playing, speed])

  // Auto-scroll the narrator log to the newest line as it grows.
  useEffect(() => {
    const el = narratorLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [narratorLog])

  // The expanded log modal should open already scrolled to the latest entry, not the start of
  // the game's log.
  useEffect(() => {
    if (narratorExpanded && narratorModalLinesRef.current) {
      narratorModalLinesRef.current.scrollTop = narratorModalLinesRef.current.scrollHeight
    }
  }, [narratorExpanded])

  useEffect(() => {
    window.api.listDecks().then((list) => setDecks(list as StoredDeck[]))
    window.api.listPrecons().then((list) => setPrecons(list as PreconDeck[]))
  }, [])

  // Which slot's deck-picker popup is open, and which step it's on — clicking a seat's "Choose
  // Deck" button opens it on 'source' (pick My Decks vs Precons), then moves to 'browse' (a
  // compact grid of that source's decks) once a source is picked.
  const [picker, setPicker] = useState<{ slotIndex: number; step: 'source' | 'browse'; source: SourceKind } | null>(null)

  // Picker-mode seats show the chosen deck's commander art (small portrait on the button, a
  // low-opacity art_crop bled into the seat background) — batched rather than per-open, so
  // opening the browse grid or picking a deck never waits on a fetch. artVersion exists purely
  // to force a re-render once the cache actually fills in, since cardDataByName/cardImageCache
  // are plain module-level Maps, not React state.
  const [, setArtVersion] = useState(0)
  // By id, not name — a deck's commanderId is the EXACT printing the user picked (an alt-art
  // border, a specific set, etc.), and a plain name-based lookup would resolve to whatever
  // Scryfall considers the default printing instead, silently showing the wrong art. Still
  // stored keyed by name afterward (cardDataByName's key everywhere else), since that's all a
  // live battlefield permanent from XMage ever carries — but the value under that name now
  // comes from fetching the specific id, not a fuzzy name search.
  function fetchCommanderArtByIds(pairs: { id: string; name: string }[]): void {
    const missing = pairs.filter((p) => !cardDataByName.has(p.name))
    const ids = [...new Set(missing.map((p) => p.id))]
    if (ids.length === 0) return
    window.api.getCardsByIds(ids).then((result) => {
      // Chunked requests (Scryfall's collection endpoint caps at ~75 identifiers) bail out on
      // the FIRST chunk that errors — bailing here on a transient failure would otherwise leave
      // every remaining card permanently unresolved for the rest of the session, since nothing
      // else ever retries once it's been asked for. Keeping the My Decks and Precons fetches
      // separate (below) means a hiccup in one can't take out the other too.
      if (isError(result)) return
      for (const card of (result as { data: ScryfallCard[] }).data) {
        cardDataByName.set(card.name, card)
        const url = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null
        if (url) cardImageCache.set(card.name, url)
      }
      setArtVersion((v) => v + 1)
    })
  }

  function commanderIdNamePairs(list: { commanderId: string; commanderName: string; partnerCommanderId: string | null; partnerCommanderName: string | null }[]): { id: string; name: string }[] {
    return list.flatMap((d) => [
      { id: d.commanderId, name: d.commanderName },
      ...(d.partnerCommanderId && d.partnerCommanderName ? [{ id: d.partnerCommanderId, name: d.partnerCommanderName }] : [])
    ])
  }

  // My Decks is a personal-scale list and its art is needed immediately (the seat's chosen-deck
  // button, the My Decks picker step), so it's fetched eagerly as soon as the list loads.
  useEffect(() => {
    fetchCommanderArtByIds(commanderIdNamePairs(decks))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decks])

  // Precons is a much bigger, session-wide-shared library (~160 decks) that most games won't
  // ever touch — fetched lazily, the first time the Precons picker step is actually opened,
  // rather than always paying that cost on every Playtest tab visit.
  useEffect(() => {
    if (picker?.step !== 'browse' || picker.source !== 'precon') return
    fetchCommanderArtByIds(commanderIdNamePairs(precons))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, precons])

  // Kicks off the sidecar's ~35-70s one-time card-database scan as soon as this tab is opened,
  // rather than waiting for "Watch Game" to be clicked — see gameSim.ts's warmUpGameSim comment.
  useEffect(() => {
    window.api.warmUpGameSim()
    pollRef.current = window.setInterval(async () => {
      const s = (await window.api.getGameSimStatus()) as GameSimStatus
      setSimStatus(s)
      if (s.phase === 'ready' || s.phase === 'error') {
        if (pollRef.current) window.clearInterval(pollRef.current)
      }
    }, 1000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  function updateSlot(index: number, patch: Partial<ParticipantSlot>): void {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const selectedCount = useMemo(() => slots.filter((s) => s.id).length, [slots])
  const boardActive = running || result !== null

  function findDeckOrPrecon(slot: ParticipantSlot): {
    name: string
    commanderId: string
    commanderName: string
    partnerCommanderId: string | null
    partnerCommanderName: string | null
    cardIds: string[]
    // Only StoredDeck tracks owned-in-foil printings — precons aren't a personal collection, so
    // this is always empty for them.
    foilIds: string[]
    // Only StoredDeck can have a Logic file attached (see docs/logic-file-guide.md) — precons
    // are shared/read-only, so this is always empty for them.
    logicRules: LogicRule[]
  } | null {
    if (!slot.id) return null
    if (slot.source === 'deck') {
      const deck = decks.find((d) => d.id === slot.id)
      if (!deck) return null
      return {
        name: deck.name,
        commanderId: deck.commanderId,
        commanderName: deck.commanderName,
        partnerCommanderId: deck.partnerCommanderId,
        partnerCommanderName: deck.partnerCommanderName,
        cardIds: deck.cardIds,
        foilIds: deck.foilIds,
        logicRules: deck.logicFile?.rules ?? []
      }
    }
    const precon = precons.find((p) => p.id === slot.id)
    if (!precon) return null
    return {
      name: precon.name,
      commanderId: precon.commanderId,
      commanderName: precon.commanderName,
      partnerCommanderId: precon.partnerCommanderId,
      partnerCommanderName: precon.partnerCommanderName,
      cardIds: precon.cardIds,
      foilIds: [],
      logicRules: []
    }
  }

  function handleNewGame(): void {
    // Also doubles as "End Game" (see the button in the narrator row) — that one can fire while
    // a game is still actively simulating, not just after one has finished. Without resetting
    // `running` here too, the Start Game button (disabled while running) stayed stuck disabled
    // forever after ending a game early — this was a real bug, not just theoretical.
    //
    // If a game was actually still running, abort it for real (kills + respawns the java-bridge
    // process — see abortGameSim/gameSim.ts's abortGame) rather than just discarding the
    // renderer's own view of it. Fire-and-forget: the reset below is instant regardless, and the
    // simStatus polling this view already does surfaces the brief "warming up" respawn window.
    if (running) void window.api.abortGameSim()
    activeRequestIdRef.current = null
    lastDrainedRef.current = null
    setRunning(false)
    setResult(null)
    setVictoryDismissed(false)
    setAnalysisOpen(false)
    setProgress(null)
    setError(null)
    setSeatNames([null, null, null, null])
    setNarratorLog([])
    snapshotQueueRef.current = []
    snapshotHistoryRef.current = []
    pendingResultRef.current = null
    setLifeFlashes({})
    setFlyingCards([])
    setPlaying(true)
  }

  async function handleWatchGame(): Promise<void> {
    const requestId = crypto.randomUUID()
    activeRequestIdRef.current = requestId
    lastDrainedRef.current = null
    setRunning(true)
    setResult(null)
    setVictoryDismissed(false)
    setAnalysisOpen(false)
    setError(null)
    setProgress(null)
    setNarratorLog([])
    snapshotQueueRef.current = []
    snapshotHistoryRef.current = []
    pendingResultRef.current = null
    setLifeFlashes({})
    setFlyingCards([])
    setPlaying(true)
    try {
      const resolvedSlots = slots.map(findDeckOrPrecon)
      // Seat placement (top-left=P1, top-right=P2, bottom-left=P3, bottom-right=P4) stays
      // index-order — seats are matched to progress data by NAME, not array position, so this
      // doesn't affect where anyone visually sits. Turn order is a separate thing: dealt
      // clockwise around the 2x2 grid (top-left → top-right → bottom-right → bottom-left) to
      // read like players seated clockwise around a real table, not raster/reading order (which
      // would jump diagonally from top-right to bottom-left, skipping bottom-right entirely).
      const CLOCKWISE_SLOT_ORDER = [0, 1, 3, 2]
      // XMage's own game log narrates using whatever name a player was given — deck/commander
      // names ("Fire Lord Azula casts...", "Wilson, Refined Grizzly draws...") read confusingly
      // once multiple long/similar names are interleaved in the log. "Player 1"-"Player 4" (the
      // same labels already used for the seats themselves) reads cleanly instead — matched to
      // ORIGINAL seat position (top-left=1..bottom-right=4), not turn order, so it doesn't
      // reshuffle when CLOCKWISE_SLOT_ORDER does. The seat header still shows the real
      // deck/commander name — that's resolved separately from `slot`+`decks`/`precons`, not from
      // this XMage-internal identifier.
      setSeatNames(resolvedSlots.map((p, i) => (p ? `Player ${i + 1}` : null)))
      const participants = CLOCKWISE_SLOT_ORDER.map((slotIndex) => {
        const data = resolvedSlots[slotIndex]
        return data ? { ...data, slotIndex } : null
      }).filter((p): p is NonNullable<typeof p> => p !== null)
      foilIdsByPlayerName.clear()
      for (const p of participants) {
        if (p.foilIds.length > 0) foilIdsByPlayerName.set(`Player ${p.slotIndex + 1}`, new Set(p.foilIds))
      }
      if (participants.length < 2) {
        setError('Pick at least 2 decks to run a game.')
        setRunning(false)
        return
      }

      // Card ids -> names: commanders are already stored as plain name strings on both
      // StoredDeck and PreconDeck (never in cardIds), so only the ~99 library cards need a
      // lookup.
      const allCardIds = [...new Set(participants.flatMap((p) => p.cardIds))]
      const cardsResult = await window.api.getCardsByIds(allCardIds)
      if (isError(cardsResult)) {
        setError(cardsResult.details)
        setRunning(false)
        return
      }
      const allCards = (cardsResult as { data: ScryfallCard[] }).data
      const nameById = new Map(allCards.map((c) => [c.id, c.name]))

      const players = participants.map((p) => ({
        name: `Player ${p.slotIndex + 1}`,
        commanderNames: [p.commanderName, p.partnerCommanderName].filter((n): n is string => Boolean(n)),
        cardNames: p.cardIds.map((id) => nameById.get(id)).filter((n): n is string => Boolean(n)),
        logicRules: p.logicRules
      }))
      // Kept for post-match analysis (PlaytestAnalysisView), which needs each seat's real
      // decklist after the game ends — cardNames is the same list already sent to the engine
      // above, so no separate resolution logic is needed there.
      gamePlayersRef.current = players.map((p, i) => ({
        engineName: p.name,
        deckName: participants[i].name,
        commanderName: participants[i].commanderName,
        cardNames: p.cardNames
      }))

      // Prefetch every card image *before* the game starts, from data already on hand, rather
      // than letting each battlefield thumbnail trigger its own individual fuzzy-name lookup
      // once the board is live — those go through Scryfall's "heavy endpoint" throttle
      // (~1.8 req/s), so 60-80 unique cards across 4 players resolving one at a time was
      // exactly why art was showing up so slowly. Commanders are the only names not already in
      // `allCards` (they're not part of `cardIds`), so one batched name lookup covers them.
      for (const card of allCards) {
        const url = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null
        if (url) cardImageCache.set(card.name, url)
        cardDataByName.set(card.name, card)
        cardDataBySetNumber.set(setNumberKey(card.set, card.collector_number), card)
        // Any nonland card could end up narrated as a triggered ability's source or cast as a
        // spell and land on the stack, which renders at the large size — not just
        // instants/sorceries, since a permanent's own ability going on the stack shows that
        // permanent's art too. Lands never go on the stack at all (no land ever has an ability
        // that triggers there in a way that needs this), and a 99-card EDH deck is often a third
        // lands — skipping them meaningfully shrinks the preload batch competing for bandwidth
        // against the handful of cards actually likely to be needed soon.
        if (!card.type_line.includes('Land')) {
          preloadImage(card.image_uris?.normal ?? card.image_uris?.large ?? card.card_faces?.[0]?.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.large)
        }
      }
      for (const token of deriveTokens(allCards)) tokenImageCache.set(token.name, scryfallImageUrl(token.id, 'small'))

      // By id, not name — same reasoning as fetchCommanderArtByIds above: a name-based lookup
      // resolves to whatever Scryfall considers the default printing, silently overwriting the
      // correct art (already cached by id, if this deck was browsed in the picker) with the
      // wrong one right before the battlefield goes live. This was a real bug — commander art
      // shown in-game was ignoring the deck's actual chosen printing.
      const allCommanderIds = [...new Set(participants.flatMap((p) => [p.commanderId, p.partnerCommanderId].filter((id): id is string => Boolean(id))))]
      if (allCommanderIds.length > 0) {
        const commanderCardsResult = await window.api.getCardsByIds(allCommanderIds)
        if (!isError(commanderCardsResult)) {
          for (const card of (commanderCardsResult as { data: ScryfallCard[] }).data) {
            const url = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null
            if (url) cardImageCache.set(card.name, url)
            cardDataByName.set(card.name, card)
            preloadImage(card.image_uris?.normal ?? card.image_uris?.large ?? card.card_faces?.[0]?.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.large)
          }
        }
      }

      const allNames = [...new Set(players.flatMap((p) => [...p.commanderNames, ...p.cardNames]))]
      const missing = await window.api.checkGameSimCards(allNames)
      if (!Array.isArray(missing)) {
        setError((missing as { details: string }).details)
        setRunning(false)
        return
      }
      if (missing.length > 0) {
        setError(`${missing.length} card(s) aren't supported by the simulator yet: ${missing.join(', ')}`)
        setRunning(false)
        return
      }

      const gameResult = await window.api.runGameSim(players, requestId)
      if ('error' in gameResult) {
        setError((gameResult as { details: string }).details)
        setRunning(false)
        return
      }
      // Held back rather than shown immediately — the real simulation finishes computing in
      // seconds, far faster than the playback queue drains onto the screen. The drain effect
      // above reveals this (and clears `running`) once the queue is actually empty, so the
      // result never spoils a game the visualization hasn't reached the end of yet.
      pendingResultRef.current = gameResult as GameSimResult
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRunning(false)
    }
  }

  const turnInfo = progress ? { turn: progress.turn, step: progress.step, stack: progress.stack } : null

  // Built once from ALL 4 players' battlefields combined (not per-seat) — an Aura/Equipment's
  // controller isn't necessarily the controller of whatever it's attached to (e.g. an opponent
  // enchants your creature), so matching "what's attached to this permanent" has to search every
  // seat, not just the one the attachment happens to be listed under.
  const allNonlandPerms = (progress?.players ?? []).flatMap((p) => p.battlefield.filter((perm) => !perm.land || isCreatureLand(perm)))
  const allMainIds = new Set(allNonlandPerms.filter((perm) => !perm.attachedTo).map((perm) => perm.id))
  const globalAttachmentsByTarget = new Map<string, GameSimPermanent[]>()
  for (const perm of allNonlandPerms) {
    if (!perm.attachedTo) continue
    const list = globalAttachmentsByTarget.get(perm.attachedTo)
    if (list) list.push(perm)
    else globalAttachmentsByTarget.set(perm.attachedTo, [perm])
  }

  // Commander damage is tracked (and narrated) by the commander's own card name, but a full
  // commander name ("Wilson, Refined Grizzly") is too long to read as a compact pill on a small
  // seat header — "Player N" (the same short label already used everywhere else) reads instantly
  // instead. Built once from the live slot/deck picks (same source PlaytestSeat's own header
  // already resolves its display name from), keyed by every commander name currently in play
  // (including partners, since either half of a partner pair can deal commander damage).
  const commanderOwnerLabel = new Map<string, string>()
  slots.forEach((slot, i) => {
    if (!seatNames[i]) return
    const data = findDeckOrPrecon(slot)
    if (!data) return
    const label = `Player ${i + 1}`
    commanderOwnerLabel.set(data.commanderName, label)
    if (data.partnerCommanderName) commanderOwnerLabel.set(data.partnerCommanderName, label)
  })

  return (
    <div className="app__results playtest-page">
      {!boardActive && (
        <>
          <h2 className="set-detail__title">Simulation</h2>
          <p className="app__hint">
            Watch AI-piloted decks play a real, rules-accurate Commander game against each other —
            powered by the XMage engine running in the background. Click a rectangle below to pick
            a deck (your own saved decks or precons); once the game starts, that same rectangle
            becomes that deck's battlefield.
          </p>
        </>
      )}

      {simStatus.phase !== 'ready' && (
        <p className="app__hint">
          {simStatus.phase === 'starting' && 'Warming up the game engine (one-time, can take up to a minute)…'}
          {simStatus.phase === 'idle' && 'Starting the game engine…'}
          {simStatus.phase === 'error' && `Game engine failed to start: ${simStatus.error}`}
        </p>
      )}

      <div className="playtest-board-wrap">
        {boardActive && !running && (
          <div className="playtest-board-header">
            <button className="secondary-button" onClick={() => setAnalysisOpen(true)}>
              View Analysis
            </button>
            <button className="secondary-button" onClick={handleNewGame}>
              New Game
            </button>
          </div>
        )}

        <div className="playtest-board" ref={boardRef}>
          {boardActive && <CombatArrowsOverlay progress={progress} boardRef={boardRef} />}
          {boardActive && <FlyingCardsLayer flyingCards={flyingCards} />}
          {slots.map((slot, i) => (
            <PlaytestSeat
              key={i}
              index={i}
              boardActive={boardActive}
              slot={slot}
              decks={decks}
              precons={precons}
              onOpenPicker={() => setPicker({ slotIndex: i, step: 'source', source: slot.source })}
              playerProgress={progress?.players.find((p) => p.name === seatNames[i])}
              isWinner={Boolean(result && seatNames[i] && result.winner.includes(seatNames[i] as string))}
              lifeFlash={seatNames[i] ? lifeFlashes[seatNames[i] as string] : undefined}
              turnInfo={turnInfo}
              onInspect={inspectCardByName}
              onOpenGraveyard={(playerName, cards) => setViewingGraveyard({ playerName, cards })}
              globalAttachmentsByTarget={globalAttachmentsByTarget}
              allMainIds={allMainIds}
              commanderOwnerLabel={commanderOwnerLabel}
            />
          ))}
          {boardActive && (
            <button
              className="playtest-play-pause"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? 'Pause playback' : 'Resume playback'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
          )}
        </div>

        {boardActive && (
          <div className="playtest-narrator-row">
            <div
              className="playtest-narrator"
              ref={narratorLogRef}
              onClick={(e) => handleNarratorLineClick(e, () => setNarratorExpanded(true))}
            >
              {narratorLog.length === 0 ? (
                <p className="playtest-narrator__line playtest-zone__empty">Game actions will appear here…</p>
              ) : (
                narratorLog.map((line, i) => (
                  <p key={i} className="playtest-narrator__line" dangerouslySetInnerHTML={{ __html: line }} />
                ))
              )}
            </div>
            <div className="playtest-narrator-controls">
              <SpeedPicker speed={speed} onChange={setSpeed} />
              <button className="playtest-end-game" onClick={handleNewGame}>
                End Game
              </button>
            </div>
          </div>
        )}
      </div>

      {narratorExpanded && (
        <div className="playtest-narrator-modal-overlay" onClick={() => setNarratorExpanded(false)}>
          <div className="playtest-narrator-modal" onClick={(e) => e.stopPropagation()}>
            <div className="deck-tag-filter__header">
              <h3 className="section-heading">Game Log</h3>
              <button className="deck-tag-filter__close" onClick={() => setNarratorExpanded(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div
              className="playtest-narrator-modal__lines"
              ref={narratorModalLinesRef}
              onClick={(e) => handleNarratorLineClick(e, () => {})}
            >
              {narratorLog.map((line, i) => (
                <p key={i} className="playtest-narrator__line" dangerouslySetInnerHTML={{ __html: line }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {analysisOpen && result && (
        <PlaytestAnalysisView
          history={snapshotHistoryRef.current}
          result={result}
          players={gamePlayersRef.current}
          onClose={() => setAnalysisOpen(false)}
          onInspect={inspectCardByName}
        />
      )}

      {picker && (
        <div className="playtest-narrator-modal-overlay" onClick={() => setPicker(null)}>
          <div className="playtest-narrator-modal playtest-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="deck-tag-filter__header">
              <h3 className="section-heading">
                {picker.step === 'source'
                  ? `Choose a deck for ${SLOT_LABELS[picker.slotIndex]}`
                  : picker.source === 'deck'
                    ? 'My Decks'
                    : 'Precons'}
              </h3>
              <button className="deck-tag-filter__close" onClick={() => setPicker(null)} aria-label="Close">
                ×
              </button>
            </div>

            {picker.step === 'source' ? (
              <div className="playtest-picker-source-row">
                <button
                  className="playtest-picker-square-button"
                  onClick={() => setPicker({ ...picker, step: 'browse', source: 'deck' })}
                >
                  My Decks
                </button>
                <button
                  className="playtest-picker-square-button"
                  onClick={() => setPicker({ ...picker, step: 'browse', source: 'precon' })}
                >
                  Precons
                </button>
              </div>
            ) : (
              <>
                <button className="secondary-button playtest-picker-back" onClick={() => setPicker({ ...picker, step: 'source' })}>
                  ← Back
                </button>
                {picker.source === 'deck' ? (
                  <div className="deck-list playtest-picker-deck-list">
                    {decks.map((d) => (
                      <DeckPickerRow
                        key={d.id}
                        deck={d}
                        onSelect={() => {
                          updateSlot(picker.slotIndex, { source: 'deck', id: d.id })
                          setPicker(null)
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="card-grid card-grid--hotswap playtest-picker-grid">
                    {precons.map((d) => {
                      const card = cardDataByName.get(d.commanderName)
                      return (
                        <button
                          key={d.id}
                          className="playtest-picker-deck-tile"
                          onClick={() => {
                            updateSlot(picker.slotIndex, { source: 'precon', id: d.id })
                            setPicker(null)
                          }}
                        >
                          {card?.image_uris?.small ? (
                            <img src={card.image_uris.small} alt={d.name} />
                          ) : (
                            <div className="playtest-perm__placeholder">{d.name}</div>
                          )}
                          <span className="playtest-picker-deck-tile__name">{d.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {viewingGraveyard && (
        <div className="playtest-narrator-modal-overlay" onClick={() => setViewingGraveyard(null)}>
          <div className="playtest-narrator-modal" onClick={(e) => e.stopPropagation()}>
            <div className="deck-tag-filter__header">
              <h3 className="section-heading">{viewingGraveyard.playerName}'s Graveyard</h3>
              <button className="deck-tag-filter__close" onClick={() => setViewingGraveyard(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="playtest-graveyard-modal__cards">
              {viewingGraveyard.cards.length === 0 ? (
                <p className="playtest-zone__empty">Empty</p>
              ) : (
                viewingGraveyard.cards.map((card, i) => (
                  <GraveyardCardThumb
                    key={i}
                    card={card}
                    ownerName={viewingGraveyard.playerName}
                    onInspect={() => inspectCardByName(card.name, undefined, card.setCode, card.collectorNumber)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {inspectingCard && (
        <CardDetail
          card={inspectingCard}
          onClose={() => setInspectingCard(null)}
          minimal
          isFoil={inspectingIsFoil}
          equippedWith={inspectingEquippedWith.map((name) => ({
            name,
            imageUrl: cardImageCache.get(name) ?? null,
            onClick: () => inspectCardByName(name)
          }))}
        />
      )}

      {!boardActive && (
        <button
          className="primary-button playtest-watch-button"
          onClick={handleWatchGame}
          disabled={running || selectedCount < 2 || simStatus.phase !== 'ready'}
        >
          Watch Game
        </button>
      )}

      {error && <p className="app__error">{error}</p>}

      {result &&
        !victoryDismissed &&
        (() => {
          // Same slot+decks/precons resolution PlaytestSeat uses for its own commander art —
          // repeated here rather than threaded down, since the winner's identity (which SEAT
          // won) only exists at this level (seatNames/slots), not inside any one seat.
          const winningSlotIndex = seatNames.findIndex((n) => n && result.winner.includes(n))
          const winningSlot = winningSlotIndex >= 0 ? slots[winningSlotIndex] : null
          const winningDeck = winningSlot?.id ? (winningSlot.source === 'deck' ? decks : precons).find((d) => d.id === winningSlot.id) : null
          const winningCard = winningDeck ? cardDataByName.get(winningDeck.commanderName) : null
          return (
            <div className="playtest-victory-overlay" onClick={() => setVictoryDismissed(true)}>
              <div className="playtest-victory-modal" onClick={(e) => e.stopPropagation()}>
                <button className="deck-tag-filter__close" onClick={() => setVictoryDismissed(true)} aria-label="Close">
                  ×
                </button>
                <h2 className="playtest-victory-title">Victory</h2>
                {winningDeck && (
                  // Same slab as the deck picker's chosen-deck button (playtest-deck-button--chosen)
                  // — the exact visual reference asked for — just not an actual <button>, since
                  // there's nothing to click it into here.
                  <div className="playtest-deck-button playtest-deck-button--chosen playtest-victory-slab">
                    {winningCard?.image_uris?.small ? (
                      <img src={winningCard.image_uris.small} alt={winningDeck.commanderName} />
                    ) : (
                      <div className="playtest-perm__placeholder">{winningDeck.commanderName}</div>
                    )}
                    <span className="playtest-deck-button__name">{winningDeck.name}</span>
                  </div>
                )}
                <p className="app__hint">
                  {result.turns} turns · {(result.gameMs / 1000).toFixed(1)}s
                </p>
                <div className="playtest-victory-actions">
                  <button className="secondary-button" onClick={() => setAnalysisOpen(true)}>
                    View Analysis
                  </button>
                  <button className="primary-button" onClick={handleNewGame}>
                    New Game
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
    </div>
  )
}
