import { EMPTY_FILTERS, type ColorCode, type ColorMode, type FilterState } from '../queryBuilder'

interface Props {
  filters: FilterState
  onChange: (filters: FilterState) => void
}

const COLORS: { code: ColorCode; label: string }[] = [
  { code: 'W', label: 'White' },
  { code: 'U', label: 'Blue' },
  { code: 'B', label: 'Black' },
  { code: 'R', label: 'Red' },
  { code: 'G', label: 'Green' },
  { code: 'C', label: 'Colorless' }
]

const RARITIES = ['common', 'uncommon', 'rare', 'mythic']

// Paper-legal formats only — this app targets the physical TCG, so Arena-only formats
// (Alchemy, Historic, Timeless, Explorer, Gladiator, Standard Brawl) are excluded.
const FORMATS = ['', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper']

export default function FilterPanel({ filters, onChange }: Props) {
  function toggleColor(code: ColorCode): void {
    const colors = filters.colors.includes(code)
      ? filters.colors.filter((c) => c !== code)
      : [...filters.colors, code]
    onChange({ ...filters, colors })
  }

  function toggleRarity(rarity: string): void {
    const rarities = filters.rarities.includes(rarity)
      ? filters.rarities.filter((r) => r !== rarity)
      : [...filters.rarities, rarity]
    onChange({ ...filters, rarities })
  }

  const isActive =
    filters.colors.length > 0 ||
    filters.rarities.length > 0 ||
    filters.cmcMin ||
    filters.cmcMax ||
    filters.types ||
    filters.format

  return (
    <div className="filter-panel">
      <div className="filter-group">
        <span className="filter-group__label">Color</span>
        <div className="filter-chip-row">
          {COLORS.map(({ code, label }) => (
            <button
              key={code}
              className={`filter-chip filter-chip--${code} ${filters.colors.includes(code) ? 'is-active' : ''}`}
              onClick={() => toggleColor(code)}
              title={label}
            >
              {code}
            </button>
          ))}
        </div>
        <select
          className="filter-select filter-select--compact"
          value={filters.colorMode}
          onChange={(e) => onChange({ ...filters, colorMode: e.target.value as ColorMode })}
        >
          <option value="atLeast">Includes</option>
          <option value="exactly">Exactly</option>
        </select>
      </div>

      <div className="filter-group">
        <span className="filter-group__label">Mana Value</span>
        <div className="filter-range">
          <input
            type="number"
            min={0}
            placeholder="Min"
            value={filters.cmcMin}
            onChange={(e) => onChange({ ...filters, cmcMin: e.target.value })}
          />
          <span>–</span>
          <input
            type="number"
            min={0}
            placeholder="Max"
            value={filters.cmcMax}
            onChange={(e) => onChange({ ...filters, cmcMax: e.target.value })}
          />
        </div>
      </div>

      <div className="filter-group">
        <span className="filter-group__label">Type</span>
        <input
          type="text"
          className="filter-text"
          placeholder="e.g. creature dragon"
          value={filters.types}
          onChange={(e) => onChange({ ...filters, types: e.target.value })}
        />
      </div>

      <div className="filter-group">
        <span className="filter-group__label">Rarity</span>
        <div className="filter-chip-row">
          {RARITIES.map((r) => (
            <button
              key={r}
              className={`filter-chip ${filters.rarities.includes(r) ? 'is-active' : ''}`}
              onClick={() => toggleRarity(r)}
            >
              {r[0].toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-group">
        <span className="filter-group__label">Legal in</span>
        <select
          className="filter-select"
          value={filters.format}
          onChange={(e) => onChange({ ...filters, format: e.target.value })}
        >
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {f ? f[0].toUpperCase() + f.slice(1) : 'Any format'}
            </option>
          ))}
        </select>
      </div>

      {isActive && (
        <button className="filter-clear" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  )
}
