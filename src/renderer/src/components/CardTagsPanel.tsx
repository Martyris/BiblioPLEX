import { useEffect, useMemo, useState } from 'react'
import type { ScryfallCard } from '../types'
import { deriveCardTags, resolveCardTags } from '../cardTagging'

interface Props {
  card: ScryfallCard
}

export default function CardTagsPanel({ card }: Props) {
  const [override, setOverride] = useState<{ added: string[]; removed: string[] }>({ added: [], removed: [] })
  const [editing, setEditing] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')

  useEffect(() => {
    let cancelled = false
    setEditing(false)
    window.api.getCardTagOverride(card.oracle_id).then((o) => {
      if (!cancelled) setOverride(o)
    })
    return () => {
      cancelled = true
    }
  }, [card.oracle_id])

  const auto = useMemo(() => deriveCardTags(card), [card])
  const resolvedTags = useMemo(() => resolveCardTags(card, override), [card, override])

  function startEditing(): void {
    setDraftTags(resolvedTags)
    setEditing(true)
  }

  function removeDraftTag(tag: string): void {
    setDraftTags((prev) => prev.filter((t) => t !== tag))
  }

  function addDraftTag(): void {
    const t = newTag.trim()
    if (!t) return
    setDraftTags((prev) => (prev.includes(t) ? prev : [...prev, t]))
    setNewTag('')
  }

  async function saveEditing(): Promise<void> {
    const autoSet = new Set([...auto.keywordTags, ...auto.functionalTags])
    const finalSet = new Set(draftTags)
    const added = [...finalSet].filter((t) => !autoSet.has(t))
    const removed = [...autoSet].filter((t) => !finalSet.has(t))
    const next = { added, removed }
    await window.api.setCardTagOverride(card.oracle_id, next)
    setOverride(next)
    setEditing(false)
  }

  return (
    <div className="card-tags">
      <h3>Tags</h3>
      {editing ? (
        <>
          <ul className="tag-row card-tags__draft-row">
            {draftTags.map((tag) => (
              <li key={tag} className="tag-chip is-active card-tags__chip">
                {tag}
                <button
                  type="button"
                  className="card-tags__chip-remove"
                  onClick={() => removeDraftTag(tag)}
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="card-tags__add-row">
            <input
              type="text"
              value={newTag}
              placeholder="Add a tag…"
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addDraftTag()
                }
              }}
            />
            <button type="button" className="back-link" onClick={addDraftTag}>
              Add
            </button>
          </div>
          <div className="tag-editor__actions">
            <button className="back-link" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary-button" onClick={saveEditing}>
              Save Tags
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="tag-row">
            {resolvedTags.length === 0 && <li className="card-tags__empty">No tags yet</li>}
            {resolvedTags.map((tag) => (
              <li key={tag} className="tag-chip">
                {tag}
              </li>
            ))}
          </ul>
          <button type="button" className="back-link" onClick={startEditing}>
            Edit Tags
          </button>
        </>
      )}
    </div>
  )
}
