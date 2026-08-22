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
      <div className="context-menu" style={{ top: y, left: x }}>
        {actions.map((action) => (
          <button key={action.label} onClick={action.onSelect}>
            {action.label}
          </button>
        ))}
      </div>
    </>
  )
}
