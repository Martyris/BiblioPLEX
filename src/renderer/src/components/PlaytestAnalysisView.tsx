import { useMemo, useState } from 'react'
import { analyzeSeat, type AnalysisResult, type AnalysisSnapshot, type CardFateKind } from '../playtestAnalysis'
import { cardDataByName, cardImageCache } from '../playtestCardCache'
import BarChart from './BarChart'
import CardTile from './CardTile'

interface SeatInfo {
  engineName: string
  deckName: string
  commanderName: string
  cardNames: string[]
}

interface Props {
  history: AnalysisSnapshot[]
  result: AnalysisResult
  players: SeatInfo[]
  onClose: () => void
  onInspect: (name: string) => void
}

const PROBLEM_FATES: CardFateKind[] = ['discarded-unused', 'dead-in-hand']
const WORKED_FATES: CardFateKind[] = ['cast-survived', 'cast-died', 'cast-resolved']

const FATE_SECTION_LABELS: Record<CardFateKind, string> = {
  'discarded-unused': 'Discarded Without Being Cast',
  'dead-in-hand': 'Never Cast — Sat Dead in Hand',
  'cast-survived': 'Cast — Still Around',
  'cast-died': 'Cast — Died Later',
  'cast-resolved': 'Cast — Resolved Normally'
}

function FateSection({
  fate,
  names,
  onInspect
}: {
  fate: CardFateKind
  names: string[]
  onInspect: (name: string) => void
}) {
  if (names.length === 0) return null
  return (
    <div className="playtest-analysis__fate-group">
      <h4 className="playtest-analysis__fate-heading">
        {FATE_SECTION_LABELS[fate]} <span className="app__hint">({names.length})</span>
      </h4>
      <div className="card-grid card-grid--compact">
        {names.map((name) => {
          const card = cardDataByName.get(name)
          if (!card) return null
          return <CardTile key={name} card={card} onSelect={() => onInspect(name)} />
        })}
      </div>
    </div>
  )
}

export default function PlaytestAnalysisView({ history, result, players, onClose, onInspect }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const winnerIndex = players.findIndex((p) => result.winner.includes(p.engineName))
    return winnerIndex >= 0 ? winnerIndex : 0
  })

  const selected = players[selectedIndex]
  const analysis = useMemo(
    () => (selected ? analyzeSeat(history, result, selected.engineName, selected.cardNames, cardDataByName) : null),
    [history, result, selected]
  )

  const problemFateCounts = useMemo(() => {
    if (!analysis) return 0
    return analysis.cardFates.filter((cf) => PROBLEM_FATES.includes(cf.fate)).length
  }, [analysis])

  return (
    <div className="playtest-analysis-overlay" onClick={onClose}>
      <div className="playtest-analysis-modal" onClick={(e) => e.stopPropagation()}>
        <button className="card-detail__close" onClick={onClose}>
          ×
        </button>
        <h3 className="section-heading" style={{ marginTop: 0 }}>
          Post-Match Analysis
        </h3>

        <div className="playtest-analysis__seat-row">
          {players.map((p, i) => {
            const won = result.winner.includes(p.engineName)
            const card = cardDataByName.get(p.commanderName)
            return (
              <button
                key={p.engineName}
                className={`playtest-deck-button ${i === selectedIndex ? 'playtest-deck-button--chosen' : ''}`}
                onClick={() => setSelectedIndex(i)}
              >
                {card?.image_uris?.small ? (
                  <img src={card.image_uris.small} alt={p.deckName} />
                ) : (
                  <div className="playtest-perm__placeholder">{p.deckName}</div>
                )}
                <span className="playtest-deck-button__name">
                  {p.deckName}
                  {won ? ' 🏆' : ''}
                </span>
              </button>
            )
          })}
        </div>

        {analysis && (
          <>
            <section className="playtest-analysis__section">
              <h3 className="section-heading">Result</h3>
              <p className="app__hint">
                {analysis.won ? 'Won' : 'Did not win'} · {analysis.turns} turns · {(analysis.gameMs / 1000).toFixed(1)}s
                {problemFateCounts > 0 && ` · ${problemFateCounts} card(s) never got used`}
              </p>
            </section>

            {analysis.lifeOverTime.length > 0 && (
              <section className="playtest-analysis__section">
                <h3 className="section-heading">Life Over Time</h3>
                <BarChart orientation="vertical" data={analysis.lifeOverTime.map((p) => ({ label: String(p.turn), value: p.life }))} />
              </section>
            )}

            {analysis.tagRollup.length > 0 && (
              <section className="playtest-analysis__section">
                <h3 className="section-heading">Cast by Card Tag</h3>
                <p className="app__hint">How many cards of each tag actually got cast during the game.</p>
                <BarChart data={analysis.tagRollup.map((r) => ({ label: r.tag, value: r.cast }))} />
              </section>
            )}

            <section className="playtest-analysis__section">
              <h3 className="section-heading">What Didn't Work</h3>
              {problemFateCounts === 0 ? (
                <p className="app__hint">Every drawn card got cast — nothing sat unused.</p>
              ) : (
                PROBLEM_FATES.map((fate) => (
                  <FateSection
                    key={fate}
                    fate={fate}
                    names={analysis.cardFates.filter((cf) => cf.fate === fate).map((cf) => cf.name)}
                    onInspect={onInspect}
                  />
                ))
              )}
            </section>

            <section className="playtest-analysis__section">
              <h3 className="section-heading">What Worked</h3>
              {WORKED_FATES.map((fate) => (
                <FateSection
                  key={fate}
                  fate={fate}
                  names={analysis.cardFates.filter((cf) => cf.fate === fate).map((cf) => cf.name)}
                  onInspect={onInspect}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
