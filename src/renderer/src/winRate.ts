export function winRate(wins: number, losses: number): number | null {
  const total = wins + losses
  if (total === 0) return null
  return wins / total
}

/** Green when winning consistently, red when losing consistently, yellow near 50/50. */
export function winRateColor(rate: number | null): string {
  if (rate === null) return 'var(--muted)'
  if (rate >= 0.6) return '#7ee787'
  if (rate >= 0.4) return '#e3c14d'
  return '#f38a8a'
}
