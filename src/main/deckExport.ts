import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import PDFDocument from 'pdfkit'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import sharp from 'sharp'

export interface DecklistPdfEntry {
  count: number
  name: string
  set: string
  collectorNumber: string
  foil: boolean
  isCommander: boolean
  isBasicLand: boolean
  imageUrl: string
}

export interface DecklistPdfGroup {
  label: string
  color: string
  entries: DecklistPdfEntry[]
}

// Same dark palette as src/renderer/src/styles.css's :root — the PDF is meant to read as an
// extension of the app, not a generic printout.
const BG = '#14141a'
const PANEL = '#1e1e26'
const BORDER = '#2f2f3a'
const TEXT = '#e8e8ef'
const MUTED = '#9a9aab'
const ACCENT = '#7c6fef'

// Fixed page size throughout — a single source of truth so the grid/embed-size math (which
// needs the width before a PDFDocument exists to size images against) and the actual
// PDFDocument constructor never drift apart.
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

const MARGIN = 40
// A target, not a fixed size — computeGridMetrics stretches the actual thumbnail width so a
// row always fills the full page width exactly, rather than leaving a ragged gap on the right.
// 4 per row at Letter width — readability comes from the source image quality (see 'normal'
// vs 'small' at the buildDecklistPdfGroups call site), not from shrinking to 3 per row.
const TARGET_THUMB_W = 108
const MIN_GAP = 14
// No visible caption under a thumbnail anymore — this is just a small buffer before the
// invisible round-trip line the PDF re-import parses back out (see drawGrid).
const CAPTION_H = 4
const GAP_Y = 14

interface GridMetrics {
  columns: number
  thumbW: number
  thumbH: number
  cellW: number
  cellH: number
}

function computeGridMetrics(pageWidth: number): GridMetrics {
  const usableWidth = pageWidth - MARGIN * 2
  const columns = Math.max(1, Math.floor((usableWidth + MIN_GAP) / (TARGET_THUMB_W + MIN_GAP)))
  const thumbW = (usableWidth - (columns - 1) * MIN_GAP) / columns
  const thumbH = Math.round((thumbW * 88) / 63) // Magic card aspect ratio, 63:88
  return { columns, thumbW, thumbH, cellW: thumbW + MIN_GAP, cellH: thumbH + CAPTION_H + GAP_Y }
}

// cards.scryfall.io (unlike api.scryfall.com) rejects a request with no/empty User-Agent
// outright (HTTP 400) — confirmed by hand, not documented — so this can't skip the header the
// way a plain <img src> tag in the renderer implicitly gets one from the browser.
const IMAGE_FETCH_USER_AGENT = 'BiblioPLEX/0.1 (https://github.com/; local dev build)'

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': IMAGE_FETCH_USER_AGENT } })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

// pdfkit embeds whatever bytes it's handed as-is — it does NOT downsample a source image to
// however small it's actually drawn, so fetching Scryfall's 'normal' size (488x680) for a
// thumbnail that renders at maybe 130pt wide bakes every one of that image's original bytes into
// the PDF regardless. Re-encoding once at roughly the size it's actually drawn (times a bit, for
// a couple of zoom levels of headroom) is where the real file-size win is, not the source size
// picked at the fetch call site.
async function resizeForEmbed(buffer: Buffer, maxWidth: number, quality: number): Promise<Buffer> {
  try {
    return await sharp(buffer).rotate().resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality }).toBuffer()
  } catch {
    return buffer // an already-small or otherwise-unusual image — embed it unmodified rather than fail the export
  }
}

// Scryfall's image CDN isn't rate-limited the way api.scryfall.com is (see scryfall.ts's
// throttled queues) — a decklist is at most ~100 unique printings, so a small worker pool is
// plenty polite without making the export take forever.
const FETCH_CONCURRENCY = 8

async function fetchImages(urls: string[], embedWidth: number): Promise<Map<string, Buffer>> {
  const unique = [...new Set(urls)]
  const result = new Map<string, Buffer>()
  let next = 0
  async function worker(): Promise<void> {
    while (next < unique.length) {
      const url = unique[next++]
      const buffer = await fetchBuffer(url)
      if (buffer) result.set(url, await resizeForEmbed(buffer, embedWidth, 80))
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, unique.length) }, worker))
  return result
}

const WUBRG_ORDER = ['W', 'U', 'B', 'R', 'G']
const PIP_PX = 64 // rasterized once at a fixed size well above its ~12pt draw size, for crisp scaling

