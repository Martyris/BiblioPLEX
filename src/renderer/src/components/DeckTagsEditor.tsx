import { useState } from 'react'
import type { DeckTag, EdhrecTag } from '../types'

interface Props {
  availableTags: EdhrecTag[]
  selected: DeckTag[]
  onSave: (tags: DeckTag[]) => void
  onCancel: () => void
}

export default function DeckTagsEditor({ availableTags, selected, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<Map<string, DeckTag>>(new Map(selected.map((t) => [t.slug, t])))

  function toggle(tag: EdhrecTag): void {
    setDraft((prev) => {
      const next = new Map(prev)
      if (next.has(tag.slug)) next.delete(tag.slug)
      else next.set(tag.slug, { slug: tag.slug, value: tag.value, weight: 3 })
      return next
    })
  }

  function setWeight(slug: string, weight: number): void {
    setDraft((prev) => {
      const existing = prev.get(slug)
      if (!existing) return prev
      const next = new Map(prev)
      next.set(slug, { ...existing, weight })
      return next
    })
  }

  return (
    <div className="tag-editor">
      <p className="app__hint">
        Pick the themes that matter most for this build, and how important each one is. Used to guide
        future recommendation weighting.
      </p>
      <ul className="tag-editor__list">
        {availableTags.map((tag) => {
          const active = draft.get(tag.slug)
          return (
            <li key={tag.slug} className="tag-editor__row">
              <label className="tag-editor__label">
                <input type="checkbox" checked={Boolean(active)} onChange={() => toggle(tag)} />
                {tag.value}
              </label>
              {active && (
                <div className="tag-editor__weight-control">
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={active.weight}
                    onChange={(e) => setWeight(tag.slug, Number(e.target.value))}
                  />
                  <span className="tag-editor__weight-value">{active.weight}</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="tag-editor__actions">
        <button className="back-link" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" onClick={() => onSave([...draft.values()])}>
          Save Tags
        </button>
      </div>
    </div>
  )
}
