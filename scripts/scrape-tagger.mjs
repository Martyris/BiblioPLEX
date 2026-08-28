// One-off research/bootstrap script — NOT part of the shipped app. Scrapes Scryfall Tagger's
// GraphQL endpoint (tagger.scryfall.com/graphql, the same API the site's own frontend calls) to
// build a full snapshot of the "card" (functional/Oracle) tag taxonomy and every card each tag
// applies to. This is the raw research dump the real in-app tag system will be designed against;
// it is deliberately dumb and complete (grab everything) rather than opinionated about which
// tags matter — that curation happens once we can see the real data.
//
// Auth note: the GraphQL endpoint is behind standard Rails CSRF protection, but works fully
// anonymously — a plain GET of the homepage hands back a session cookie + csrf-token meta tag,
// and both get replayed on every POST /graphql call below. No sign-in needed.
//
// Usage: node scripts/scrape-tagger.mjs
// Output: scripts/tagger-data/tags.json, scripts/tagger-data/taggings.json, scripts/tagger-data/meta.json

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'tagger-data')
const BASE_URL = 'https://tagger.scryfall.com'
const MAX_RETRIES = 8
const MAX_THROTTLE_MS = 8000

// Adaptive, one-way ratchet: starts courteous, and any 429 permanently raises the delay for the
// rest of the run rather than just backing off that one request — a burst limiter is tracking
// our request rate over a window, not any single call, so the fix is to slow down overall.
let throttleMs = 400

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function bootstrap() {
  const res = await fetch(BASE_URL + '/')
  const html = await res.text()
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const match = html.match(/name="csrf-token" content="([^"]+)"/)
  if (!match) throw new Error('Could not find csrf-token meta tag on Tagger homepage')
  csrfToken = match[1]
}

let cookie = ''
let csrfToken = ''

async function graphql(query, attempt = 1) {
  await sleep(throttleMs)
  let res
  try {
    // A hung connection with no timeout stalled an earlier run indefinitely (no error, no
    // retry, just silence) — 20s is generous for a single GraphQL call, but bounds the wait.
    res = await fetch(BASE_URL + '/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: cookie },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20000)
    })
  } catch (err) {
    console.warn(`  ! request failed (${err.name}: ${err.message}) — retrying (attempt ${attempt}/${MAX_RETRIES})`)
    if (attempt >= MAX_RETRIES) throw err
    await sleep(2000 * attempt)
    return graphql(query, attempt + 1)
  }
  if (res.status === 429) {
    throttleMs = Math.min(MAX_THROTTLE_MS, Math.round(throttleMs * 1.6))
    console.warn(`  ! 429 rate-limited — raising throttle to ${throttleMs}ms (attempt ${attempt}/${MAX_RETRIES})`)
    const retryAfter = Number(res.headers.get('retry-after'))
    if (attempt >= MAX_RETRIES) throw new Error('GraphQL request failed: HTTP 429 (exhausted retries)')
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt)
    return graphql(query, attempt + 1)
  }
  if (!res.ok) {
    if (attempt >= MAX_RETRIES) throw new Error(`GraphQL request failed: HTTP ${res.status}`)
    await sleep(1000 * attempt)
    return graphql(query, attempt + 1)
  }
  const json = await res.json()
  if (json.errors) {
    // Re-bootstrap once in case the session/token went stale mid-run, then retry.
    if (attempt < MAX_RETRIES) {
      await bootstrap()
      return graphql(query, attempt + 1)
    }
    throw new Error('GraphQL errors: ' + JSON.stringify(json.errors))
  }
  return json.data
}

/** All ORACLE_CARD_TAG entries — the full functional-tag taxonomy, including each tag's
 *  ancestry (every parent path, since a tag can inherit from more than one lineage) and direct
 *  children, straight from the list endpoint (no need for a second per-tag request). */
async function fetchAllTags() {
  const tags = []
  let page = 1
  for (;;) {
    const data = await graphql(`{
      tags(input: {type: ORACLE_CARD_TAG, page: ${page}}) {
        total
        page
        perPage
        results {
          id
          name
          slug
          description
          category
          status
          ancestry { tag { slug } }
          childTags { slug }
        }
      }
    }`)
    const { total, perPage, results } = data.tags
    tags.push(...results)
    console.log(`[tags] page ${page} — ${tags.length}/${total}`)
    if (tags.length >= total || results.length === 0) break
    page += 1
    if (page > Math.ceil(total / perPage) + 2) break // safety valve against an infinite loop
  }
  return tags
}