/** Rasterizes the deck's color-identity mana symbols (same card-symbol SVGs ColorPips.tsx draws
 *  in the app itself, via manaSymbol.ts's URL scheme) into small PNGs pdfkit can embed — pdfkit
 *  has no SVG support, so these can't be drawn directly the way the renderer does. Falls back to
 *  the colorless symbol when the identity is empty, mirroring ColorPips.tsx's own fallback. */
async function fetchColorPips(colorIdentity: string[]): Promise<Buffer[]> {
  const letters = WUBRG_ORDER.filter((c) => colorIdentity.includes(c))
  const symbols = letters.length > 0 ? letters : ['C']
  const rasterized = await Promise.all(
    symbols.map(async (letter) => {
      const svg = await fetchBuffer(`https://svgs.scryfall.io/card-symbols/${encodeURIComponent(letter)}.svg`)
      if (!svg) return null
      try {
        return await sharp(svg, { density: 300 }).resize(PIP_PX, PIP_PX).png().toBuffer()
      } catch {
        return null
      }
    })
  )
  return rasterized.filter((b): b is NonNullable<typeof b> => b !== null)
}

// Deliberately resources/pdf-logo.png, NOT resources/icon.png: icon.png is cropped tight to its
// own canvas edges (built for OS icon conventions, which routinely bleed to the edge) — its
// circle's bottom arc is literally clipped by the png's own bottom row, confirmed by hand
// (0px of padding top or bottom vs. ~53px on the source art). pdf-logo.png is a copy of
// src/renderer/src/assets/logo.png instead, which keeps the full circle with real padding
// around it. Same dev-vs-packaged resolution as tagIndex.ts's dataDir() — see package.json's
// build.extraResources, which copies this file to pdf-assets/logo.png in a packaged build.
function logoPath(): string {
  const devPath = join(app.getAppPath(), 'resources', 'pdf-logo.png')
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath ?? '', 'pdf-assets', 'logo.png')
}

async function loadLogo(): Promise<Buffer | null> {
  try {
    return await readFile(logoPath())
  } catch {
    return null // missing/unbuilt resource — the sheet still works, just without the watermark
  }
}

// A small, cleanly-resampled copy of the logo for the header mark and footer icon — leaving a
// PDF viewer to scale the full 800x800 source down to ~40pt itself was producing visibly broken
// fine linework (the header/footer logo looked "cut off" at the bottom, where the art is
// finest), not an actual crop but a downscaling artifact. Resizing once here with sharp's own
// resampling bakes in a clean result instead of leaving it to whatever the viewer does. PNG, not
// JPEG, to keep the logo's transparency — resizeForEmbed's JPEG re-encode would flatten it onto
// a solid background.
async function resizeLogoIcon(buffer: Buffer, width: number): Promise<Buffer> {
  try {
    return await sharp(buffer).resize({ width, withoutEnlargement: true }).png().toBuffer()
  } catch {
    return buffer
  }
}

// A large, very-faint copy of the app's own logo bled off the bottom-right corner of every
// page — big enough that only its upper-left arc actually shows, the same "not the whole shape,
// bled off an edge" treatment as the header art.
function paintPageBackground(doc: PDFKit.PDFDocument, logo: Buffer | null): void {
  doc.save()
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG)
  if (logo) {
    const size = doc.page.width * 1.125
    const centerX = doc.page.width * 0.74
    const centerY = doc.page.height * 0.72
    doc.opacity(0.05)
    try {
      doc.image(logo, centerX - size / 2, centerY - size / 2, { width: size, height: size })
    } catch {
      // A corrupt/undecodable logo asset shouldn't sink the whole export.
    }
    doc.opacity(1)
  }
  doc.restore()
}

