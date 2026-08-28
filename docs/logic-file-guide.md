# BiblioPLEX Logic File Guide

This document is meant to be pasted into a Claude conversation (or given to any capable
assistant), alongside a decklist, to produce a **Logic file** for that deck. BiblioPLEX itself
has no AI integration — it only *reads* Logic files. Generating one happens in a separate
conversation, using this guide plus the decklist as the two inputs.

## What a Logic file is for

BiblioPLEX's Playtest tab runs real games against a bot AI. That AI is generically strong at
Magic, but has no way to know that *this specific deck* wants it to play a certain card in a
certain way beyond what plain board-state evaluation already tells it. A Logic file is a small
JSON file that fills in that gap for one specific, narrow situation (described below) — nothing
more. It's optional: a deck with no Logic file plays with the AI's normal default behavior.

## The one thing a Logic file can currently express

**Holding an instant/flash spell until a specific creature is attacking**, so that creature's
"whenever you cast a spell while attacking" trigger actually fires. Left to its own devices, the
AI is happy to cast a good instant the moment it's useful, which is usually *before* that
creature attacks — wasting the bonus. This rule tells it: hold spells back and wait for the
attack step instead, as long as doing so doesn't cost you the turn's play entirely.

This is the **only** rule type BiblioPLEX currently understands. Don't invent others — an
unrecognized rule type is rejected by the app as an error, not silently ignored.

## Which cards qualify

A permanent qualifies for this rule if its oracle text has a trigger shaped like:

> "Whenever you cast a spell while [this creature] is attacking, \<something good happens\>."

or close variants — "while attacking" / "during combat, while this is attacking" / etc., where
the trigger is conditioned on **you casting a spell** and **this permanent currently attacking**.
It does not matter what the "something good" is (copy the spell, draw a card, deal damage,
whatever) — only the cast-while-attacking condition matters for this rule.

It does **not** qualify if the trigger just cares about combat damage, about *any* creature
attacking, about the spell's type, or about anything other than "you cast a spell" + "this thing
is attacking." Those situations aren't expressible in v1 of this format.

## Building the file

1. Go through the decklist and find every card matching the pattern above.
2. For each one, note its exact printed name.
3. Group them into one or more `rules` entries — usually one rule per card is simplest, but
   cards that should be treated identically can share a rule's `permanentNames` list.
4. Fill in the schema below and save it as a `.json` file (or just have the deck owner paste the
   raw text directly — no file extension is enforced).

### Schema

```json
{
  "biblioplexLogicFile": true,
  "version": 1,
  "rules": [
    {
      "type": "holdInstantUntilAttackTrigger",
      "permanentNames": ["Exact Card Name"],
      "note": "Optional — free text, for the deck owner's own reference. Ignored by the app."
    }
  ]
}
```

Field notes:
- `biblioplexLogicFile` and `version` must be present exactly as shown (`version: 1` for this
  schema) — the app uses them to recognize a real Logic file and reject anything else.
- `rules` must be a non-empty array if present at all.
- `type` must be exactly `"holdInstantUntilAttackTrigger"` — any other value is a hard error.
- `permanentNames` must be a non-empty array of exact card names (case doesn't matter, but spell
  them correctly — a typo just means that card is silently not covered by the rule).
- `note` is optional and purely for the human reader.

### Worked example

A deck containing a creature along the lines of Fire Lord Azula — a creature whose ability
copies spells you cast while it's attacking — would produce:

```json
{
  "biblioplexLogicFile": true,
  "version": 1,
  "rules": [
    {
      "type": "holdInstantUntilAttackTrigger",
      "permanentNames": ["Fire Lord Azula"],
      "note": "Copies spells cast while attacking — hold interaction until it's swinging."
    }
  ]
}
```

If a deck has two such creatures with different downstream effects, give each its own rule entry
(same `type`, different `permanentNames`/`note`) rather than merging them, so the note stays
accurate per card.

## Using the file

In BiblioPLEX, open the deck in Deck Builder and use the **Logic** section's **Import Logic**
button (next to Import/Export Deck) — paste the JSON in and confirm. The app will:
- reject it outright if the shape above isn't followed (wrong marker/version, unrecognized rule
  `type`, malformed `permanentNames`);
- warn (but still save) if a listed card name isn't actually found in that deck — worth
  double-checking for a typo, but not treated as fatal.

A deck can only have one Logic file at a time; importing again replaces it.
