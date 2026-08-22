import { useState } from 'react'
import { isSpellbookError, type ScryfallCard, type SpellbookComboResult, type SpellbookVariant } from '../types'

interface Props {
  deckCards: ScryfallCard[]
  commanderNames: string[]
}

function VariantCard({ variant, missing }: { variant: SpellbookVariant; missing?: Set<string> }) {
  return (
    <div className="combo-card">
      <div className="combo-card__uses">
        {variant.uses.map((u) => (
          <span key={u.cardName} className={`combo-card__piece ${missing?.has(u.cardName) ? 'is-missing' : ''}`}>
            {u.cardName}
            {u.quantity > 1 ? ` ×${u.quantity}` : ''}
          </span>
        ))}
      </div>
      <p className="combo-card__produces">
        → {variant.produces.map((p) => p.name).join(', ')}
      </p>
      {variant.description && <p className="combo-card__description">{variant.description}</p>}
      <p className="combo-card__prereqs">
        {variant.easyPrerequisites}
        {variant.notablePrerequisites ? ` ${variant.notablePrerequisites}` : ''}
      </p>
    </div>
  )
}

export default function DeckCombosView({ deckCards, commanderNames }: Props) {
  const [result, setResult] = useState<SpellbookComboResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function checkCombos(): Promise<void> {
    setLoading(true)
    setError(null)
    const mainNames = deckCards.map((c) => c.name)
    const response = await window.api.findCombos(mainNames, commanderNames)
    if (isSpellbookError(response)) {
      setError(response.details)
      setResult(null)
    } else {
      setResult(response as SpellbookComboResult)
    }
    setLoading(false)
  }

  const deckNameSet = new Set(deckCards.map((c) => c.name).concat(commanderNames))

  return (
    <>
      <h3 className="section-heading">Combos</h3>
      <p className="app__hint">
        Checks your deck against Commander Spellbook's combo database — a community-maintained list of known EDH
        combos. Not something we can compute ourselves; this queries their public API directly.
      </p>
      <button className="primary-button" onClick={checkCombos} disabled={loading}>
        {loading ? 'Checking…' : 'Check for Combos'}
      </button>

      {error && <p className="deck-score__size-warning">⚠ Couldn't reach Commander Spellbook: {error}</p>}

      {result && (
        <>
          <h3 className="section-heading">
            Combos In Your Deck ({result.included.length})
          </h3>
          {result.included.length === 0 && <p className="app__hint">No fully-assembled combos found.</p>}
          <div className="combo-grid">
            {result.included.map((v) => (
              <VariantCard key={v.id} variant={v} />
            ))}
          </div>

          <h3 className="section-heading">
            One Card Away ({result.almostIncluded.length})
          </h3>
          <p className="app__hint">Combos where you're missing exactly one or more of the pieces (shown in red).</p>
          {result.almostIncluded.length === 0 && <p className="app__hint">Nothing close to completion.</p>}
          <div className="combo-grid">
            {result.almostIncluded.map((v) => {
              const missing = new Set(v.uses.map((u) => u.cardName).filter((name) => !deckNameSet.has(name)))
              return <VariantCard key={v.id} variant={v} missing={missing} />
            })}
          </div>
        </>
      )}
    </>
  )
}
