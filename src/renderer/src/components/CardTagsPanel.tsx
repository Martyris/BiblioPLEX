import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScryfallCard } from '../types'
import { deriveCardTags, resolveCardTags, KNOWN_FUNCTIONAL_TAGS } from '../cardTagging'

interface Props {
  card: ScryfallCard
}

export default function CardTagsPanel({ card }: Props) {
  const [override, setOverride] = useState<{ added: string[]; removed: string[] }>({ added: [], removed: [] })
  const [editing, setEditing] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [tagDropdownPos, setTagDropdownPos] = useState<{ x: number; y: number } | null>(null)
  const newTagInputRef = useRef<HTMLInputElement>(null)

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

  // Same "close rather than let it drift" fix as the Card Tags menu — a position:fixed dropdown
  // doesn't track the scrollable panel it opened from (this card's detail view scrolls), so a
  // scroll while it's open would otherwise leave it hovering over the wrong content.
  useEffect(() => {
    if (!tagDropdownPos) return
    function handleScroll(): void {
      setTagDropdownPos(null)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [tagDropdownPos])

  const auto = useMemo(() => deriveCardTags(card), [card])
  const resolvedTags = useMemo(() => resolveCardTags(card, override), [card, override])

  const tagMatches = useMemo(() => {
    const q = newTag.trim().toLowerCase()
    if (!q) return []
    const already = new Set(draftTags.map((t) => t.toLowerCase()))
    return KNOWN_FUNCTIONAL_TAGS.filter((t) => t.toLowerCase().includes(q) && !already.has(t.toLowerCase())).slice(0, 8)
  }, [newTag, draftTags])

  function startEditing(): void {
    setDraftTags(resolvedTags)
    setEditing(true)
  }

  function removeDraftTag(tag: string): void {
    setDraftTags((prev) => prev.filter((t) => t !== tag))
  }

  function addDraftTag(explicitValue?: string): void {
    const t = (explicitValue ?? newTag).trim()
    if (!t) return
    setDraftTags((prev) => (prev.includes(t) ? prev : [...prev, t]))
    setNewTag('')
    setTagDropdownPos(null)
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
              ref={newTagInputRef}
              type="text"
              value={newTag}
              placeholder="Add a tag…"
              onChange={(e) => {
                setNewTag(e.target.value)
                const rect = newTagInputRef.current?.getBoundingClientRect()
                if (rect) setTagDropdownPos({ x: rect.left, y: rect.bottom + 4 })
              }}
              onFocus={() => {
                const rect = newTagInputRef.current?.getBoundingClientRect()
                if (rect) setTagDropdownPos({ x: rect.left, y: rect.bottom + 4 })
              }}
              onBlur={() => {
                // Delay so a click on a dropdown row registers before the row unmounts.
                window.setTimeout(() => setTagDropdownPos(null), 150)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addDraftTag()
                }
                if (e.key === 'Escape') setTagDropdownPos(null)
              }}
            />
            <button type="button" className="secondary-button" onClick={() => addDraftTag()}>
              Add
            </button>
          </div>
          {tagDropdownPos &&
            tagMatches.length > 0 &&
            createPortal(
              <div className="tag-name-dropdown" style={{ top: tagDropdownPos.y, left: tagDropdownPos.x }}>
                {tagMatches.map((tag) => (
                  <button
                    key={tag}
                    className="tag-name-dropdown__item"
                    // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addDraftTag(tag)
                      newTagInputRef.current?.focus()
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>,
              document.body
            )}
          <div className="tag-editor__actions">
            <button className="secondary-button" onClick={() => setEditing(false)}>
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
