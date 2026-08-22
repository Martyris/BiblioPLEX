export interface BarDatum {
  label: string
  value: number
  color?: string
}

interface Props {
  data: BarDatum[]
  orientation?: 'horizontal' | 'vertical'
  valueFormatter?: (v: number) => string
}

export default function BarChart({ data, orientation = 'horizontal', valueFormatter }: Props) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const format = valueFormatter ?? ((v: number) => String(v))

  if (orientation === 'vertical') {
    return (
      <div className="bar-chart bar-chart--vertical">
        {data.map((d) => (
          <div key={d.label} className="bar-chart__col">
            <span className="bar-chart__value">{d.value > 0 ? format(d.value) : ''}</span>
            <div className="bar-chart__col-track">
              <div
                className="bar-chart__bar"
                style={{ height: `${(d.value / max) * 100}%`, background: d.color ?? 'var(--accent)' }}
              />
            </div>
            <span className="bar-chart__label">{d.label}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="bar-chart bar-chart--horizontal">
      {data.map((d) => (
        <div key={d.label} className="bar-chart__row">
          <span className="bar-chart__label">{d.label}</span>
          <div className="bar-chart__track">
            <div
              className="bar-chart__bar"
              style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? 'var(--accent)' }}
            />
          </div>
          <span className="bar-chart__value">{format(d.value)}</span>
        </div>
      ))}
    </div>
  )
}
