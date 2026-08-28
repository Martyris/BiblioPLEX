import { useId, useState } from 'react'
import type { ScryfallCard } from '../types'

interface Props {
  card: ScryfallCard
  onSelect: (card: ScryfallCard) => void
  // Drives the green "in deck" outline. Badge visibility follows this unless showBadge
  // overrides it (e.g. Want's "✓ Wanted" badge with no outline).
  inDeck?: boolean
  badgeLabel?: string
  showBadge?: boolean
  onContextMenu?: (card: ScryfallCard, e: React.MouseEvent) => void
  // Marks a search-result card that's already on the Card Pool or Want list (independent of
  // whether it's actually in the deck) — a colored outline, distinct from the "in deck" one.
  marker?: 'want' | 'pool'
  // Owned-in-foil, per the card-inspect toggle — renders the same shimmer effect as the
  // inspect view, directly over the thumbnail.
  isFoil?: boolean
  // Set only for cards actually sitting in a deck's own 99 — a search result or Want-list
  // tile isn't part of the deck yet, so legality doesn't apply to it the same way.
  illegalReason?: 'color-identity' | 'banned' | null
  // Flagged via the deck grid's right-click menu as being weighed for removal — independent of
  // every other marker above, so it can coexist with an outline/badge that's already showing.
  isConsidering?: boolean
  // Set when this tile is a card's secondary appearance in a subtype group that isn't its
  // primary (first-listed) subtype — e.g. Hydroid Krasis showing up under "Jellyfish" as well as
  // its main "Hydra" group. Faded by default (see .card-tile.is-ghost in styles.css), full
  // opacity on hover so the card is still easy to actually look at.
  isGhost?: boolean
}

const ILLEGAL_LABELS: Record<'color-identity' | 'banned', string> = {
  'color-identity': '⚠ Outside Color Identity',
  banned: '⚠ Banned in Commander'
}

// Varied size/aspect/rotation per spot, spread all the way to the corners/edges (not clustered
// toward the middle) — cx/cy/rx/ry are fractions of the tile (SVG objectBoundingBox units), so
// these work at any tile size. scale multiplies rx/ry on top of that — 1 is the
// original/smallest size, larger values scale a shape up from there. Each shape also gets a
// slow position/size drift and isn't a fixed static ellipse — see .card-tile__ghost-ellipse's
// ghost-blob-drift animation in styles.css, which is what makes the goo read as wandering rather
// than 7 stationary ovals. duration/delay match each shape to one of card-tile__ghost-ellipse's
// nth-child animation timings in styles.css (which also gives each a different peak opacity —
// kept in sync by hand — see that file). A few pairs (1&2, 4&5) sit close enough to actually
// overlap once blurred, which is where the goo merge becomes visible.
const GHOST_ELLIPSES = [
  { cx: 0.05, cy: 0.08, rx: 0.17, ry: 0.11, rotate: 15, scale: 1 },
  { cx: 0.5, cy: 0.02, rx: 0.13, ry: 0.18, rotate: -20, scale: 1.2 },
  { cx: 0.96, cy: 0.18, rx: 0.15, ry: 0.1, rotate: 40, scale: 1.35 },
  { cx: 0.04, cy: 0.52, rx: 0.12, ry: 0.17, rotate: -10, scale: 1.1 },
  { cx: 0.6, cy: 0.5, rx: 0.18, ry: 0.12, rotate: 25, scale: 1.4 },
  { cx: 0.95, cy: 0.6, rx: 0.11, ry: 0.16, rotate: -35, scale: 1 },
  { cx: 0.18, cy: 0.95, rx: 0.15, ry: 0.1, rotate: 5, scale: 1.2 }
]

