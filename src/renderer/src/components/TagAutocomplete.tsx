import { useState } from 'react'

interface Props {
  availableTags: string[]
  excludeTags: string[]
  onAdd: (tag: string) => void
  placeholder?: string
}

const MAX_SUGGESTIONS = 8

export default function TagAutocomplete({ availableTags, excludeTags, onAdd, placeholder }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)

  const excludeSet = new Set(excludeTags)
  const trimmed = query.trim().toLowerCase()
  const suggestions = trimmed
    ? availableTags.filter((t) => !excludeSet.has(t) && t.toLowerCase().includes(trimmed)).slice(0, MAX_SUGGESTIONS)
    : []

  function selectTag(tag: string): void {
    onAdd(tag)
    setQuery('')
    setOpen(false)
    setHighlightIndex(0)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions[highlightIndex]) selectTag(suggestions[highlightIndex])
      else if (query.trim()) selectTag(query.trim())
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="tag-autocomplete">
      <input
        type="text"
        className="app__search tag-autocomplete__input"
        value={query}
        placeholder={placeholder ?? 'Add a tag…'}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setHighlightIndex(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
      />
      {open && suggestions.length > 0 && (
        <ul className="tag-autocomplete__menu">
          {suggestions.map((tag, i) => (
            <li key={tag}>
              <button
                type="button"
                className={i === highlightIndex ? 'is-active' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectTag(tag)}
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