// A small, fully-opaque icon + wordmark in the bottom-right corner of every page — distinct
// from the giant faded watermark above; this one's meant to actually be read, if only at a
// glance, the way a printed handout's footer credits whoever made it.
function drawFooter(doc: PDFKit.PDFDocument, logo: Buffer | null): void {
  doc.save()
  const iconSize = 17
  const gap = 6
  const label = 'BiblioPLEX'
  doc.font('Helvetica-Bold').fontSize(9)
  const labelW = doc.widthOfString(label)
  const totalW = (logo ? iconSize + gap : 0) + labelW
  const rightEdge = doc.page.width - MARGIN
  const startX = rightEdge - totalW
  // Text's optical center (cap-height midpoint, not its nominal line-box top pdfkit positions
  // by) needs to land on the icon's own geometric center: textOpticalCenter ≈ textY + 0.36 *
  // fontSize (derived the same way as the header pip row's correction), iconCenter = iconY +
  // iconSize / 2 — solved for iconY given textY.
  const textY = doc.page.height - 27
  const iconY = textY + 0.36 * 9 - iconSize / 2

  if (logo) {
    try {
      doc.image(logo, startX, iconY, { width: iconSize, height: iconSize })
    } catch {
      // A corrupt/undecodable logo asset shouldn't sink the whole export.
    }
  }
  // lineBreak: false is load-bearing, not cosmetic: this text sits below doc.page.maxY() (the
  // footer lives in the bottom margin, by design) — pdfkit's LineWrapper checks maxY as soon as
  // it starts wrapping (see the `document.y > this.maxY` check in pdfkit.js) and, if a `width`
  // is present at all (which an omitted `width` still gets by default unless lineBreak is
  // explicitly false — see _initOptions), calls continueOnNewPage() to "fix" it. That re-emits
  // 'pageAdded', which calls drawFooter again, at the same too-low y, on the new page — infinite
  // recursion until the stack overflows. This one call is what was actually crashing the export.
  doc.fillColor(MUTED).text(label, startX + (logo ? iconSize + gap : 0), textY, { lineBreak: false })
  doc.restore()
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
    doc.addPage()
  }
}

