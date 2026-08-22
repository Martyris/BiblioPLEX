// Scryfall shards card images under the first two hex characters of the card's id, e.g.
// id "7673784e-..." -> /front/7/6/7673784e-....jpg. EDHREC's card ids ARE Scryfall ids, so
// we can build thumbnail URLs directly without an extra API round-trip per card.
export function scryfallImageUrl(id: string, size: 'small' | 'normal' | 'large' = 'normal'): string {
  return `https://cards.scryfall.io/${size}/front/${id[0]}/${id[1]}/${id}.jpg`
}
