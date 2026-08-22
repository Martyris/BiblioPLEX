import type { Bracket } from './types'

// Casual (1, Exhibition) to most competitive (5, cEDH) — green to red, like a threat scale.
const BRACKET_COLORS: Record<Bracket, string> = {
  1: '#7ee787',
  2: '#b5d96a',
  3: '#e3c14d',
  4: '#f0954d',
  5: '#f3608a'
}

export function bracketColor(bracket: Bracket): string {
  return BRACKET_COLORS[bracket]
}