// pdfkit's own `cover` option only offers three fixed crop anchors (top/unset, 'center',
// 'bottom' — see the image() source in pdfkit.js), no way to land "mostly centered, slightly
// toward the top." `openImage` (real, used internally by pdfkit itself, just missing from
// @types/pdfkit) exposes the natural pixel size needed to blend between top and center by hand.
function openImageSize(doc: PDFKit.PDFDocument, buffer: Buffer): { width: number; height: number } {
  return (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(buffer)
}

/** Draws `buffer` scaled to cover a box exactly (cropping one axis), like pdfkit's own `cover`,
 *  but with a continuous vertical anchor instead of pdfkit's fixed top/center/bottom: 0 keeps
 *  the image's own top edge, 1 keeps its bottom edge, 0.5 centers the crop, values between blend
 *  proportionally. Horizontal overflow (rare for a wide box like the header) is always centered. */
function drawCoverImage(
  doc: PDFKit.PDFDocument,
  buffer: Buffer,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  verticalBias: number
): void {
  const { width: naturalW, height: naturalH } = openImageSize(doc, buffer)
  const boxAspect = boxW / boxH
  const imgAspect = naturalW / naturalH
  const drawW = imgAspect > boxAspect ? boxH * imgAspect : boxW
  const drawH = imgAspect > boxAspect ? boxH : boxW / imgAspect
  const x = boxX - (drawW - boxW) / 2
  const y = boxY - (drawH - boxH) * verticalBias
  doc.image(buffer, x, y, { width: drawW, height: drawH })
}

// Mirrors bracketColor.ts's own casual-to-competitive green→red scale, used for the "Bracket N"
// text exactly as the Decks list's own tiles show it (colored, bold, no descriptive suffix).
const BRACKET_COLORS: Record<number, string> = {
  1: '#7ee787',
  2: '#b5d96a',
  3: '#e3c14d',
  4: '#f0954d',
  5: '#f3608a'
}

// Mirrors .deck-builder__commander-art-bg in styles.css: a wide strip of the commander's own art
// on the right at low opacity, fading into the page background toward its own left edge — same
// visual signature the deck builder's own header already uses.
function drawHeader(
  doc: PDFKit.PDFDocument,
  deckName: string,
  totalCards: number,
  commanderArt: Buffer | null,
  logo: Buffer | null,
  pipImages: Buffer[],
  identityName: string,
  bracket: number | null,
  accountName: string | null
): void {
  const width = doc.page.width
  const headerHeight = 80
  const artBoxW = width * 0.7

  if (commanderArt) {
    const artX = width - artBoxW
    doc.save()
    doc.rect(artX, 0, artBoxW, headerHeight).clip()
    doc.opacity(0.24)
    try {
      // Biased well toward the image's own top (0 = top edge, 0.5 = dead center) — a plain
      // center crop was landing too low on a typical portrait composition.
      drawCoverImage(doc, commanderArt, artX, 0, artBoxW, headerHeight, 0.2)
    } catch {
      // A corrupt/undecodable image buffer shouldn't sink the whole export — just skip the art.
    }
    doc.opacity(1)
    const fade = doc.linearGradient(artX, 0, artX + artBoxW * 0.5, 0)
    fade.stop(0, BG, 1).stop(1, BG, 0)
    doc.rect(artX, 0, artBoxW, headerHeight).fill(fade)
    doc.restore()
  }

  // A small, fully-opaque brand mark in the header's own top-right corner — distinct from the
  // low-opacity commander art bleed behind it and the giant faded page watermark; this one's
  // just the logo, no wordmark, since "BiblioPLEX" already appears in the footer. Vertically
  // centered in the header band (equal gap above it and below it to the divider), same idea as
  // the "same gap between the top of the page and the divider" it was asked to match.
  if (logo) {
    const logoSize = 73
    const logoY = (headerHeight - logoSize) / 2
    try {
      doc.image(logo, width - MARGIN - logoSize, logoY, { width: logoSize, height: logoSize })
    } catch {
      // A corrupt/undecodable logo asset shouldn't sink the whole export.
    }
  }

  const titleFontSize = 19
  const titleY = 24
  doc.font('Helvetica-Bold').fontSize(titleFontSize)
  const nameW = doc.widthOfString(deckName)
  doc.fillColor(TEXT).text(deckName, MARGIN, titleY, { width: width - MARGIN * 2 })
  // Captured immediately after the title, before anything else touches doc.y: any absolutely-
  // positioned .text(str, x, y) call resets doc.y to that same y as a side effect of pdfkit's
  // own _initOptions (`if (y != null) this.y = y`), even when — like the bracket text just below
  // — it takes the non-wrapping code path that never advances y afterward. Reading doc.y *after*
  // drawing the bracket would silently pick up the bracket's own y (== titleY) instead of the
  // title's, collapsing the row below back onto the title line.
  const rowTop = doc.y + 4

  // Bracket sits directly after the deck name on its own row, sized to match it — the same
  // treatment the Decks list's own tiles give it, just paired with the title instead of a
  // separate line.
  if (bracket) {
    doc.font('Helvetica-Bold').fontSize(titleFontSize)
    doc.fillColor(BRACKET_COLORS[bracket] ?? MUTED).text(`Bracket ${bracket}`, MARGIN + nameW + 16, titleY, { lineBreak: false })
  }

  // "N cards // Identity" then the color-identity pips — vertically centered against each
  // other by hand: pdfkit positions text by its line-box top (== ascent above the baseline),
  // not by its visible glyph ink, so lining pips up with that box's nominal top/center leaves
  // them looking low against a small font's actual cap-height. Nudging the pips up by roughly
  // the gap between the line box and the cap-height center is what actually centers them.
  const rowFontSize = 9
  const pipSize = 12
  const textY = rowTop
  const pipY = textY - 3

  let cursorX = MARGIN
  doc.fillColor(MUTED).font('Helvetica').fontSize(rowFontSize)
  const summaryText = `${totalCards} cards${identityName ? ` // ${identityName}` : ''}`
  doc.text(summaryText, cursorX, textY, { lineBreak: false })
  cursorX += doc.widthOfString(summaryText) + 10

  for (const pip of pipImages) {
    doc.image(pip, cursorX, pipY, { width: pipSize, height: pipSize })
    cursorX += pipSize + 3
  }

  // The signed-in account's name, directly under the bracket — same column, same row as the
  // card-count line opposite it, same muted styling as that line.
  if (accountName) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(rowFontSize).text(`by ${accountName}`, MARGIN + nameW + 16, textY, { lineBreak: false })
  }

  // Edge to edge, not inset to the margins — a full-bleed accent line under the header band.
  doc.moveTo(0, headerHeight).lineTo(width, headerHeight).lineWidth(1).strokeColor(ACCENT).stroke()
  doc.y = headerHeight + 16
  doc.x = MARGIN
}

