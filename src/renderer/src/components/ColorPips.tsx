import { manaSymbolUrl } from '../manaSymbol'
import { colorIdentityName } from '../colorIdentityName'

interface Props {
  colors: string[]
  size?: number
  showName?: boolean
}

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G']

export default function ColorPips({ colors, size = 16, showName = false }: Props) {
  const ordered = COLOR_ORDER.filter((c) => colors.includes(c))
  const display = ordered.length > 0 ? ordered : ['C']

  return (
    <span className="color-pips">
      {display.map((c) => (
        <img
          key={c}
          className="color-pip"
          style={{ width: size, height: size }}
          src={manaSymbolUrl(c)}
          alt={c === 'C' ? 'Colorless' : c}
          title={c === 'C' ? 'Colorless' : c}
        />
      ))}
      {showName && <span className="color-pips__name">{colorIdentityName(colors)}</span>}
    </span>
  )
}
