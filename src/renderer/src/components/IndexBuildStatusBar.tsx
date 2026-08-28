import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  cancelCardTagBuild,
  cancelComboBuild,
  getIndexBuildSnapshot,
  subscribeToIndexBuilds
} from '../indexBuildStore'
import type { CardTagBuildProgress, ComboBuildProgress } from '../indexBuildStore'

function cardTagLabel(progress: CardTagBuildProgress): string {
  if (progress.phase === 'fetching') return 'Downloading Scryfall card database…'
  if (progress.phase === 'tagging' && progress.total > 0) {
    return `Tagging cards… (${progress.current.toLocaleString()} / ${progress.total.toLocaleString()})`
  }
  return 'Building Card Tag Index…'
}

function comboLabel(progress: ComboBuildProgress): string {
  if (progress.phase === 'rate-limited') {
    return `Commander Spellbook is rate-limiting us — waiting before resuming (${progress.current} pages so far)…`
  }
  return `Crawling Commander Spellbook for combos… (${progress.current} pages so far)`
}

interface RowProps {
  label: string
  // Known progress (0-1) renders a filled bar; omit for an indeterminate/striped one when
  // there's no meaningful total to show yet (e.g. still downloading, or the combo crawl, which
  // never learns its total page count until the very last page).
  fraction?: number
  onCancel: () => void
}

function BuildRow({ label, fraction, onCancel }: RowProps) {
  return (
    <div className="index-build-bar__row">
      <span className="index-build-bar__label">{label}</span>
      <div className="index-build-bar__track">
        <div
          className={fraction === undefined ? 'index-build-bar__fill is-indeterminate' : 'index-build-bar__fill'}
          style={fraction === undefined ? undefined : { width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <button
        type="button"
        className="index-build-bar__cancel"
        onClick={onCancel}
        aria-label={`Cancel ${label}`}
        title="Cancel"
      >
        ×
      </button>
    </div>
  )
}

/** Mounted once at the top level of App.tsx, outside the tab content — so a build started from
 *  Tag Search view keeps showing progress (and stays cancellable) no matter which tab the user
 *  navigates to afterward. Renders nothing while idle; disappears the moment a build finishes,
 *  errors, or is cancelled. */
export default function IndexBuildStatusBar() {
  const state = useSyncExternalStore(subscribeToIndexBuilds, getIndexBuildSnapshot)
  const { cardTag, combo } = state

  if (!cardTag.building && !combo.building) return null

  return createPortal(
    <div className="index-build-bar">
      {cardTag.building && (
        <BuildRow
          label={cardTagLabel(cardTag.progress)}
          fraction={
            cardTag.progress.phase === 'tagging' && cardTag.progress.total > 0
              ? cardTag.progress.current / cardTag.progress.total
              : undefined
          }
          onCancel={cancelCardTagBuild}
        />
      )}
      {combo.building && (
        <BuildRow label={comboLabel(combo.progress)} fraction={undefined} onCancel={cancelComboBuild} />
      )}
    </div>,
    document.body
  )
}