function drawSectionHeading(doc: PDFKit.PDFDocument, label: string, color: string, count: number, oneRowHeight: number): void {
  // Reserve room for the heading AND at least one full row beneath it, not just the heading on
  // its own — otherwise a heading can land as the very last thing on a page with every one of
  // its cards pushed onto the next, an orphaned header with a blank page underneath it.
  ensureSpace(doc, 20 + oneRowHeight)
  const y = doc.y
  // Same row-center approach as the header's pip row: the color bar is a plain rect (its visual
  // center is exactly its own box center), but the label text's visual (cap-height) center sits
  // noticeably below the nominal y pdfkit positions it by, so the two need different y's to
  // actually land on one shared center rather than each other's nominal top.
  const rowCenterY = y + 8
  doc.rect(MARGIN, rowCenterY - 6.5, 4, 13).fill(color)
  doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(13).text(label, MARGIN + 12, rowCenterY - 4.7, { continued: true })
  doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(`  (${count})`)
  doc.y = y + 20
  doc.x = MARGIN
}

function drawGrid(doc: PDFKit.PDFDocument, entries: DecklistPdfEntry[], images: Map<string, Buffer>, metrics: GridMetrics): void {
  const { columns, thumbW, thumbH, cellW, cellH } = metrics

  let col = 0
  let rowY = doc.y

  for (const entry of entries) {
    if (col === 0 && rowY + cellH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage()
      rowY = doc.y
    }

    const x = MARGIN + col * cellW
    const y = rowY

    doc.roundedRect(x, y, thumbW, thumbH, 4).fill(PANEL)
    const buffer = images.get(entry.imageUrl)
    if (buffer) {
      doc.save()
      doc.roundedRect(x, y, thumbW, thumbH, 4).clip()
      try {
        doc.image(buffer, x, y, { width: thumbW, height: thumbH, cover: [thumbW, thumbH], align: 'center', valign: 'center' })
      } catch {
        // Falls back to the plain panel background below — still labeled and still importable.
      }
      // A still "moment" of the app's own foil shimmer (.card-tile.is-foil::after in styles.css)
      // — same diagonal band, same white/pink/blue/yellow hues, just one fixed frame of it
      // instead of the app's animated color-dodge version (pdfkit has no blend-mode support to
      // reproduce color-dodge itself, so this is a plain-alpha approximation of the same look).
      // Confined to the card art rect, same as the app's own version sitting over the card image
      // only — there's no caption text underneath any more for it to wash out anyway.
      if (entry.foil) {
        const sheen = doc.linearGradient(x, y, x + thumbW, y + thumbH)
        sheen
          .stop(0, '#ffffff', 0)
          .stop(0.2, '#ffffff', 0)
          .stop(0.32, '#ffffff', 0.4)
          .stop(0.42, '#ff5ad2', 0.32)
          .stop(0.52, '#5ac8ff', 0.32)
          .stop(0.62, '#ffe15a', 0.32)
          .stop(0.75, '#ffffff', 0)
          .stop(1, '#ffffff', 0)
        doc.rect(x, y, thumbW, thumbH).fill(sheen)
      }
      doc.restore()
    }
    // Commanders get a colored frame instead of sitting in a separate section — this IS "first
    // card in the block," just visually flagged in place rather than pulled out.
    doc.roundedRect(x, y, thumbW, thumbH, 4)
      .lineWidth(entry.isCommander ? 2 : 0.75)
      .stroke(entry.isCommander ? ACCENT : BORDER)

    // Basic lands are the one card type where a count > 1 is completely routine, not a
    // noteworthy exception worth badging on every single one of them.
    if (entry.count > 1 && !entry.isBasicLand) {
      doc.font('Helvetica-Bold').fontSize(8)
      const badgeText = `x${entry.count}`
      const badgeW = doc.widthOfString(badgeText) + 8
      doc.roundedRect(x + thumbW - badgeW - 3, y + 3, badgeW, 13, 3).fill(ACCENT)
      doc.fillColor('#ffffff').text(badgeText, x + thumbW - badgeW - 3, y + 6, { width: badgeW, align: 'center' })
    }

    // No visible name caption under the card anymore — the art speaks for itself. This line
    // still exists, just invisible (zero opacity): Import Deck List (PDF) re-parses it with the
    // exact same regex the pasted "Detailed"/Moxfield formats use, so the sheet stays a working
    // decklist even though nothing under the thumbnail is meant to be read directly. No `width`,
    // and lineBreak: false besides — a `width` (even an omitted one defaults to one, unless
    // lineBreak is explicitly false; see _initOptions) routes text through pdfkit's LineWrapper,
    // which is where the actual "must never wrap" guarantee lives here.
    //
    // The tiny `col * 0.01` nudge on Y matters more than it looks: pdf-parse groups extracted
    // text into lines purely by exact Y equality, ignoring X entirely (see its render_page). Every
    // card in the same row now shares one Y here (nothing else at a different Y sits between them
    // any more, now that there's no visible caption to interrupt the run), so without this they'd
    // concatenate into one unparseable line instead of running from left to right.
    doc.fillOpacity(0)
    doc.text(
      `${entry.count} ${entry.name} (${entry.set.toUpperCase()}) ${entry.collectorNumber}${entry.foil ? ' *F*' : ''}`,
      x,
      y + thumbH + CAPTION_H + col * 0.01,
      { lineBreak: false }
    )
    doc.fillOpacity(1)

    col++
    if (col >= columns) {
      col = 0
      rowY += cellH
    }
  }

  doc.y = col === 0 ? rowY : rowY + cellH
  doc.x = MARGIN
}

