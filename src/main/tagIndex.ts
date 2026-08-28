import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'

// Scryfall Tagger's ("Card"/Oracle) functional-tag taxonomy — a one-time scrape of Tagger's own
// GraphQL API (see scripts/scrape-tagger.mjs), bundled as a static app resource rather than
// fetched live: the data is the same for every user, and re-hitting Tagger's rate-limited,
// community-run endpoint from every install would be both slow and rude. Refreshing this data
// means re-running that script and re-copying its output into resources/tagger-data/, not
// anything that happens automatically at runtime.
//
// Wired into both cardTagIndex.ts's bulk Tag Search index (primary source, regex fallback only
// for cards Tagger hasn't tagged) and DeckBuilder's live per-deck tag resolution (via the
// getTaggerDataBatch IPC call, batched the same way the old CardTagOverride store is).

// Bump whenever a change here (a rollup mapping, the label formatting, which tags are surfaced)
// would produce different tags for existing cards — cardTagIndex.ts stamps every build with
// this, the same way TAGGING_VERSION in cardTagging.ts covers regex rule changes, so an index
// built under an older version is detected as stale and gets rebuilt instead of silently
// keeping outdated Tagger-derived tags around.
export const TAGGER_INTEGRATION_VERSION = 7

export interface TaggerTag {
  slug: string
  name: string
  description: string
  // Tagger's own "this is a broad umbrella, not a specific effect" flag (e.g. "removal", "mill",
  // "tutor") — the natural rollup target for Score/Analytics, but incomplete for our purposes
  // (see SUPPLEMENTAL_CATEGORY_SLUGS below).
  category: boolean
  // Every ancestor across every inheritance path, flattened and deduped (a tag can have more
  // than one parent lineage — e.g. "abrade" is both a "burn" and a "removal-artifact" descendant).
  // Does not include the tag's own slug.
  ancestors: string[]
  children: string[]
}

export interface TaggerTagRef {
  slug: string
  label: string
}

// Real deckbuilding categories Tagger's volunteers didn't happen to flag with category:true
// (it organizes its own taxonomy along different lines than "Commander strategic category"),
// but that function exactly like one for our purposes — same "walk ancestors, collect these"
// rollup treatment a real category tag gets. Extend this as gaps like this turn up; it's the
// one place non-Tagger-native judgment enters the rollup logic.
//   ramp / counterspell / group-hug — real umbrellas, just not flagged `category` by Tagger.
//   lifegain      — "Life Gain".
//   sacrifice-outlet — "Sacrifice" (a card that lets you sac things, not just "cares about it" —
//                    that's the separate, more specific `sacrifice-matters`).
//   extra-turn    — "Extra Turns".
//   death-trigger — "Death Matters".
const SUPPLEMENTAL_CATEGORY_SLUGS = new Set(['ramp', 'counterspell', 'group-hug', 'lifegain', 'sacrifice-outlet', 'extra-turn', 'death-trigger'])

// Real Tagger tags that are nonetheless not what a deckbuilder means by "what does this card
// do": rules-templating housekeeping (errata/deprecation tracking), Limited-only concepts
// (draft signpost), joke-set/flavor administrivia, or so broad they'd top the chart on every
// single deck regardless of its actual contents (card-names matches nearly any named reprint
// group). Hidden from BOTH the rollup categories and the specific tag list (see isHiddenSlug) —
// Tag Search still lets you search any of these directly if you really want to, this only keeps
// them out of the Deck Editor's own Card Tags summary.
//
// Every "cycle"/"cycle-*" tag is hidden by pattern, not by name — Tagger has a long tail of
// these (cycle-land, cycle-mono-land, cycle-lea-basic-land, ...) and new ones keep turning up.
// Bare "cycle" itself was kept for a while (a real cycle of nonbasic cards, e.g. the five
// Ravnica bounce lands, still felt like a useful signal), but in practice which cards get
// tagged with it reads as too inconsistent/arbitrary to trust as a deckbuilding category —
// hidden along with the rest rather than half-trusted.
const HIDDEN_SLUG_PATTERN = /^cycle\b/
const HIDDEN_CATEGORY_SLUGS = new Set([
  'black-effect',
  'blue-effect',
  'green-effect',
  'red-effect',
  'keyword-errata',
  'draft-signpost',
  'deprecated-card-types',
  'deprecated-mechanics',
  'type-errata-addition',
  'type-errata-genericise',
  'type-errata-specific',
  'type-errata-name-self',
  'dnd',
  'meme',
  'un-design',
  'un-set-mechanics',
  // Same "how plain is this creature" family as flavors-of-vanilla below, just not linked to it
  // in Tagger's own ancestry data — a card being vanilla/French vanilla isn't a deckbuilding
  // trait, whatever permanent type it happens to be.
  'vanilla-aura',
  'vanilla-equipment',
  'french-vanilla-aura',
  'french-vanilla-equipment',
  'noncreature-virtual-vanilla'
])

