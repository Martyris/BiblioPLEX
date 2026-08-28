// Main-process copy of src/renderer/src/cardTagging.ts. The two are kept in sync by hand —
// tsconfig.node.json's `include` doesn't cover src/renderer, so main can't import it directly
// (same "no shared-types package" tradeoff documented in CLAUDE.md for the rest of the app).
// Only the bulk index builder needs this; per-card display/edit still uses the renderer copy.

// Bump whenever a rule in deriveFunctionalTags/deriveKeywordTags actually changes what a card
// gets tagged as (not for comments/refactors) — cardTagIndex.ts stamps every build with this,
// so an index built under an older version is detected as stale and auto-rebuilt once, instead
// of silently keeping wrong tags around until someone remembers to click "Rebuild Index".
export const TAGGING_VERSION = 7

export interface CardTags {
  keywordTags: string[]
  functionalTags: string[]
}

export interface TaggableCard {
  oracle_text?: string
  type_line: string
  keywords?: string[]
  mana_cost?: string
  cmc?: number
  card_faces?: { oracle_text?: string; type_line?: string; mana_cost?: string }[]
}

function combinedOracleText(card: TaggableCard): string {
  if (card.card_faces && card.card_faces.length > 0) {
    return card.card_faces.map((f) => f.oracle_text ?? '').join('\n')
  }
  return card.oracle_text ?? ''
}

function combinedTypeLine(card: TaggableCard): string {
  if (card.card_faces && card.card_faces.length > 0) {
    return card.card_faces.map((f) => f.type_line ?? '').join(' // ')
  }
  return card.type_line
}

// A single ability only needs ONE of its clauses to actually produce mana, not every clause —
// see the renderer copy of this file for the full reasoning (Tagger's "Activated Ability" tag
// is otherwise its single largest, and least useful, one for a deckbuilder).
const MANA_CLAUSE = /^(add\b|choose a color\b|you may reveal\b|spend this mana\b)/i

export function isManaOnlyAbilityLand(card: TaggableCard): boolean {
  if (!combinedTypeLine(card).includes('Land')) return false
  const lines = combinedOracleText(card)
    .split('\n')
    .filter((line) => line.includes(':'))
  if (lines.length === 0) return false
  return lines.every((line) => {
    const effect = line.slice(line.indexOf(':') + 1)
    const clauses = effect
      .split('.')
      .map((c) => c.trim())
      .filter(Boolean)
    return clauses.some((clause) => MANA_CLAUSE.test(clause))
  })
}

// A card's OWN cost, not just text describing other spells' costs — checked separately from
// oracle text so a face with no rules text at all (vanilla X creatures are rare but exist)
// still gets picked up.
function combinedManaCost(card: TaggableCard): string {
  if (card.card_faces && card.card_faces.length > 0) {
    return card.card_faces.map((f) => f.mana_cost ?? '').join(' // ')
  }
  return card.mana_cost ?? ''
}

const PROTECTION_KEYWORDS = ['hexproof', 'shroud', 'indestructible', 'protection from']
const PUMP_KEYWORDS = [
  'double strike',
  'first strike',
  'trample',
  'deathtouch',
  'menace',
  'flying',
  'haste',
  'vigilance',
  'lifelink',
  'reach',
  ...PROTECTION_KEYWORDS
]

const DAMAGE_TO_ANY_OR_CREATURE = /deals? (\d+|x) damage to (any target|target creature)/i
const DAMAGE_TO_PLAYER_ONLY = /deals? (\d+|x) damage to (target player|target opponent|each opponent|you|each player)/i

