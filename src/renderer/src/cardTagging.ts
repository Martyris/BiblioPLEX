import type { ScryfallCard } from './types'

export interface CardTags {
  keywordTags: string[]
  functionalTags: string[]
}

export interface CardTagOverride {
  added: string[]
  removed: string[]
}

interface TaggableCard {
  oracle_text?: string
  type_line: string
  keywords: string[]
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

/** Damage that can land on a creature (any target, or explicitly target creature) is
 *  conditionally removal — whether it kills depends on the target. Damage that can only
 *  ever hit players (Guttersnipe's "each opponent") never earns Soft Removal/Ping, only
 *  Burn — this is what separates the two in community usage. */
const DAMAGE_TO_ANY_OR_CREATURE = /deals? (\d+|x) damage to (any target|target creature)/i
const DAMAGE_TO_PLAYER_ONLY = /deals? (\d+|x) damage to (target player|target opponent|each opponent|you|each player)/i

function deriveFunctionalTags(text: string, typeLine: string, manaCost: string, cmc: number): Set<string> {
  const tags = new Set<string>()
  const isInstantOrSorcery = /\b(instant|sorcery)\b/i.test(typeLine)
  // Deliberately excludes "land" — a land tapping for mana via your normal land drop isn't
  // ramping, it's just being a land. Ramp is mana beyond that (rocks, dorks, or a land that
  // reaches the battlefield without using the land drop — handled separately above).
  const isNonLandManaPermanent = /\b(artifact|creature|enchantment|planeswalker)\b/i.test(typeLine)

  // --- Card advantage ---
  // \d*ˣ catches Scryfall's superscript-X rendering for doubling text (e.g. Mathemagics'
  // "draws 2ˣ cards") — a literal "x" as its own word never appears in that phrasing.
  if (/draws? (a|an|\d+|two|three|four|five|six|seven|another|x|\d*ˣ) cards?/i.test(text)) tags.add('Card Draw')
  // "Look at/reveal the top X cards ... put [some] of them into your hand" nets extra cards
  // into hand exactly like drawing does, just without ever using the word "draw".
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

  // --- Mana ---
  // Land-tutor-to-battlefield effects usually name a specific basic land type ("a Forest
  // card") rather than literally saying "land card" — check the descriptor between "for a"
  // and "card" for any land-related word instead of requiring the literal word "land".
  const landTutorMatch = text.match(/search(es)? your library for(?: a| an| up to \w+)?([\s\S]{0,30}?)\bcard\b[\s\S]{0,60}battlefield/i)
  if (landTutorMatch && /\b(land|forest|island|mountain|plains|swamp)\b/i.test(landTutorMatch[2])) {
    // A land that sacrifices itself to fetch another land (Evolving Wilds, fetchlands) nets
    // zero extra lands in play — it's fixing colors, not accelerating mana, unlike a spell
    // or nonland permanent putting a bonus land onto the battlefield (e.g. Rampant Growth).
    if (/\bland\b/i.test(typeLine)) tags.add('Fixing')
    else tags.add('Ramp')
  }
  // Reveal-based (not search-based) land ramp — "reveal cards until you find X lands, put them
  // onto the battlefield" doesn't say "search" at all, so the tutor-pattern check above never
  // catches it.
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

  // --- Damage / removal ---
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
  // "X target creatures" (an X-spell's usual phrasing) inserts X and pluralizes the noun where
  // a fixed-cost card would just say "target creature" — every regex below that targets
  // creatures/permanents needs to tolerate both, which is exactly what a deck full of X spells
  // exposed that a deck without them wouldn't have.
  const removalMatch = text.match(/(destroy|exile) (x |\d+ )?target (creatures?|permanents?|artifacts?|enchantments?|planeswalkers?)/i)
  if (removalMatch) {
    tags.add('Removal')
    // Removal for a variable "X target creatures" can hit the whole board depending on what X
    // is cast for — same reasoning as the flat "destroy all creatures" Board Wipe case below.
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
  // Mass bounce ("return each creature ... to hand") is a board wipe just like mass destroy —
  // temporary rather than permanent, but it clears the board all the same.
  if (/return each creature[\s\S]{0,60}to (its|their) owner'?s hand/i.test(text)) {
    tags.add('Soft Removal')
    tags.add('Board Wipe')
  }
  // Phasing a creature out functions as both temporary removal (it can't block/attack/be
  // targeted) and protection (it dodges removal/combat damage) depending on whose creature it
  // targets — an X-spell version that can hit an unbounded number of creatures reaches Board
  // Wipe scale too.
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

  // --- Counters ---
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

  // --- Board / tribal ---
  // 70 chars, not 40 — a token's full description (color, size, subtype, keywords) routinely
  // runs longer than 40 chars between "create" and "token(s)" (e.g. Hangarback Walker's "a
  // 1/1 colorless Thopter artifact creature token with flying").
  const tokenMatch = text.match(/creates? [\s\S]{0,70}tokens?/i)
  if (tokenMatch) {
    tags.add('Token Creation')
    // A land creature token is a land — creating one is ramp, same as putting any other land
    // onto the battlefield.
    if (/land creature tokens?/i.test(tokenMatch[0])) tags.add('Ramp')
    // Its own tag rather than folding into Ramp — a Treasure is a one-shot, sac-to-crack mana
    // source (delayed/soft ramp), not the same shape as a permanent mana rock or extra land.
    if (/treasure tokens?/i.test(tokenMatch[0])) tags.add('Treasure')
  }

  const lordMatch = text.match(/\b([A-Z][a-zA-Z]+) you control get \+\d+\/\+\d+/)
  if (lordMatch && lordMatch[1] !== 'Creatures' && lordMatch[1] !== 'Permanents') {
    tags.add('Lord')
  }

  // --- Pump (broad creature-buffing, distinct from tribal-specific Lord) ---
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

  // --- Protection / control ---
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
    // Same reasoning as the Removal/bounce/phase-out Board Wipe hooks above — an X-spell that
    // can steal an unbounded number of creatures repurposes the whole board rather than just
    // one threat, which is Board Wipe scale even though nothing is destroyed.
    if (/^x /i.test(stealMatch[1] ?? '')) tags.add('Board Wipe')
  }

  // --- Graveyard ---
  if (/return target creature card from[\s\S]{0,20}graveyard to the battlefield/i.test(text)) tags.add('Reanimation')
  if (/return (x |\d+ )?target [\s\S]{0,30}cards? from your graveyard to your hand/i.test(text)) tags.add('Recursion')
  // Shuffling the graveyard back into the library isn't a return to hand/battlefield, but it's
  // still graveyard recycling — those cards are back in the deck to be drawn again.
  if (/shuffle your graveyard into your library/i.test(text)) tags.add('Recursion')
  if (/mills? (a|an|\d+|x) cards?/i.test(text) || /puts? the top \d+ cards? of[\s\S]{0,30}library into[\s\S]{0,20}graveyard/i.test(text)) {
    tags.add('Mill')
  }
  if (/sacrifice (a|an|another)[\s\S]{0,10}(creature|permanent|artifact)/i.test(text)) tags.add('Sacrifice')

  // --- Copy / Clone / Ramp overlap ---
  // Only an unrestricted "permanent" target can possibly be a land — anything narrowed to a
  // specific card type (creature, artifact, enchantment, planeswalker) cannot, regardless of
  // "nonland" wording being present.
  const RESTRICTED_COPY_TYPES = /(creature|artifact|enchantment|planeswalker)/i
  if (
    /cop(y|ies) target (spell|instant|sorcery)/i.test(text) ||
    // Singular ("a token that's a copy of") and plural ("tokens that are copies of", from an
    // X-spell copying X things at once) are both real phrasings — Doppelgang uses the plural.
    /creates? (a token|tokens) that('?s| are) (a copy|copies) of/i.test(text) ||
    // "You may copy it"/"copy that spell/ability" (Owlin Spiralmancer, Unbound Flourishing)
    // refers back to the spell/ability just cast/activated rather than naming a target.
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
  // A token that's a copy of a permanent is functionally the same as Clone's "enters as a
  // copy" — same result (an extra copy on the battlefield), different wording. If what's being
  // copied is an unrestricted "permanent" it can be a land, same Ramp reasoning as above.
  const tokenCopyPermanentMatch = text.match(/tokens? that('?s| are) (a copy|copies) of (that|the|target) permanents?/i)
  if (tokenCopyPermanentMatch) {
    tags.add('Clone')
    const nearby = text.slice(
      Math.max(0, (tokenCopyPermanentMatch.index ?? 0) - 10),
      (tokenCopyPermanentMatch.index ?? 0) + 60
    )
    if (!RESTRICTED_COPY_TYPES.test(nearby)) tags.add('Ramp')
  }

  // --- Life ---
  // No "you" requirement immediately before "gain" — a card with two coordinated verbs off one
  // shared subject ("you draw a card and gain half X life") never repeats "you" before "gain",
  // and "gain half X life" itself (vs. a flat "\d+ life") needs a wide gap to match at all.
  const gainsLife = /\bgains? [\s\S]{0,20}\blife\b/i.test(text)
  const opponentLosesLife = /(target player|target opponent|each opponent) loses \d+ life/i.test(text)
  if (gainsLife) tags.add('Life Gain')
  if (gainsLife && opponentLosesLife) tags.add('Drain')

  // --- Stax / cost ---
  if (/players? can'?t untap/i.test(text) || /skips? (your|their) untap step/i.test(text)) tags.add('Stax')
  if (/spells? cost \{[^}]+\}[\s\S]{0,15}more to cast/i.test(text) || /activate[\s\S]{0,40}abilities[\s\S]{0,15}cost[\s\S]{0,15}more/i.test(text)) {
    tags.add('Taxing')
  }
  if (/spells you cast cost[\s\S]{0,15}less/i.test(text)) tags.add('Cost Reduction')
  if (/destroy target land/i.test(text) || /sacrifice a land/i.test(text)) tags.add('Land Destruction')

  // --- Extra turns ---
  if (/takes? an extra turn/i.test(text)) tags.add('Extra Turns')

  // --- Triggers ---
  if (/\b(when|whenever)\b[\s\S]{0,80}\benters\b/i.test(text)) tags.add('ETB')
  if (/whenever you cast/i.test(text)) tags.add('Cast')
  if (/whenever (you|a player|target player|each player)[\s\S]{0,20}draws? (a|an|\d+) cards?/i.test(text)) tags.add('Draw Matters')
  if (/with \{x\}[\s\S]{0,10}in (its|their) mana cost/i.test(text)) tags.add('X Cost Matters')
  // "a mana/activation cost that contains {X}" (Unbound Flourishing) is the same idea worded
  // differently from "with {X} in its mana cost".
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
  // Renamed from "Aggression" and broadened: a creature that HAS or GRANTS an aggressive
  // combat keyword (Goldvein Hydra's own haste/trample, Nev's "creatures ~ have trample")
  // pushes the same attack-sooner/attack-harder game plan as a literal attack trigger, even
  // with no such trigger in its text.
  const AGGRO_KEYWORDS = ['haste', 'trample', 'first strike', 'double strike', 'menace']
  if (AGGRO_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`, 'i').test(text))) tags.add('Aggro')
  // Goad: "[a creature] attacks ... if able" — the reminder text usually specifies "attacks
  // each combat if able and attacks a player other than [x] if able", but the trigger word
  // that actually identifies the effect is "if able" following "attacks".
  if (/attacks?[\s\S]{0,50}if able\b/i.test(text)) tags.add('Goad')

  // --- Blink / Fog / Impulse ---
  if (/exile[\s\S]{0,120}(then return|return (it|that card|those cards|them)) to the battlefield/i.test(text)) tags.add('Blink')
  if (/prevent(s|ed)? (all|the next \d+|that)[\s\S]{0,60}damage/i.test(text)) tags.add('Fog')
  if (/exile the top card of your library[\s\S]{0,150}you may play (it|that card)/i.test(text)) tags.add('Impulse Draw')
  // A card that lets itself be cast at instant speed under some condition (Silver Scrutiny's
  // "as though it had flash if X is 3 or less") never has the actual Flash keyword ability, so
  // it never shows up in Scryfall's keywords array — this is the only way it gets tagged.
  if (/cast (this|that) spell as though it had flash/i.test(text)) tags.add('Flash')
  // Doubling text ("twice that many +1/+1 counters", "double the value of X") is its own
  // distinct payoff pattern, worth its own tag independent of whatever it's doubling.
  if (/twice that many|double the value of|doubles? that many/i.test(text)) tags.add('Double')

  // --- Type-based ---
  if (/\bequipment\b/i.test(typeLine)) tags.add('Equipment')
  if (/\baura\b/i.test(typeLine)) tags.add('Aura')
  // A cheap instant is the kind of spell a "cast lots of spells cheaply" deck actually wants
  // to chain — cmc <= 2 is the "low cost" cutoff; adjust here if 2 reads too tight or too loose.
  if (/\binstant\b/i.test(typeLine) && cmc <= 2) tags.add('Spellslinger')

  return tags
}

// The full vocabulary deriveFunctionalTags can produce — not exhaustive of every tag that can
// ever exist (a manually-added custom tag is still free text, unconstrained), just the known
// standardized set, offered as autocomplete suggestions when adding a tag by hand so spelling/
// capitalization stays consistent with what auto-detection already uses.
export const KNOWN_FUNCTIONAL_TAGS: string[] = [
  '+1/+1 Counters',
  'Aggro',
  'Aura',
  'Blink',
  'Board Wipe',
  'Burn',
  'Card Draw',
  'Cast',
  'Clone',
  'Copy',
  'Cost Reduction',
  'Counters',
  'Counterspell',
  'Death Matters',
  'Discard',
  'Double',
  'Draw Matters',
  'Drain',
  'Equipment',
  'ETB',
  'Extra Turns',
  'Fight',
  'Fixing',
  'Flash',
  'Fog',
  'Goad',
  'Impulse Draw',
  'Land Destruction',
  'Life Gain',
  'Lord',
  'Mill',
  'Ping',
  'Protection',
  'Pump',
  'Ramp',
  'Reanimation',
  'Recursion',
  'Removal',
  'Ritual',
  'Sacrifice',
  'Soft Removal',
  'Spellslinger',
  'Stax',
  'Steal',
  'Taxing',
  'Token Creation',
  'Treasure',
  'Tutor',
  'Untap',
  'X Cost Matters'
].sort()

export function deriveCardTags(card: ScryfallCard): CardTags {
  const text = combinedOracleText(card)
  const typeLine = combinedTypeLine(card)
  const functionalTags = [...deriveFunctionalTags(text, typeLine, combinedManaCost(card), card.cmc)].sort()
  const keywordTags = [...(card.keywords ?? [])].sort()
  return { keywordTags, functionalTags }
}

/** Merges the auto-derived tags with a manual override (added/removed deltas), producing
 *  the final tag list shown/searched anywhere in the app. */
export function resolveCardTags(card: ScryfallCard, override?: CardTagOverride): string[] {
  const auto = deriveCardTags(card)
  const resolved = new Set([...auto.keywordTags, ...auto.functionalTags])
  for (const tag of override?.removed ?? []) resolved.delete(tag)
  for (const tag of override?.added ?? []) resolved.add(tag)
  return [...resolved].sort()
}