// Hides a whole subtree at once (the tag itself plus every descendant) — appropriate when the
// noise is definitionally rooted in one umbrella, unlike the flat list above.
//   card-names        — descendants are pure naming/flavor trivia (alliteration, eponymous,
//                        punny-name, creature-type-name, ...); the genuinely useful name-related
//                        mechanics (tutored-by-name, name-matters payoffs, conjure-named, ...)
//                        all sit OUTSIDE this subtree entirely, confirmed against their own
//                        ancestry, so this doesn't catch anything worth keeping.
//   flavors-of-vanilla — "how plain is this creature" (french-vanilla, virtual-vanilla,
//                        virtual-french-vanilla, ...) is a flavor observation, not a functional
//                        trait — hiding just the parent left its own children (which is what a
//                        card actually gets tagged with) showing up anyway.
const HIDDEN_SUBTREE_ROOTS = new Set(['card-names', 'flavors-of-vanilla'])

function isHiddenSlug(slug: string): boolean {
  if (HIDDEN_CATEGORY_SLUGS.has(slug) || HIDDEN_SLUG_PATTERN.test(slug) || HIDDEN_SUBTREE_ROOTS.has(slug)) return true
  const tag = tagsBySlug?.get(slug)
  return tag ? tag.ancestors.some((a) => HIDDEN_SUBTREE_ROOTS.has(a)) : false
}

// Categories with no single matching Tagger tag at all — either scattered across several
// sibling tags with no shared umbrella parent (Token Creation), or split across two
// differently-named but functionally-identical tags (Board Wipe: "sweeper" and "board-reset"
// both mean "clears the whole battlefield", just entered separately by different taggers).
// Defined here as an explicit union rather than picking one and pretending it's the "real" one.
const CUSTOM_ROLLUPS: Record<string, { label: string; slugs: string[] }> = {
  'board-wipe': {
    label: 'Board Wipe',
    slugs: ['sweeper', 'board-reset']
  },
  // Token Creation turned out to be the hard one — Tagger doesn't tag "makes a token" as its
  // own concept at all, and plenty of real token-makers don't have "token" anywhere in their
  // tag names (Anguine Evangelist gets "enters-in-company"/"leaves-body-behind" instead, both
  // ancestor-descendants of "multiple-bodies"). These are anchor points, not an exhaustive leaf
  // list — matching below walks each card tag's own ancestry too, so e.g. "enters-in-company"
  // still resolves here through its "multiple-bodies" ancestor without needing its own entry.
  'token-creation': {
    label: 'Token Creation',
    slugs: [
      'creates-oracle-token',
      'creates-token-of-a-card',
      'repeatable-creature-tokens',
      'repeatable-artifact-tokens',
      'repeatable-enchantment-tokens',
      'repeatable-noncreature-tokens',
      'repeatable-token-generator',
      'tokenfall',
      'multiple-bodies',
      'leaves-body-behind'
    ]
  }
}
const SLUG_TO_CUSTOM_ROLLUP = new Map<string, string>(
  Object.entries(CUSTOM_ROLLUPS).flatMap(([rollupSlug, def]) => def.slugs.map((s) => [s, rollupSlug] as const))
)

