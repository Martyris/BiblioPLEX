import { useEffect, useRef, useState } from 'react'
import Logo from './Logo'
import { getCounterpartSchool, getSchool, isHexhavenSchool, schoolGlowColors, type SchoolInfo } from '../schools'
import { playPressSound, playReleaseSound, playScrambleSound } from '../clickSound'
import { scrambleTransition } from '../scrambleText'
import { onAccountChanged } from '../accountEvents'
import { t, useLocale } from '../i18n'
import type { UpdateInfo } from '../types'

type Tab = 'home' | 'search' | 'sets' | 'tokens' | 'commander' | 'precons' | 'decks'

interface Props {
  onNavigate: (tab: Tab) => void
  onSearch: (query: string) => void
}

interface QuickLink {
  tab: Tab
  labelKey: string
  glyph: string
  color: string
}

const QUICK_LINKS: QuickLink[] = [
  { tab: 'search', labelKey: 'nav.search', glyph: '🔍', color: '#4fd8c4' },
  { tab: 'sets', labelKey: 'nav.sets', glyph: '📚', color: '#9fb8d9' },
  { tab: 'tokens', labelKey: 'nav.tokens', glyph: '🪙', color: '#e6c229' },
  { tab: 'commander', labelKey: 'nav.commander', glyph: '👑', color: '#b388ff' },
  { tab: 'precons', labelKey: 'nav.precons', glyph: '📦', color: '#f0824f' },
  { tab: 'decks', labelKey: 'nav.decks', glyph: '🗂️', color: '#7ee787' }
]

interface AccountLite {
  id: string
  username: string
  school: string | null
}

// Easter egg: click the logo rapidly enough and the student transfers to their school's
// "twisted" counterpart (see getCounterpartSchool). Both numbers are deliberately easy to find
// and retune here.
const TRANSFER_CLICK_THRESHOLD = 20
const TRANSFER_CLICK_WINDOW_MS = 4000
const TRANSFER_DURATION_MS = 1100

// The Home hero's big brand mark reads "BIBLIOplex" (caps inverted) by default for Hexhaven
// students — a quiet signal that mirrors the twisted-counterpart theme — and the ordinary
// "BiblioPLEX" for everyone else (Strixhaven students, undeclared students, and guests).
const BRAND_TITLE = 'BiblioPLEX'
const BRAND_TITLE_HEXHAVEN = 'BIBLIOplex'

function brandTitleFor(schoolName: string | null | undefined): string {
  return isHexhavenSchool(schoolName) ? BRAND_TITLE_HEXHAVEN : BRAND_TITLE
}

function welcomeSentence(username: string, schoolName: string, brandTitle: string): string {
  return t('home.welcomeBackStudent', { brand: brandTitle, username, school: schoolName })
}