export default function CardTile({
  card,
  onSelect,
  inDeck,
  badgeLabel = '✓ In Deck',
  showBadge,
  onContextMenu,
  marker,
  isFoil,
  illegalReason,
  isConsidering,
  isGhost
}: Props) {
  const image = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal
  const markerClass = marker === 'want' ? 'is-wanted' : marker === 'pool' ? 'is-pooled' : ''
  const shouldShowBadge = showBadge ?? inDeck
  // Unique per instance — SVG mask/filter ids are global to the document, and multiple ghost
  // tiles can be on screen at once (Group By Subtype often shows several), so a shared id would
  // make them all reference (and redundantly re-render) the same mask.
  const ghostId = useId()
  // Every ghost tile's pulse/drift/travel timing (styles.css) is driven by shared, static
  // per-nth-child CSS delays — fine for one card, but with several ghost tiles on screen at once
  // (Group By Subtype often shows more than one) they'd all be on the exact same clock and
  // animate in perfect lockstep, reading as one mirrored effect rather than independent cards.
  // A random per-instance offset, computed once and fed into every animation-delay via calc()
  // in CSS, shifts each card's whole timeline by a different amount so they fall out of sync.
  const [ghostPhaseOffset] = useState(() => -(Math.random() * 60))

  return (
    <button
      className={`card-tile ${inDeck ? 'is-in-deck' : ''} ${markerClass} ${isFoil ? 'is-foil' : ''} ${isConsidering ? 'is-considering' : ''} ${isGhost ? 'is-ghost' : ''}`}
      onClick={() => onSelect(card)}
      onContextMenu={(e) => onContextMenu?.(card, e)}
      title={card.name}
      style={isGhost ? ({ '--ghost-instance-offset': `${ghostPhaseOffset}s` } as React.CSSProperties) : undefined}
    >
      {isGhost && (
        // A real transparency mask on the image (not a colored layer painted over it) — the
        // animated ellipses below punch see-through holes that reveal whatever's behind the
        // card, which is what "ghostly" actually calls for, rather than dark paint on top of it.
        // width/height 0 + absolute positioning: this only exists to hold <defs>, never itself
        // takes up layout space or paints anything.
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
          <defs>
            <filter id={`ghost-goo-${ghostId}`} x="-50%" y="-50%" width="200%" height="200%" primitiveUnits="objectBoundingBox">
              {/* A much gentler alpha boost than a "true" goo effect uses (that needs a hard
                  threshold, which is exactly the sharp edge that was the problem) — this keeps
                  the blur's natural gradual falloff everywhere, just nudging overlapping blobs'
                  combined alpha a little higher so they read as blending together rather than
                  two separately-visible faded circles stacked on top of each other. */}
              <feGaussianBlur in="SourceGraphic" stdDeviation="0.07" result="blur" />
              <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 2.5 -0.25" />
            </filter>
            <mask id={`ghost-mask-${ghostId}`} maskContentUnits="objectBoundingBox">
              <rect x="0" y="0" width="1" height="1" fill="white" />
              <g filter={`url(#ghost-goo-${ghostId})`}>
                {GHOST_ELLIPSES.map((shape, i) => (
                  <ellipse
                    key={i}
                    className="card-tile__ghost-ellipse"
                    cx={shape.cx}
                    cy={shape.cy}
                    rx={shape.rx * shape.scale}
                    ry={shape.ry * shape.scale}
                    transform={`rotate(${shape.rotate} ${shape.cx} ${shape.cy})`}
                    fill="black"
                  />
                ))}
              </g>
            </mask>
          </defs>
        </svg>
      )}
      {image ? (
        <img
          src={image}
          alt={card.name}
          loading="lazy"
          decoding="async"
          style={isGhost ? { mask: `url(#ghost-mask-${ghostId})`, WebkitMask: `url(#ghost-mask-${ghostId})` } : undefined}
        />
      ) : (
        <div className="card-tile__placeholder">{card.name}</div>
      )}
      {shouldShowBadge && <span className="card-tile__badge">{badgeLabel}</span>}
      {card.game_changer && (
        <span className="card-tile__gc-badge" title="Game Changer — a Commander Bracket-defining card">
          GC
        </span>
      )}
      {illegalReason && (
        <span className="card-tile__illegal-badge" title={ILLEGAL_LABELS[illegalReason]}>
          {ILLEGAL_LABELS[illegalReason]}
        </span>
      )}
      {isConsidering && (
        <span className="card-tile__considering-badge" title="Considering for removal">
          Considering
        </span>
      )}
    </button>
  )
}
