import { useEffect, useRef, useState } from 'react'
import type { ScryfallCard } from '../types'
import { getSetIconMap } from '../setIcons'

interface Props {
  printings: ScryfallCard[]
  activeId: string
  onChange: (id: string) => void
}

function printingLabel(p: ScryfallCard): string {
  const isAltArt = p.full_art || p.promo || p.variation || p.border_color === 'borderless'
  return `${p.set_name} · #${p.collector_number} · ${p.released_at}${isAltArt ? ' (alt art)' : ''}`
}

export default function PrintingSelect({ printings, activeId, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [iconMap, setIconMap] = useState<Record<string, string>>({})
  const [filterText, setFilterText] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getSetIconMap().then(setIconMap)
  }, [])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const active = printings.find((p) => p.id === activeId) ?? printings[0]
  const filter = filterText.trim().toLowerCase()
  // Matches by set name ("Hour of Devastation"), set code ("hou"), or release year/date
  // ("2017" or "2017-07-14") — whatever the user starts typing.
  const filteredPrintings = filter
    ? printings.filter(
        (p) =>
          p.set_name.toLowerCase().includes(filter) ||
          p.set.toLowerCase().includes(filter) ||
          p.released_at.includes(filter)
      )
    : printings

  return (
    <div className="printing-select" ref={rootRef}>
      <button
        className="printing-select__toggle"
        onClick={() => {
          setOpen((o) => !o)
          setFilterText('')
        }}
      >
        {active && iconMap[active.set] && (
          <img className="printing-select__icon" src={iconMap[active.set]} alt="" />
        )}
        <span className="printing-select__label">{active ? printingLabel(active) : ''}</span>
        <span className="printing-select__caret">▾</span>
      </button>
      {open && (
        <div className="printing-select__grid-wrap">
          <input
            className="printing-select__filter"
            type="text"
            placeholder="Filter by set name, code, or year…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            autoFocus
          />
          <div className="printing-select__grid">
            {filteredPrintings.length === 0 && (
              <p className="printing-select__grid-empty">No printings match "{filterText}".</p>
            )}
            {filteredPrintings.map((p) => (
              <button
                key={p.id}
                className={`printing-select__grid-item ${p.id === activeId ? 'is-active' : ''}`}
                title={printingLabel(p)}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
              >
                {(p.image_uris?.small ?? p.card_faces?.[0]?.image_uris?.small) && (
                  <img
                    src={p.image_uris?.small ?? p.card_faces?.[0]?.image_uris?.small}
                    alt={printingLabel(p)}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                {iconMap[p.set] && (
                  <span className="printing-select__grid-caption">
                    <img
                      className="printing-select__icon"
                      src={iconMap[p.set]}
                      alt={p.set}
                      loading="lazy"
                      decoding="async"
                    />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