export default function HomeView({ onNavigate, onSearch }: Props) {
  useLocale()
  const [account, setAccount] = useState<AccountLite | null>(null)
  const [query, setQuery] = useState('')
  const [logoPressed, setLogoPressed] = useState(false)

  const [transferTo, setTransferTo] = useState<SchoolInfo | null>(null)
  const [transferProgress, setTransferProgress] = useState(0)
  const [scrambledTagline, setScrambledTagline] = useState<string | null>(null)
  const [scrambledMotto, setScrambledMotto] = useState<string | null>(null)
  const [scrambledTitle, setScrambledTitle] = useState<string | null>(null)
  const clickTimestamps = useRef<number[]>([])
  const cancelTaglineScramble = useRef<(() => void) | null>(null)
  const cancelMottoScramble = useRef<(() => void) | null>(null)
  const cancelTitleScramble = useRef<(() => void) | null>(null)

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateStage, setUpdateStage] = useState<'idle' | 'downloading' | 'ready' | 'error'>('idle')
  const [updateProgress, setUpdateProgress] = useState(0)
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    function loadAccount(): void {
      window.api.getCurrentAccount().then((a) => !cancelled && setAccount(a as AccountLite | null))
    }
    loadAccount()
    // AccountPanel is a persistent header overlay, not a tab — picking a school there while
    // already on Home never unmounts this component, so without this it would keep showing
    // whatever account state it fetched on mount.
    const unsubscribe = onAccountChanged(loadAccount)
    return () => {
      cancelled = true
      unsubscribe()
      cancelTaglineScramble.current?.()
      cancelMottoScramble.current?.()
      cancelTitleScramble.current?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.checkForUpdate().then((info) => {
      if (!cancelled && info) setUpdateInfo(info)
    })
    const unsubscribe = window.api.onUpdateProgress(({ received, total }) => {
      if (total > 0) setUpdateProgress(received / total)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function handleDownloadUpdate(): Promise<void> {
    if (!updateInfo) return
    setUpdateStage('downloading')
    setUpdateProgress(0)
    setUpdateError(null)
    try {
      const path = await window.api.downloadUpdate(updateInfo)
      setDownloadedUpdatePath(path)
      setUpdateStage('ready')
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
      setUpdateStage('error')
    }
  }

  function handleInstallUpdate(): void {
    if (downloadedUpdatePath) window.api.installUpdate(downloadedUpdatePath)
  }

  const school = getSchool(account?.school)
  const [glowA, glowB] = school ? schoolGlowColors(school) : []

  function triggerSchoolTransfer(): void {
    if (!account || !school) return
    const counterpart = getCounterpartSchool(school.name)
    if (!counterpart) return

    cancelTaglineScramble.current?.()
    cancelMottoScramble.current?.()
    cancelTitleScramble.current?.()

    setTransferTo(counterpart)
    setTransferProgress(0)
    playScrambleSound(TRANSFER_DURATION_MS)

    const fromSentence = welcomeSentence(account.username, school.name, brandTitleFor(school.name))
    const toSentence = welcomeSentence(account.username, counterpart.name, brandTitleFor(counterpart.name))

    cancelTitleScramble.current = scrambleTransition(
      brandTitleFor(school.name),
      brandTitleFor(counterpart.name),
      TRANSFER_DURATION_MS,
      (text) => setScrambledTitle(text),
      () => {}
    )

    cancelTaglineScramble.current = scrambleTransition(
      fromSentence,
      toSentence,
      TRANSFER_DURATION_MS,
      (text, progress) => {
        setScrambledTagline(text)
        setTransferProgress(progress)
      },
      () => {}
    )

    cancelMottoScramble.current = scrambleTransition(
      school.motto,
      counterpart.motto,
      TRANSFER_DURATION_MS,
      (text) => setScrambledMotto(text),
      () => {
        window.api.setSchool(account.id, counterpart.name)
        setAccount((prev) => (prev ? { ...prev, school: counterpart.name } : prev))
        setTransferTo(null)
        setScrambledTagline(null)
        setScrambledMotto(null)
        setScrambledTitle(null)
      }
    )
  }

  // Held for exactly as long as the mouse button is down, not a fixed-length animation — the
  // release listener lives on window (not the image) so letting go after dragging off the logo
  // still counts as a release instead of leaving it stuck in the pressed state.
  function handleLogoPointerDown(): void {
    setLogoPressed(true)
    playPressSound()
    const handleRelease = (): void => {
      setLogoPressed(false)
      playReleaseSound()
      window.removeEventListener('pointerup', handleRelease)
      window.removeEventListener('pointercancel', handleRelease)
    }
    window.addEventListener('pointerup', handleRelease)
    window.addEventListener('pointercancel', handleRelease)

    if (!transferTo) {
      const now = Date.now()
      const recent = [...clickTimestamps.current, now].filter((t) => now - t <= TRANSFER_CLICK_WINDOW_MS)
      clickTimestamps.current = recent
      if (recent.length >= TRANSFER_CLICK_THRESHOLD) {
        clickTimestamps.current = []
        triggerSchoolTransfer()
      }
    }
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    const trimmed = query.trim()
    if (trimmed) onSearch(trimmed)
  }

  return (
    <div className="home">
      {updateInfo && (
        <div className="update-banner">
          <span className="update-banner__text">
            {updateStage === 'ready'
              ? `BiblioPLEX ${updateInfo.version} is downloaded and ready to install.`
              : `A new version of BiblioPLEX is available — v${updateInfo.version}.`}
          </span>
          {updateStage === 'idle' && (
            <button className="primary-button update-banner__button" onClick={handleDownloadUpdate}>
              Download Update
            </button>
          )}
          {updateStage === 'downloading' && (
            <div className="update-banner__progress" role="progressbar" aria-valuenow={Math.round(updateProgress * 100)}>
              <div className="update-banner__progress-fill" style={{ width: `${Math.round(updateProgress * 100)}%` }} />
              <span className="update-banner__progress-label">{Math.round(updateProgress * 100)}%</span>
            </div>
          )}
          {updateStage === 'ready' && (
            <button className="primary-button update-banner__button" onClick={handleInstallUpdate}>
              Restart &amp; Update
            </button>
          )}
          {updateStage === 'error' && (
            <span className="update-banner__error">
              Update failed{updateError ? `: ${updateError}` : ''} — try again later.
            </span>
          )}
        </div>
      )}

      <section className="home-hero">
        <div className="home-logo-stage">
          <Logo
            size={264}
            className={`home-logo ${logoPressed ? 'is-pressed' : ''}`}
            school={account?.school}
            style={glowA ? ({ '--glow-a': glowA, '--glow-b': glowB } as React.CSSProperties) : undefined}
            onPointerDown={handleLogoPointerDown}
          />
          {transferTo &&
            (() => {
              const [toGlowA, toGlowB] = schoolGlowColors(transferTo)
              return (
                <Logo
                  size={264}
                  className="home-logo home-logo--overlay"
                  school={transferTo.name}
                  style={
                    {
                      '--glow-a': toGlowA,
                      '--glow-b': toGlowB,
                      opacity: transferProgress
                    } as React.CSSProperties
                  }
                />
              )
            })()}
        </div>
        <h1 className="home-hero__title">{scrambledTitle ?? brandTitleFor(account?.school)}</h1>
        <p className="home-hero__tagline">
          {scrambledTagline !== null ? (
            <>
              {scrambledTagline} <em className="home-hero__motto">&ldquo;{scrambledMotto}&rdquo;</em>
            </>
          ) : account ? (
            school ? (
              <>
                {welcomeSentence(account.username, school.name, brandTitleFor(school.name))}{' '}
                <em className="home-hero__motto">&ldquo;{school.motto}&rdquo;</em>
              </>
            ) : (
              t('home.welcomeBack', { brand: BRAND_TITLE, username: account.username })
            )
          ) : (
            t('home.welcomeGuest')
          )}
        </p>
      </section>

      <form className="home-search" onSubmit={handleSubmit}>
        <span className="home-search__icon" aria-hidden="true">
          🔍
        </span>
        <input
          type="text"
          className="home-search__input"
          placeholder={t('home.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>

      <nav className="home-tabs">
        {QUICK_LINKS.map((link) => (
          <button
            key={link.tab}
            className="home-tab"
            style={{ '--home-tab-color': link.color } as React.CSSProperties}
            onClick={() => onNavigate(link.tab)}
          >
            <span className="home-tab__glyph">{link.glyph}</span>
            {t(link.labelKey)}
          </button>
        ))}
      </nav>

      <p className="home-attribution__foss">
        BiblioPLEX is a free{' '}
        <a
          href="https://github.com/Martyris/BiblioPLEX"
          target="_blank"
          rel="noreferrer"
          className="home-attribution__foss-link"
        >
          open source
        </a>{' '}
        platform, now and always.
      </p>

      {/* Text credits rather than each service's actual logo image — Scryfall's own data-usage
          guidelines explicitly forbid using their logo/name in any way that could read as an
          endorsement, and Wizards' Fan Content Policy flatly bans using Wizards' logos and
          trademarks at all, so a plain named link is the compliant choice for every entry here,
          not just a style preference. */}
      <div className="home-attribution">
        <span className="home-attribution__label">Powered by</span>
        <a href="https://scryfall.com" target="_blank" rel="noreferrer" className="home-attribution__link">
          Scryfall
        </a>
        <a href="https://edhrec.com" target="_blank" rel="noreferrer" className="home-attribution__link">
          EDHREC
        </a>
        <a
          href="https://commanderspellbook.com"
          target="_blank"
          rel="noreferrer"
          className="home-attribution__link"
        >
          Commander Spellbook
        </a>
        <a href="https://github.com/magefree/mage" target="_blank" rel="noreferrer" className="home-attribution__link">
          XMage
        </a>
      </div>
      <p className="home-attribution__legal">
        BiblioPLEX is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by
        Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
      </p>
    </div>
  )
}