let tagsBySlug: Map<string, TaggerTag> | null = null
let cardTagsByOracleId: Record<string, string[]> | null = null
let loadPromise: Promise<void> | null = null

function dataDir(): string {
  // Dev layout: resources/ sits next to src/ at the project root, same reasoning as
  // findJavaBridgeJar in gameSim.ts — app.getAppPath() resolves there in dev.
  const devPath = join(app.getAppPath(), 'resources', 'tagger-data')
  if (existsSync(devPath)) return devPath
  // Packaged-build path — see package.json's build.extraResources.
  return join(process.resourcesPath ?? '', 'tagger-data')
}

async function ensureLoaded(): Promise<void> {
  if (tagsBySlug && cardTagsByOracleId) return
  loadPromise ??= (async () => {
    const dir = dataDir()
    const [tagsRaw, cardTagsRaw] = await Promise.all([
      readFile(join(dir, 'tags.json'), 'utf-8'),
      readFile(join(dir, 'card-tags.json'), 'utf-8')
    ])
    const tags = JSON.parse(tagsRaw) as TaggerTag[]
    tagsBySlug = new Map(tags.map((t) => [t.slug, t]))
    cardTagsByOracleId = JSON.parse(cardTagsRaw) as Record<string, string[]>
  })()
  await loadPromise
}

