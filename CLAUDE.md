# BiblioPLEX

A Windows desktop app (Electron + React + TypeScript) for Magic: The Gathering — card search,
deck building for Commander/EDH, and EDHREC-driven recommendations. Physical TCG only (Arena,
Alchemy, tokens-as-cards, joke sets, etc. are deliberately excluded everywhere — see
`queryBuilder.ts`).

Package name is `biblioplex` (npm package.json "name"). **Never change this casually** — see
the Gotchas section below, it directly controls where user data lives on disk.

## Stack & architecture

- **electron-vite** scaffold: `src/main` (Node/Electron main process), `src/preload` (context
  bridge), `src/renderer/src` (React 19 + TypeScript, no router — tab-based `App.tsx`).
- All external network calls (Scryfall, EDHREC) happen in the **main process only**. The
  renderer never calls `fetch` directly — everything goes through `window.api.*` (defined in
  `src/preload/index.ts`, implemented in `src/main/index.ts` IPC handlers). Add a new external
  call by: (1) implement it in `src/main/scryfall.ts` or `src/main/edhrec.ts`, (2) add an
  `ipcMain.handle` in `src/main/index.ts`, (3) expose it via `src/preload/index.ts`, (4) call
  `window.api.yourMethod(...)` from renderer components. Every one of those touch points needs
  matching parameter/return types kept in sync by hand (no shared-types package currently).
- Main-process changes require a full app restart to take effect (`npm run dev` again, or kill
  the electron process — electron-vite does not hot-reload main/preload). Renderer-only
  changes hot-reload live.
- `npm run typecheck` runs both tsconfig projects (`tsconfig.node.json` for main/preload,
  `tsconfig.web.json` for renderer). Run this after every change before considering it done.

## Data sources

- **Scryfall** (`src/main/scryfall.ts`) — the card database. No auth needed. Rate limiting is
  split into two throttled queues: general endpoints (10 req/s) and "heavy" endpoints — search,
  named, random, **collection** (2 req/s, regex-detected by URL). Both queues use a real
  promise-chain mutex, not a naive "check last timestamp" throttle — a naive version genuinely
  got the app rate-limited by Scryfall once (the EDHREC tag-index feature fires many
  `/cards/collection` calls). If you add a new Scryfall call, check whether it hits a "heavy"
  endpoint and don't bypass `throttledFetch`.
- **EDHREC** (`src/main/edhrec.ts`) — no official API. Scrapes the `__NEXT_DATA__` JSON blob
  embedded in server-rendered EDHREC pages (confirmed by manual inspection, documented inline).
  This is inherently fragile — if EDHREC changes their frontend, parsing breaks silently and
  falls back to an `EdhrecError`. Key capabilities: commander recommendation lists
  (`getCommanderData`, supports EDHREC's theme-tag filtering via `/commanders/<slug>/<tag>`),
  the site's real "Top Commanders" ranking (`getTopCommanders` — **not** the same as Scryfall's
  `order=edhrec` sort, which ranks differently), and a per-commander tag index
  (`getCommanderTagIndex`) that fetches every one of a commander's ~30 top tag pages to build a
  card→tags map — this is expensive (~15s first run) and cached 6 hours.
- **LigaMagic** (BRL pricing) — **not implemented**. User wants it as the default price
  reference eventually; no API exists, would require scraping, deliberately deferred. Currently
  only Scryfall's USD pricing shows in `CardDetail`.
- **Gatherer** — not integrated; Scryfall mirrors official rulings so it hasn't been needed.

## Feature inventory (as of this doc)

Tabs in `App.tsx`: **Search** (filtered card search, `FilterPanel` + `CardResults`), **Sets**
(browse by expansion), **Tokens** (token-only sets, separate from Sets), **Commander** (browse
EDHREC top commanders or search, view recommendations via `CommanderView`), **Decks** (the deck
builder — `DecksBrowser` list + `DeckBuilder` editor).

Deck builder (`DeckBuilder.tsx`) supports: search-to-add cards (click toggles in/out, singleton
rule enforced by oracle_id except basic lands — see `deckLogic.ts`), per-card printing swap
(`CardDetail`'s `deckMode` prop), drag-to-reorder cards within category sections, auto-derived
token needs (from Scryfall `all_parts`), category grouping (Planeswalker/Creature/Instant/
Sorcery/Artifact/Enchantment/Land/Other), Commander Bracket (1-5, color-coded), win/loss record
with color-coded win rate, manually-weighted "Priority Tags" + auto-computed "Deck Themes"
(from the EDHREC tag index), and **Partner/Background second-commander support**
(`partnerEligibility.ts` detects eligibility from oracle text; second commander gets its own
printing-swap, its own art-background, and its colors count toward the deck's identity).

Decks list (`DecksBrowser.tsx`): drag-to-reorder (persisted `order` field, independent of
`updatedAt`), simplified-view toggle (art hidden, persisted to `localStorage`), stacked
commander+partner card art preview, color-identity accent bar + name (`colorIdentityName.ts`
has the full guild/shard/nephilim naming table), bracket + win-rate shown as fixed-width stat
blocks so they don't drift when content length varies.

Both the deck builder header and the decks-list tiles show a large, low-opacity (~0.24)
`art_crop` image bled in from the right with a left-edge mask fade — this is a shared visual
pattern (`.deck-builder__commander-art-bg` / `.deck-card__art-bg` in `styles.css`), not a
component; keep both in sync if tuning it further.

## Known limitations / likely next asks

- EDHREC recommendations only ever target the **primary** commander — a partner/background
  pair doesn't get combined EDHREC data (EDHREC's actual pairing URL scheme wasn't fully
  researched; see `/backgrounds/<slug>` if picking this back up).
- No hard deck-legality validation (100-card count, color identity enforcement, banned list).
  Singleton is enforced on add, nothing else is.
- LigaMagic BRL pricing (see above).
- The EDHREC tag-index (~15s first load per commander) has no visible progress indicator
  beyond a static "this can take ~15s" hint — could use a real progress state.
- No card image caching — every printing switch re-hits Scryfall's CDN via plain `<img src>`
  (browser HTTP cache handles repeats reasonably, but there's no explicit local cache).

## Gotchas (learn from these, don't repeat them)

- **`app.getPath('userData')` is derived from package.json's `"name"` by default.** Renaming
  the package (e.g. the mtg-platform → biblioplex rebrand) silently points Electron at a new,
  empty profile folder and orphans the old one's `decks.json` — this actually happened and
  looked exactly like data loss. `deckStore.ts` now has `migrateLegacyDecksIfNeeded()` which
  auto-copies data from listed legacy app-name folders on first run if the current profile has
  none. **If you ever rename the package again, add the old name to `LEGACY_APP_NAMES`.**
- The `PrintingSelect` dropdown is a custom component, not a native `<select>` — native
  `<option>` elements can't embed the set-symbol icons the user wanted.
- `CardDetail`'s `deckMode` prop distinguishes editing a deck's regular card vs. its commander
  vs. its partner (`DeckBuilder`'s `viewingKind` state: `'card' | 'commander' | 'partner'`) —
  a commander/partner's `deckMode` omits `onRemove` (can't remove a commander from its own
  deck) but still supports `onPrintingChange`.
- The "in deck" badge on EDHREC recommendation tiles must be computed by **oracle identity**,
  not exact printing id — a naive exact-id check breaks the moment the user swaps a card's
  printing (this was a real bug, fixed via `deckOracleIds` + resolving EDHREC entries' oracle
  ids in `CommanderView`).
