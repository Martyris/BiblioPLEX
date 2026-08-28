export function manaSymbolUrl(symbol: string): string {
  return `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(symbol)}.svg`
}

/** Splits a Scryfall `mana_cost` string ("{1}{R}{R}") into its individual symbol codes
 *  ("1", "R", "R"), each renderable via manaSymbolUrl. */
export function parseManaCostSymbols(manaCost: string): string[] {
  return (manaCost.match(/\{[^}]+\}/g) ?? []).map((s) => s.slice(1, -1))
}
