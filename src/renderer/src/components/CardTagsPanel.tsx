import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScryfallCard } from '../types'
import { deriveCardTags, KNOWN_FUNCTIONAL_TAGS, resolveDetailedCardTags, type ResolvedTag, type TaggerCardData } from '../cardTagging'

interface Props {
  card: ScryfallCard
  // All three present together only inside a deck-editing context (see CardDetail's DeckMode) —
  // a card viewed outside any specific deck (Search, Sets, Commander, Precons) has nowhere to
  // scope a tag addition to, so this panel falls back to the older global-override editor below.
  userTags?: string[]
  onAddUserTag?: (tag: string) => void
  onRemoveUserTag?: (tag: string) => void
  // Jump to Tag Search for a clicked tag — omitted wherever the caller has no such view.
  onTagClick?: (tag: string) => void
}

export default function CardTagsPanel({ card, userTags, onAddUserTag, onRemoveUserTag, onTagClick }: Props) {
  const isDeckScoped = onAddUserTag !== undefined && onRemoveUserTag !== undefined

  const [taggerData, setTaggerData] = useState<TaggerCardData | undefined>(undefined)
  const [override, setOverride] = useState<{ added: string[]; removed: string[] }>({ added: [], removed: [] })
  const [editing, setEditing] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [tagDropdownPos, setTagDropdownPos] = useState<{ x: number; y: number } | null>(null)
  const [taggerVocabulary, setTaggerVocabulary] = useState<string[]>([])
  const newTagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setEditing(false)
    window.api.getTaggerDataBatch([card.oracle_id]).then((map) => {
      if (!cancelled) setTaggerData(map[card.oracle_id])
    })
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
  const resolvedTags = useMemo<ResolvedTag[]>(
    () => resolveDetailedCardTags(card, override, taggerData, userTags),
    [card, override, taggerData, userTags]
  )

  // Deck-scoped: only the real Tagger vocabulary is offered (per-deck tags can't be free text).
  // Non-deck-scoped: the old regex system's own known vocabulary, same as before.
  const tagMatches = useMemo(() => {
    const q = newTag.trim().toLowerCase()
    if (!q) return []
    const already = new Set(draftTags.map((t) => t.toLowerCase()))
    const vocabulary = isDeckScoped ? taggerVocabulary : KNOWN_FUNCTIONAL_TAGS
    return vocabulary.filter((t) => t.toLowerCase().includes(q) && !already.has(t.toLowerCase())).slice(0, 8)
  }, [newTag, draftTags, isDeckScoped, taggerVocabulary])

  function startEditing(): void {
    if (isDeckScoped) {
      setDraftTags(userTags ?? [])
      if (taggerVocabulary.length === 0) {
        window.api
          .getAllTaggerTags()
          .then((tags: { slug: string; label: string }[]) => setTaggerVocabulary([...new Set(tags.map((t) => t.label))].sort()))
      }
    } else {
      setDraftTags(resolvedTags.map((t) => t.label))
    }
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
    if (isDeckScoped) {
      const before = new Set(userTags ?? [])
      const after = new Set(draftTags)
      for (const tag of after) if (!before.has(tag)) onAddUserTag!(tag)
      for (const tag of before) if (!after.has(tag)) onRemoveUserTag!(tag)
    } else {
      const autoSet = new Set([...auto.keywordTags, ...auto.functionalTags])
      const finalSet = new Set(draftTags)
      const added = [...finalSet].filter((t) => !autoSet.has(t))
      const removed = [...autoSet].filter((t) => !finalSet.has(t))
      const next = { added, removed }
      await window.api.setCardTagOverride(card.oracle_id, next)
      setOverride(next)
    }
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
          {isDeckScoped && (
            <p className="app__hint">
              Only tags you add here can be removed again — this deck's own take on what this card does, on top of
              its regular tags.
            </p>
          )}
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
                  // Deck-scoped tags must come from the dropdown (real Tagger vocabulary only),
                  // not typed free text — Enter only commits an exact vocabulary match.
                  if (!isDeckScoped) addDraftTag()
                  else if (tagMatches.length > 0) addDraftTag(tagMatches[0])
                }
                if (e.key === 'Escape') setTagDropdownPos(null)
              }}
            />
            {!isDeckScoped && (
              <button type="button" className="secondary-button" onClick={() => addDraftTag()}>
                Add
              </button>
            )}
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
            {resolvedTags.map(({ label, isUserAdded }) =>
              onTagClick ? (
                <li key={label}>
                  <button
                    type="button"
                    className={`tag-chip tag-chip--clickable ${isUserAdded ? 'is-user-added' : ''}`}
                    onClick={() => onTagClick(label)}
                    title={isUserAdded ? 'Added for this deck' : undefined}
                  >
                    {label}
                    {isUserAdded && <span className="card-tags__user-badge">deck</span>}
                  </button>
                </li>
              ) : (
                <li key={label} className={`tag-chip ${isUserAdded ? 'is-user-added' : ''}`} title={isUserAdded ? 'Added for this deck' : undefined}>
                  {label}
                  {isUserAdded && <span className="card-tags__user-badge">deck</span>}
                </li>
              )
            )}
          </ul>
          <button type="button" className="back-link" onClick={startEditing}>
            {isDeckScoped ? 'Add a Tag for This Deck' : 'Edit Tags'}
          </button>
        </>
      )}
    </div>
  )
}