// Tagger's own `name` field is raw volunteer-entered text with inconsistent formatting
// ("removal-destroy" alongside "spot removal", hyphens and spaces both showing up for what
// should be the same style of label) — normalized here rather than trusted verbatim so every
// tag reads the same way regardless of how its particular entry happened to be typed in.
function formatTagLabel(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

// A handful of rollup slugs where the generic formatting above doesn't match this app's own
// established vocabulary (DeckScoreView and DeckAnalyticsView both hardcode category names like
// "Card Draw"/"Board Wipe" — this is what keeps a Tagger-sourced "Removal" and a regex-fallback
// "Removal" reading as literally the same category everywhere that cares, Score/Analytics
// included, rather than silently forking into two spellings of the same idea).
const LABEL_OVERRIDES: Record<string, string> = {
  draw: 'Card Draw',
  lifegain: 'Life Gain',
  'sacrifice-outlet': 'Sacrifice',
  'extra-turn': 'Extra Turns',
  'death-trigger': 'Death Matters'
}

function labelFor(tag: TaggerTag): string {
  return LABEL_OVERRIDES[tag.slug] ?? formatTagLabel(tag.name)
}

function toRef(slug: string): TaggerTagRef | null {
  const tag = tagsBySlug?.get(slug)
  return tag ? { slug, label: labelFor(tag) } : null
}

function isRollupCategory(tag: TaggerTag): boolean {
  return (tag.category || SUPPLEMENTAL_CATEGORY_SLUGS.has(tag.slug)) && !isHiddenSlug(tag.slug)
}

/** The specific Tagger tags applied to one card (by oracle id — tags apply to the oracle card,
 *  all printings share them), with HIDDEN_CATEGORY_SLUGS/cycle-* filtered out here too — a
 *  hidden tag can be directly applied to a card (not just be some other tag's ancestor), so
 *  isRollupCategory's own filtering alone doesn't keep it out of the specific list. Empty for a
 *  card Tagger hasn't tagged at all (or with nothing but hidden tags). */
export async function getTaggerTagsForOracleId(oracleId: string): Promise<TaggerTagRef[]> {
  await ensureLoaded()
  const slugs = (cardTagsByOracleId?.[oracleId] ?? []).filter((slug) => !isHiddenSlug(slug))
  return slugs.map(toRef).filter((t): t is TaggerTagRef => t !== null)
}

/** Every category-level tag (Tagger's own category:true, SUPPLEMENTAL_CATEGORY_SLUGS, or a
 *  CUSTOM_ROLLUPS anchor) that any of the given specific tag slugs rolls up to — e.g.
 *  "removal-destroy" and "spot-removal" both resolve to "Removal" via ancestry, and
 *  "enters-in-company" resolves to the synthetic "Token Creation" via its "multiple-bodies"
 *  ancestor even though "enters-in-company" itself isn't one of that rollup's listed anchors —
 *  a card contributes to one combined count in Score/Analytics instead of needing every
 *  specific variant checked separately.
 *
 *  Both checks walk the SAME ancestry chain (the tag itself plus every ancestor), since a
 *  CUSTOM_ROLLUPS anchor is exactly as capable of having its own untagged-but-related
 *  descendants as a real Tagger category is. */
export async function getRollupCategoriesForSlugs(slugs: string[]): Promise<TaggerTagRef[]> {
  await ensureLoaded()
  const categories = new Map<string, TaggerTagRef>()
  for (const slug of slugs) {
    const tag = tagsBySlug?.get(slug)
    if (!tag) continue
    for (const candidateSlug of [tag.slug, ...tag.ancestors]) {
      const candidate = tagsBySlug?.get(candidateSlug)
      if (candidate && isRollupCategory(candidate)) categories.set(candidate.slug, { slug: candidate.slug, label: labelFor(candidate) })
      const customRollupSlug = SLUG_TO_CUSTOM_ROLLUP.get(candidateSlug)
      if (customRollupSlug) categories.set(customRollupSlug, { slug: customRollupSlug, label: CUSTOM_ROLLUPS[customRollupSlug].label })
    }
  }
  return [...categories.values()]
}

export interface TaggerCardData {
  specific: TaggerTagRef[]
  rollup: TaggerTagRef[]
}

/** One round trip for a whole deck's worth of cards — mirrors getCardTagOverridesBatch's shape
 *  (see cardTagStore.ts) so callers can fetch once per deck load and resolve tags synchronously
 *  from then on, rather than an IPC round trip per card. Omits an oracle id entirely when Tagger
 *  has nothing for it, so the caller knows to fall back to the regex tagger for that card. */
export async function getTaggerDataBatch(oracleIds: string[]): Promise<Record<string, TaggerCardData>> {
  await ensureLoaded()
  const result: Record<string, TaggerCardData> = {}
  for (const id of oracleIds) {
    const slugs = cardTagsByOracleId?.[id] ?? []
    if (slugs.length === 0) continue
    // Rollup computation still walks the FULL unfiltered slug list — a hidden specific tag
    // (e.g. "cycle-land") can still have a legitimate, non-hidden ancestor ("cycle") worth
    // keeping as a rollup; hiding the specific tag doesn't mean throwing away that signal too.
    // The specific list itself, though, is exactly what a hidden tag should never appear in.
    const specific = slugs
      .filter((slug) => !isHiddenSlug(slug))
      .map(toRef)
      .filter((t): t is TaggerTagRef => t !== null)
    const rollup = await getRollupCategoriesForSlugs(slugs)
    result[id] = { specific, rollup }
  }
  return result
}

/** Every oracle id Tagger has data for at all — used by the bulk Tag Search index build
 *  (cardTagIndex.ts), which walks Scryfall's entire oracle-card pool once rather than a known
 *  deck's cards, so there's no pre-known oracleIds list to hand getTaggerDataBatch here. */
export async function getAllTaggerCardData(): Promise<Record<string, TaggerCardData>> {
  await ensureLoaded()
  return getTaggerDataBatch(Object.keys(cardTagsByOracleId ?? {}))
}

/** Whether a given slug is a real, known Tagger tag — used to constrain a per-deck user-added
 *  tag to the actual Tagger vocabulary rather than accepting free text. */
export async function isKnownTaggerSlug(slug: string): Promise<boolean> {
  await ensureLoaded()
  return tagsBySlug?.has(slug) ?? false
}

/** Every non-hidden tag in the taxonomy, for building a per-deck "add a tag" picker — no reason
 *  to offer "Card Names" or a cycle-*-land tag as something a user might deliberately want to
 *  add to a card. */
export async function getAllTaggerTags(): Promise<TaggerTagRef[]> {
  await ensureLoaded()
  return [...(tagsBySlug?.keys() ?? [])]
    .filter((slug) => !isHiddenSlug(slug))
    .map(toRef)
    .filter((t): t is TaggerTagRef => t !== null)
}