function deriveFunctionalTags(text: string, typeLine: string, manaCost: string, cmc: number): Set<string> {
  const tags = new Set<string>()
  const isInstantOrSorcery = /\b(instant|sorcery)\b/i.test(typeLine)
  const isNonLandManaPermanent = /\b(artifact|creature|enchantment|planeswalker)\b/i.test(typeLine)

  if (/draws? (a|an|\d+|two|three|four|five|six|seven|another|x|\d*ˣ) cards?/i.test(text)) tags.add('Card Draw')
  if (/put[\s\S]{0,20}of (them|those cards) into your hand/i.test(text)) tags.add('Card Draw')
  if (
    /discards? (a|an|\d+|two|three|four|five|that many|all) cards?/i.test(text) ||
    /discards? this card\b/i.test(text) ||
    /discards? (their|your|his or her) hand/i.test(text)
  ) {
    tags.add('Discard')
  }

  const tutorMatch = /search(es)? your library for[\s\S]{0,60}?\bcard\b/i.test(text)
  if (tutorMatch) tags.add('Tutor')

  const landTutorMatch = text.match(/search(es)? your library for(?: a| an| up to \w+)?([\s\S]{0,30}?)\bcard\b[\s\S]{0,60}battlefield/i)
  if (landTutorMatch && /\b(land|forest|island|mountain|plains|swamp)\b/i.test(landTutorMatch[2])) {
    // A land that sacrifices itself to fetch another land (Evolving Wilds, fetchlands) nets
    // zero extra lands in play — it's fixing colors, not accelerating mana, unlike a spell
    // or nonland permanent putting a bonus land onto the battlefield (e.g. Rampant Growth).
    if (/\bland\b/i.test(typeLine)) tags.add('Fixing')
    else tags.add('Ramp')
  }
  if (/reveal[\s\S]{0,150}land cards?[\s\S]{0,80}battlefield/i.test(text)) tags.add('Ramp')

  const addsMana = /add[s]? (\{[^}]+\}|one mana|two mana|three mana)/i.test(text) || /\{t\}[\s\S]{0,10}:[\s\S]{0,15}add/i.test(text)
  if (addsMana) {
    if (isInstantOrSorcery) tags.add('Ritual')
    else if (isNonLandManaPermanent) tags.add('Ramp')
  }

  const untapMatch = text.match(/untap (target|up to \w+|that|all) (lands?|permanents?|creatures?)/i)
  if (untapMatch) {
    tags.add('Untap')
    const subject = untapMatch[2].toLowerCase()
    const excludesLands = /nonland/i.test(text)
    if (isInstantOrSorcery && (subject.startsWith('land') || (subject.startsWith('permanent') && !excludesLands))) {
      tags.add('Ritual')
    }
  }

  const hitsCreature = DAMAGE_TO_ANY_OR_CREATURE.test(text)
  const hitsPlayerOnly = DAMAGE_TO_PLAYER_ONLY.test(text)
  if (hitsCreature) {
    tags.add('Burn')
    tags.add('Soft Removal')
    const amountMatch = text.match(DAMAGE_TO_ANY_OR_CREATURE)
    const amount = amountMatch ? Number(amountMatch[1]) : NaN
    if (Number.isNaN(amount) || amount <= 3) tags.add('Ping')
  } else if (hitsPlayerOnly) {
    tags.add('Burn')
  }
  const removalMatch = text.match(/(destroy|exile) (x |\d+ )?target (creatures?|permanents?|artifacts?|enchantments?|planeswalkers?)/i)
  if (removalMatch) {
    tags.add('Removal')
    if (/^x /i.test(removalMatch[2] ?? '')) tags.add('Board Wipe')
  }
  if (/target creature gets? -\d+\/-\d+/i.test(text)) tags.add('Soft Removal')
  const bounceMatch = text.match(
    /return (x |\d+ )?target (creatures?|nonland permanents?|permanents?)[\s\S]{0,30}to (its|their) owner'?s hand/i
  )
  if (bounceMatch) {
    tags.add('Soft Removal')
    if (/^x /i.test(bounceMatch[1] ?? '')) tags.add('Board Wipe')
  }
  if (/return each creature[\s\S]{0,60}to (its|their) owner'?s hand/i.test(text)) {
    tags.add('Soft Removal')
    tags.add('Board Wipe')
  }
  const phaseOutMatch = text.match(/target creatures? phases? out/i)
  if (phaseOutMatch) {
    tags.add('Soft Removal')
    tags.add('Protection')
    const nearby = text.slice(Math.max(0, (phaseOutMatch.index ?? 0) - 20), phaseOutMatch.index)
    if (/\b(x|up to)\b/i.test(nearby)) tags.add('Board Wipe')
  }
  if (/destroy all creatures/i.test(text) || /each creature gets? -\d+\/-\d+/i.test(text) || /deals? (\d+|x) damage to each creature/i.test(text)) {
    tags.add('Board Wipe')
    tags.add('Removal')
  }
  if (/fights? target creature/i.test(text)) tags.add('Fight')

  if (/\+1\/\+1 counters?/i.test(text)) {
    tags.add('+1/+1 Counters')
    tags.add('Counters')
  } else if (/(-1\/-1|loyalty|charge|stun|age|ice|shield|oil|energy|experience) counters?/i.test(text)) {
    tags.add('Counters')
  } else if (/\bcounters? target\b/i.test(text)) {
    // "Counter target spell/ability" is the countermagic verb, not a +1/+1-style counter —
    // handled separately below as Counterspell, and must not fall into the generic bucket.
  } else if (/\bcounters?\b/i.test(text)) {
    tags.add('Counters')
  }

  const tokenMatch = text.match(/creates? [\s\S]{0,70}tokens?/i)
  if (tokenMatch) {
    tags.add('Token Creation')
    if (/land creature tokens?/i.test(tokenMatch[0])) tags.add('Ramp')
    if (/treasure tokens?/i.test(tokenMatch[0])) tags.add('Treasure')
  }

  const lordMatch = text.match(/\b([A-Z][a-zA-Z]+) you control get \+\d+\/\+\d+/)
  if (lordMatch && lordMatch[1] !== 'Creatures' && lordMatch[1] !== 'Permanents') {
    tags.add('Lord')
  }

  if (/target creatures? gets? \+\d+\/\+\d+/i.test(text)) tags.add('Pump')
  if (/creatures you control get \+\d+\/\+\d+/i.test(text)) tags.add('Pump')
  if (/doubles? [\s\S]{0,15}(that creature'?s|its|target creature'?s) power/i.test(text)) tags.add('Pump')
  for (const kw of PUMP_KEYWORDS) {
    const grantPattern = new RegExp(`target creature[\\s\\S]{0,15}gains? ${kw}`, 'i')
    if (grantPattern.test(text)) {
      tags.add('Pump')
      if (PROTECTION_KEYWORDS.includes(kw)) tags.add('Protection')
    }
  }

  if (
    /(target permanents?|target creatures?|creatures you control|permanents you control)[\s\S]{0,40}(gains?|have) (hexproof|shroud|indestructible|protection from)/i.test(
      text
    )
  ) {
    tags.add('Protection')
  }
  if (/counters? target [\w\s]{0,25}spell/i.test(text)) {
    tags.add('Counterspell')
    tags.add('Protection')
  }
  const stealMatch = text.match(/gains? control of (x |\d+ )?target/i)
  if (stealMatch) {
    tags.add('Steal')
    if (/^x /i.test(stealMatch[1] ?? '')) tags.add('Board Wipe')
  }

  if (/return target creature card from[\s\S]{0,20}graveyard to the battlefield/i.test(text)) tags.add('Reanimation')
  if (/return (x |\d+ )?target [\s\S]{0,30}cards? from your graveyard to your hand/i.test(text)) tags.add('Recursion')
  if (/shuffle your graveyard into your library/i.test(text)) tags.add('Recursion')
  if (/mills? (a|an|\d+|x) cards?/i.test(text) || /puts? the top \d+ cards? of[\s\S]{0,30}library into[\s\S]{0,20}graveyard/i.test(text)) {
    tags.add('Mill')
  }
  if (/sacrifice (a|an|another)[\s\S]{0,10}(creature|permanent|artifact)/i.test(text)) tags.add('Sacrifice')

  const RESTRICTED_COPY_TYPES = /(creature|artifact|enchantment|planeswalker)/i
  if (
    /cop(y|ies) target (spell|instant|sorcery)/i.test(text) ||
    /creates? (a token|tokens) that('?s| are) (a copy|copies) of/i.test(text) ||
    /\bcopy (it|that spell|this spell|that ability)\b/i.test(text)
  ) {
    tags.add('Copy')
  }
  const copyPermanentMatch = text.match(/cop(?:y|ies)[\s\S]{0,10}?(target|up to \w+) permanents?/i)
  if (copyPermanentMatch) {
    tags.add('Copy')
    const nearby = text.slice(Math.max(0, (copyPermanentMatch.index ?? 0) - 10), (copyPermanentMatch.index ?? 0) + 60)
    if (!RESTRICTED_COPY_TYPES.test(nearby)) tags.add('Ramp')
  }
  const entersAsCopyMatch = text.match(/enters? (the battlefield )?as a copy of/i)
  if (entersAsCopyMatch) {
    tags.add('Clone')
    const nearby = text.slice(entersAsCopyMatch.index ?? 0, (entersAsCopyMatch.index ?? 0) + 80)
    if (/\bpermanent\b/i.test(nearby) && !RESTRICTED_COPY_TYPES.test(nearby)) tags.add('Ramp')
  }
  const tokenCopyPermanentMatch = text.match(/tokens? that('?s| are) (a copy|copies) of (that|the|target) permanents?/i)
  if (tokenCopyPermanentMatch) {
    tags.add('Clone')
    const nearby = text.slice(
      Math.max(0, (tokenCopyPermanentMatch.index ?? 0) - 10),
      (tokenCopyPermanentMatch.index ?? 0) + 60
    )
    if (!RESTRICTED_COPY_TYPES.test(nearby)) tags.add('Ramp')
  }

  const gainsLife = /\bgains? [\s\S]{0,20}\blife\b/i.test(text)
  const opponentLosesLife = /(target player|target opponent|each opponent) loses \d+ life/i.test(text)
  if (gainsLife) tags.add('Life Gain')
  if (gainsLife && opponentLosesLife) tags.add('Drain')

  if (/players? can'?t untap/i.test(text) || /skips? (your|their) untap step/i.test(text)) tags.add('Stax')
  if (/spells? cost \{[^}]+\}[\s\S]{0,15}more to cast/i.test(text) || /activate[\s\S]{0,40}abilities[\s\S]{0,15}cost[\s\S]{0,15}more/i.test(text)) {
    tags.add('Taxing')
  }
  if (/spells you cast cost[\s\S]{0,15}less/i.test(text)) tags.add('Cost Reduction')
  if (/destroy target land/i.test(text) || /sacrifice a land/i.test(text)) tags.add('Land Destruction')

  if (/takes? an extra turn/i.test(text)) tags.add('Extra Turns')

  if (/\b(when|whenever)\b[\s\S]{0,80}\benters\b/i.test(text)) tags.add('ETB')
  if (/whenever you cast/i.test(text)) tags.add('Cast')
  if (/whenever (you|a player|target player|each player)[\s\S]{0,20}draws? (a|an|\d+) cards?/i.test(text)) tags.add('Draw Matters')
  if (/with \{x\}[\s\S]{0,10}in (its|their) mana cost/i.test(text)) tags.add('X Cost Matters')
  if (/(mana cost|activation cost)[\s\S]{0,15}contains? \{x\}/i.test(text)) tags.add('X Cost Matters')
  if (/\{x\}/i.test(manaCost)) tags.add('X Cost Matters')
  if (
    /whenever (a|another)[\s\S]{0,20}creature dies/i.test(text) ||
    /whenever[\s\S]{0,40}is destroyed/i.test(text) ||
    /whenever[\s\S]{0,60}is put into[\s\S]{0,30}graveyard from the battlefield/i.test(text)
  ) {
    tags.add('Death Matters')
  }
  if (
    /whenever[\s\S]{0,40}attacks/i.test(text) ||
    /whenever you attack/i.test(text) ||
    /as long as[\s\S]{0,40}is attacking/i.test(text)
  ) {
    tags.add('Aggro')
  }
  const AGGRO_KEYWORDS = ['haste', 'trample', 'first strike', 'double strike', 'menace']
  if (AGGRO_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`, 'i').test(text))) tags.add('Aggro')
  if (/attacks?[\s\S]{0,50}if able\b/i.test(text)) tags.add('Goad')

  if (/exile[\s\S]{0,120}(then return|return (it|that card|those cards|them)) to the battlefield/i.test(text)) tags.add('Blink')
  if (/prevent(s|ed)? (all|the next \d+|that)[\s\S]{0,60}damage/i.test(text)) tags.add('Fog')
  if (/exile the top card of your library[\s\S]{0,150}you may play (it|that card)/i.test(text)) tags.add('Impulse Draw')
  if (/cast (this|that) spell as though it had flash/i.test(text)) tags.add('Flash')
  if (/twice that many|double the value of|doubles? that many/i.test(text)) tags.add('Double')

  if (/\bequipment\b/i.test(typeLine)) tags.add('Equipment')
  if (/\baura\b/i.test(typeLine)) tags.add('Aura')
  if (/\binstant\b/i.test(typeLine) && (cmc ?? Infinity) <= 2) tags.add('Spellslinger')

  return tags
}

export function deriveCardTags(card: TaggableCard): CardTags {
  const text = combinedOracleText(card)
  const typeLine = combinedTypeLine(card)
  const functionalTags = [...deriveFunctionalTags(text, typeLine, combinedManaCost(card), card.cmc ?? Infinity)].sort()
  const keywordTags = [...(card.keywords ?? [])].sort()
  return { keywordTags, functionalTags }
}
