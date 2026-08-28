import { useLayoutEffect, useRef, useState } from 'react'

interface Props {
  x: number
  y: number
  onClose: () => void
  actions: { label: string; onSelect: () => void }[]
}

/** A small cursor-positioned menu, opened via right-click on a card tile. Shared by any view
 *  that offers "add to X" shortcuts (EDHREC recommendations, tag search results) so the
 *  positioning/dismiss behavior stays in one place. */
export default function CardContextMenu({ x, y, onClose, actions }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  // Starts at the requested point, then flips up/left post-measure if that would run the menu
  // off the bottom/right edge — e.g. right-clicking a card near the bottom of the window. Runs
  // in a layout effect (before paint) so there's no visible jump from the unflipped position.
  const [pos, setPos] = useState({ top: y, left: x })

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    const top = y + rect.height > window.innerHeight - margin ? Math.max(margin, y - rect.height) : y
    const left = x + rect.width > window.innerWidth - margin ? Math.max(margin, window.innerWidth - rect.width - margin) : x
    setPos({ top, left })
  }, [x, y, actions.length])

  return (
    <>
      <div
        className="tag-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div ref={menuRef} className="context-menu" style={{ top: pos.top, left: pos.left }}>
        {actions.map((action) => (
          <button key={action.label} onClick={action.onSelect}>
            {action.label}
          </button>
        ))}
      </div>
    </>
  )
}