export interface DecklistPdfOptions {
  deckName: string
  commanderArtUrl: string | null
  colorIdentity: string[]
  identityName: string
  bracket: number | null
  accountName: string | null
  groups: DecklistPdfGroup[]
}

export async function generateDecklistPdf(options: DecklistPdfOptions): Promise<Buffer> {
  const { deckName, commanderArtUrl, colorIdentity, identityName, bracket, accountName, groups } = options

  // Computed against the fixed page size directly, before a PDFDocument (and therefore
  // doc.page.width) exists — the thumbnail's actual draw size is what tells fetchImages how
  // large a source image is actually worth keeping (see resizeForEmbed).
  const metrics = computeGridMetrics(PAGE_WIDTH)
  const allUrls = groups.flatMap((g) => g.entries.map((e) => e.imageUrl))
  const artBoxW = PAGE_WIDTH * 0.7

  const logo = await loadLogo()
  const [images, commanderArt, pipImages, smallLogo] = await Promise.all([
    // 2.5x the draw size covers a couple of zoom levels in a PDF viewer without embedding far
    // more resolution than anyone will ever see.
    fetchImages(allUrls, Math.round(metrics.thumbW * 2.5)),
    commanderArtUrl ? fetchBuffer(commanderArtUrl).then((b) => (b ? resizeForEmbed(b, Math.round(artBoxW * 2), 82) : null)) : Promise.resolve(null),
    fetchColorPips(colorIdentity),
    logo ? resizeLogoIcon(logo, 120) : Promise.resolve(null)
  ])

  const doc = new PDFDocument({ margin: MARGIN, size: [PAGE_WIDTH, PAGE_HEIGHT], autoFirstPage: false })
  doc.addPage()
  // addPage() resets doc.x/doc.y to the fresh page's top-left BEFORE emitting 'pageAdded' (see
  // pdfkit.js) — but drawFooter's own .text() call moves doc.y again as a side effect, so every
  // page-break-triggering call site that reads doc.y right after doc.addPage() (drawGrid,
  // drawSectionHeading's ensureSpace) would silently pick up the footer's position instead of
  // the page top. Putting the cursor back is this listener's job, not each call site's.
  doc.on('pageAdded', () => {
    paintPageBackground(doc, logo)
    drawFooter(doc, smallLogo)
    doc.x = doc.page.margins.left
    doc.y = doc.page.margins.top
  })
  paintPageBackground(doc, logo)
  drawFooter(doc, smallLogo)
  // First page only: the listener above handles every later page, but it wasn't registered yet
  // when the addPage() call above fired — same reset it does, for the same reason.
  doc.x = doc.page.margins.left
  doc.y = doc.page.margins.top

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  const totalCards = groups.reduce((sum, g) => sum + g.entries.reduce((s, e) => s + e.count, 0), 0)
  drawHeader(doc, deckName, totalCards, commanderArt, smallLogo, pipImages, identityName, bracket, accountName)

  for (const group of groups) {
    if (group.entries.length === 0) continue
    const groupCount = group.entries.reduce((s, e) => s + e.count, 0)
    drawSectionHeading(doc, group.label, group.color, groupCount, metrics.cellH)
    drawGrid(doc, group.entries, images, metrics)
    doc.y += 10
  }

  doc.end()
  return finished
}

/** Pulls plain text out of a PDF for Import Deck List (PDF) — works on any PDF, but only one
 *  produced by this app's own Export Deck List (PDF) actually contains lines the renderer's
 *  detailed-line parser can resolve back into cards (see the invisible round-trip line drawGrid
 *  writes under each thumbnail). */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer)
  return parsed.text
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Deck'
}
