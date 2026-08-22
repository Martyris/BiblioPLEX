export interface SortOption {
  order: string
  dir: 'asc' | 'desc'
  label: string
}

export const SORT_OPTIONS: SortOption[] = [
  { order: 'name', dir: 'asc', label: 'Name (A–Z)' },
  { order: 'edhrec', dir: 'asc', label: 'Popularity (EDHREC)' },
  { order: 'released', dir: 'desc', label: 'Release Date (Newest)' },
  { order: 'cmc', dir: 'asc', label: 'Mana Value (Low–High)' },
  { order: 'color', dir: 'asc', label: 'Color (WUBRG)' },
  { order: 'rarity', dir: 'asc', label: 'Rarity (Common–Mythic)' },
  { order: 'usd', dir: 'asc', label: 'Price (Low–High)' },
  { order: 'usd', dir: 'desc', label: 'Price (High–Low)' }
]

interface Props {
  value: SortOption
  onChange: (option: SortOption) => void
}

export default function SortControl({ value, onChange }: Props) {
  const selectedIndex = SORT_OPTIONS.findIndex((o) => o.order === value.order && o.dir === value.dir)

  return (
    <select
      className="filter-select"
      value={selectedIndex}
      onChange={(e) => onChange(SORT_OPTIONS[Number(e.target.value)])}
    >
      {SORT_OPTIONS.map((option, i) => (
        <option key={`${option.order}-${option.dir}`} value={i}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