/** Every oracle id a single tag applies to (paginated — tags like "removal" run well past one
 *  page of 75). Logs (and keeps, rather than dropping) any tagging whose foreignKey isn't
 *  "oracleId" — shouldn't happen for a card/oracle tag, but better to see it than silently lose
 *  data if it does. */
async function fetchTaggingsFor(tag, index, totalTags) {
  const oracleIds = []
  const unexpected = []
  let page = 1
  for (;;) {
    const data = await graphql(`{
      tag(id: "${tag.id}") {
        taggings(page: ${page}) {
          total
          perPage
          results { foreignKey subjectId }
        }
      }
    }`)
    const { total, perPage, results } = data.tag.taggings
    for (const r of results) {
      if (r.foreignKey === 'oracleId') oracleIds.push(r.subjectId)
      else unexpected.push(r)
    }
    const fetched = (page - 1) * perPage + results.length
    if (fetched >= total || results.length === 0) break
    page += 1
    if (page > Math.ceil(total / perPage) + 2) break
  }
  console.log(`[taggings] (${index + 1}/${totalTags}) ${tag.slug} — ${oracleIds.length} cards`)
  if (unexpected.length > 0) console.warn(`  ! ${unexpected.length} non-oracleId taggings on "${tag.slug}"`, unexpected.slice(0, 3))
  return oracleIds
}

async function main() {
  console.log('Bootstrapping session against tagger.scryfall.com...')
  await bootstrap()

  await mkdir(OUT_DIR, { recursive: true })

  // The taxonomy itself (unlike taggings, below) is one quick pass (~46 requests) — but on a
  // resumed run there's no reason to pay for it again, especially right after a 429 taught the
  // throttle a cautious pace.
  let tags
  try {
    tags = JSON.parse(await readFile(join(OUT_DIR, 'tags.json'), 'utf-8'))
    console.log(`Reusing cached tags.json (${tags.length} tags) from a prior run.`)
  } catch {
    console.log('Fetching full card-tag taxonomy...')
    tags = await fetchAllTags()
    console.log(`Got ${tags.length} card tags total.`)
    await writeFile(join(OUT_DIR, 'tags.json'), JSON.stringify(tags, null, 2), 'utf-8')
    console.log(`Wrote tags.json (${tags.length} tags).`)
  }

  // Resumable — this phase is by far the longest part (one+ request per tag, some paginated
  // several times over), easily long enough to outlast a single command's timeout. A tag slug
  // already present as a key in a prior run's taggings.json (even with an empty array — that's
  // still a completed "this tag has 0 cards" result) is skipped rather than re-fetched.
  let taggings = {}
  try {
    taggings = JSON.parse(await readFile(join(OUT_DIR, 'taggings.json'), 'utf-8'))
    console.log(`Resuming — ${Object.keys(taggings).length} tags already fetched in a prior run.`)
  } catch {
    // No prior taggings.json (or it's unreadable) — starting fresh.
  }

  console.log('Fetching every card each tag applies to (this is the long part)...')
  let totalAssociations = Object.values(taggings).reduce((sum, ids) => sum + ids.length, 0)
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]
    if (Object.prototype.hasOwnProperty.call(taggings, tag.slug)) continue
    const oracleIds = await fetchTaggingsFor(tag, i, tags.length)
    taggings[tag.slug] = oracleIds
    totalAssociations += oracleIds.length
    // Flush after every tag, not just periodically — this phase is the one likely to get cut
    // off by a timeout, so losing less than one tag's worth of work on interruption matters
    // more here than the extra disk I/O costs.
    await writeFile(join(OUT_DIR, 'taggings.json'), JSON.stringify(taggings), 'utf-8')
  }

  const meta = {
    scrapedAt: new Date().toISOString(),
    totalTags: tags.length,
    totalCardTagAssociations: totalAssociations
  }
  await writeFile(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')

  console.log('Done.')
  console.log(meta)
}

main().catch((err) => {
  console.error('Scrape failed:', err)
  process.exit(1)
})
