import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useCardNameAutocomplete } from '../useCardNameAutocomplete'
import { SCHOOL_PAIRS } from '../schools'
import { colorIdentityGradient } from '../colorIdentityName'
import { isSoundMuted, setSoundMuted } from '../soundSettings'
import { notifyAccountChanged } from '../accountEvents'
import { getIndexBuildSnapshot, startCardTagBuild, startComboBuild, subscribeToIndexBuilds } from '../indexBuildStore'
import { t, useLocale } from '../i18n'

interface CardTagIndexStatus {
  builtAt: string | null
  count: number
}

interface ComboIndexStatus {
  builtAt: string | null
  variantCount: number
  comboCardCount: number
  stale: boolean
}

export type ProfilePicture =
  | { type: 'card'; cardName: string; imageUrl: string }
  | { type: 'upload'; dataUrl: string }

export interface Account {
  id: string
  username: string
  profilePicture: ProfilePicture | null
  school: string | null
  createdAt: string
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

function pictureUrl(picture: ProfilePicture | null): string | null {
  if (!picture) return null
  return picture.type === 'card' ? picture.imageUrl : picture.dataUrl
}

function Avatar({ account, size = 32 }: { account: Account | null; size?: number }) {
  const url = pictureUrl(account?.profilePicture ?? null)
  return (
    <span
      className="account-avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, backgroundImage: url ? `url(${url})` : undefined }}
    >
      {!url && (account?.username?.[0]?.toUpperCase() ?? '?')}
    </span>
  )
}

// A local, password-less "base" for accounts — this is the profile layer only (see
// src/main/accounts.ts): unique username, a profile picture from either card art or an
// uploaded image. There's no server yet, so "signing in" just means picking/creating one of
// the profiles ever created on this install; a real (e.g. Google) sign-in can slot in later as
// another way to arrive at one of these same Account records.
export default function AccountPanel() {
  useLocale()
  const [current, setCurrent] = useState<Account | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'switch' | 'create' | 'edit'>('switch')
  const [loading, setLoading] = useState(true)

  const [newUsername, setNewUsername] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [usernameDraft, setUsernameDraft] = useState('')
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [savingUsername, setSavingUsername] = useState(false)

  const [pictureTab, setPictureTab] = useState<'card' | 'upload'>('card')
  const [cardQuery, setCardQuery] = useState('')
  const [cardDropdownPos, setCardDropdownPos] = useState<{ x: number; y: number } | null>(null)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [pictureSaving, setPictureSaving] = useState(false)
  const cardInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardAutocomplete = useCardNameAutocomplete(cardQuery)
  const [schoolSaving, setSchoolSaving] = useState(false)
  const [soundMuted, setSoundMutedState] = useState(() => isSoundMuted())

  // Card Tag Index / Combo Index rebuilds — moved here from Tag Search (see that view's own
  // comment) so they're a deliberate, out-of-the-way maintenance action rather than a button
  // sitting right next to a search box someone could click by accident. The actual build still
  // runs through the same module-level store Tag Search's progress bar reads from, so kicking
  // one off here and switching to Tag Search still shows it in progress there too.
  const [indexStatus, setIndexStatus] = useState<CardTagIndexStatus | null>(null)
  const [comboStatus, setComboStatus] = useState<ComboIndexStatus | null>(null)
  const [pendingIndexBuild, setPendingIndexBuild] = useState<'cardTag' | 'combo' | null>(null)
  const buildState = useSyncExternalStore(subscribeToIndexBuilds, getIndexBuildSnapshot)
  const building = buildState.cardTag.building
  const buildError = buildState.cardTag.error
  const comboBuilding = buildState.combo.building
  const comboBuildError = buildState.combo.error

  useEffect(() => {
    window.api.getCardTagIndexStatus().then(setIndexStatus)
    window.api.getComboIndexStatus().then(setComboStatus)
  }, [])

  const wasCardTagBuilding = useRef(building)
  useEffect(() => {
    if (wasCardTagBuilding.current && !building) window.api.getCardTagIndexStatus().then(setIndexStatus)
    wasCardTagBuilding.current = building
  }, [building])

  const wasComboBuilding = useRef(comboBuilding)
  useEffect(() => {
    if (wasComboBuilding.current && !comboBuilding) window.api.getComboIndexStatus().then(setComboStatus)
    wasComboBuilding.current = comboBuilding
  }, [comboBuilding])

  function confirmPendingIndexBuild(): void {
    if (pendingIndexBuild === 'cardTag') startCardTagBuild()
    else if (pendingIndexBuild === 'combo') startComboBuild()
    setPendingIndexBuild(null)
  }

  async function refresh(): Promise<void> {
    const [cur, list] = await Promise.all([window.api.getCurrentAccount(), window.api.listAccounts()])
    setCurrent(cur as Account | null)
    setAccounts(list as Account[])
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!cardDropdownPos) return
    function handleScroll(): void {
      setCardDropdownPos(null)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [cardDropdownPos])

  function openPanel(): void {
    setCreateError(null)
    setNewUsername('')
    if (current) {
      setMode('edit')
      setUsernameDraft(current.username)
      setUsernameError(null)
      setPictureError(null)
      setPictureTab('card')
      setCardQuery('')
    } else {
      setMode(accounts.length > 0 ? 'switch' : 'create')
    }
    setOpen(true)
  }

  async function handleCreate(): Promise<void> {
    setCreating(true)
    setCreateError(null)
    try {
      const account = (await window.api.createAccount(newUsername)) as Account
      setCurrent(account)
      notifyAccountChanged()
      await refresh()
      setMode('edit')
      setUsernameDraft(account.username)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleSwitch(id: string): Promise<void> {
    const account = (await window.api.switchAccount(id)) as Account
    setCurrent(account)
    notifyAccountChanged()
    setMode('edit')
    setUsernameDraft(account.username)
    setUsernameError(null)
  }

  async function handleSignOut(): Promise<void> {
    await window.api.signOutAccount()
    setCurrent(null)
    notifyAccountChanged()
    setOpen(false)
  }

  async function handleSaveUsername(): Promise<void> {
    if (!current) return
    setSavingUsername(true)
    setUsernameError(null)
    try {
      const account = (await window.api.setUsername(current.id, usernameDraft)) as Account
      setCurrent(account)
      notifyAccountChanged()
      await refresh()
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingUsername(false)
    }
  }

  async function handlePickCardArt(name: string): Promise<void> {
    if (!current) return
    setCardDropdownPos(null)
    setCardQuery('')
    setPictureSaving(true)
    setPictureError(null)
    try {
      const account = (await window.api.setProfilePictureCard(current.id, name)) as Account
      setCurrent(account)
      notifyAccountChanged()
      await refresh()
    } catch (err) {
      setPictureError(err instanceof Error ? err.message : String(err))
    } finally {
      setPictureSaving(false)
    }
  }

  async function handleUploadFile(file: File): Promise<void> {
    if (!current) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setPictureError(t('account.imageTooLarge'))
      return
    }
    setPictureSaving(true)
    setPictureError(null)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error ?? new Error(t('account.couldNotReadFile')))
        reader.readAsDataURL(file)
      })
      const account = (await window.api.setProfilePictureUpload(current.id, dataUrl)) as Account
      setCurrent(account)
      notifyAccountChanged()
      await refresh()
    } catch (err) {
      setPictureError(err instanceof Error ? err.message : String(err))
    } finally {
      setPictureSaving(false)
    }
  }

  async function handleSetSchool(name: string): Promise<void> {
    if (!current) return
    const next = current.school === name ? null : name
    setSchoolSaving(true)
    try {
      const account = (await window.api.setSchool(current.id, next)) as Account
      setCurrent(account)
      notifyAccountChanged()
      await refresh()
    } finally {
      setSchoolSaving(false)
    }
  }

  function toggleSoundMuted(): void {
    const next = !soundMuted
    setSoundMuted(next)
    setSoundMutedState(next)
  }

  const cardMatches = useMemo(() => cardAutocomplete.names.slice(0, 8), [cardAutocomplete.names])

  if (loading) return null

  return (
    <>
      <button className="account-widget" onClick={openPanel}>
        <Avatar account={current} />
        <span className="account-widget__label">{current ? current.username : t('account.buttonDefault')}</span>
      </button>

      {open && (
        <div className="card-detail-overlay" onClick={() => setOpen(false)}>
          <div className="account-modal" onClick={(e) => e.stopPropagation()}>
            <button className="card-detail__close" onClick={() => setOpen(false)}>
              ×
            </button>

            {mode === 'switch' && (
              <>
                <h3 className="section-heading" style={{ marginTop: 0 }}>
                  {t('account.chooseProfile')}
                </h3>
                <div className="account-list">
                  {accounts.map((account) => (
                    <button key={account.id} className="account-list__item" onClick={() => handleSwitch(account.id)}>
                      <Avatar account={account} size={40} />
                      <span>{account.username}</span>
                    </button>
                  ))}
                </div>
                <button className="secondary-button" style={{ marginTop: 12 }} onClick={() => setMode('create')}>
                  + {t('account.createProfile')}
                </button>
              </>
            )}

            {mode === 'create' && (
              <>
                <h3 className="section-heading" style={{ marginTop: 0 }}>
                  {t('account.createProfileHeading')}
                </h3>
                <input
                  type="text"
                  className="filter-text"
                  placeholder={t('account.usernamePlaceholder')}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  autoFocus
                />
                <p className="app__hint">{t('account.usernameHint')}</p>
                {createError && <p className="app__error">{createError}</p>}
                <div className="export-deck-modal__actions">
                  {accounts.length > 0 && (
                    <button className="secondary-button" onClick={() => setMode('switch')}>
                      {t('account.back')}
                    </button>
                  )}
                  <button className="primary-button" onClick={handleCreate} disabled={creating || !newUsername.trim()}>
                    {creating ? t('account.creating') : t('account.createProfile')}
                  </button>
                </div>
              </>
            )}

            {mode === 'edit' && current && (
              <>
                <h3 className="section-heading" style={{ marginTop: 0 }}>
                  {t('account.yourProfile')}
                </h3>

                <div className="account-edit__picture-row">
                  <Avatar account={current} size={72} />
                  <div className="account-edit__picture-tabs">
                    <button
                      className={`secondary-button ${pictureTab === 'card' ? 'is-active' : ''}`}
                      onClick={() => setPictureTab('card')}
                    >
                      {t('account.cardArt')}
                    </button>
                    <button
                      className={`secondary-button ${pictureTab === 'upload' ? 'is-active' : ''}`}
                      onClick={() => setPictureTab('upload')}
                    >
                      {t('account.uploadImage')}
                    </button>
                  </div>
                </div>

                {pictureTab === 'card' && (
                  <div className="account-edit__card-search">
                    <input
                      ref={cardInputRef}
                      type="text"
                      className="filter-text"
                      placeholder={t('home.searchPlaceholder')}
                      value={cardQuery}
                      onChange={(e) => {
                        setCardQuery(e.target.value)
                        const rect = cardInputRef.current?.getBoundingClientRect()
                        if (rect) setCardDropdownPos({ x: rect.left, y: rect.bottom + 4 })
                      }}
                      onFocus={() => {
                        const rect = cardInputRef.current?.getBoundingClientRect()
                        if (rect) setCardDropdownPos({ x: rect.left, y: rect.bottom + 4 })
                      }}
                      onBlur={() => window.setTimeout(() => setCardDropdownPos(null), 150)}
                    />
                    {cardDropdownPos &&
                      cardMatches.length > 0 &&
                      createPortal(
                        <div className="tag-name-dropdown" style={{ top: cardDropdownPos.y, left: cardDropdownPos.x }}>
                          {cardMatches.map((name) => (
                            <button
                              key={name}
                              className="tag-name-dropdown__item"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                handlePickCardArt(name)
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>,
                        document.body
                      )}
                  </div>
                )}

                {pictureTab === 'upload' && (
                  <div className="account-edit__upload">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleUploadFile(file)
                        e.target.value = ''
                      }}
                    />
                    <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                      {t('account.chooseImage')}
                    </button>
                    <p className="app__hint">{t('account.uploadHint')}</p>
                  </div>
                )}

                {pictureSaving && <p className="app__hint">{t('account.updatingPicture')}</p>}
                {pictureError && <p className="app__error">{pictureError}</p>}

                <h4 className="account-edit__section-label">
                  {t('account.school')} {schoolSaving && <span className="app__hint">{t('account.saving')}</span>}
                </h4>
                <div className="account-school-columns">
                  <span>Hexhaven</span>
                  <span>Strixhaven</span>
                </div>
                <div className="account-school-grid">
                  {SCHOOL_PAIRS.flat().map((school) => (
                    <button
                      key={school.name}
                      className={`account-school ${current.school === school.name ? 'is-active' : ''}`}
                      onClick={() => handleSetSchool(school.name)}
                      title={t('account.schoolTitle', { colors: school.colors.join('/') })}
                    >
                      <span
                        className="account-school__swatch"
                        style={{ background: colorIdentityGradient(school.colors) }}
                      />
                      {school.name}
                    </button>
                  ))}
                </div>

                <h4 className="account-edit__section-label">{t('account.sounds')}</h4>
                <button className="secondary-button" onClick={toggleSoundMuted}>
                  {soundMuted ? t('account.soundsMuted') : t('account.soundsOn')}
                </button>

                <h4 className="account-edit__section-label">Card Data</h4>
                <div className="account-edit__index-row">
                  {indexStatus?.builtAt ? (
                    <p className="app__hint">
                      Card Tag Index built {new Date(indexStatus.builtAt).toLocaleString()} ·{' '}
                      {indexStatus.count.toLocaleString()} cards
                    </p>
                  ) : (
                    <p className="app__hint">No Card Tag Index yet — needed for Tag Search.</p>
                  )}
                  <button
                    className="secondary-button"
                    onClick={() => setPendingIndexBuild('cardTag')}
                    disabled={building}
                  >
                    {building ? 'Building…' : indexStatus?.builtAt ? 'Rebuild' : 'Build'}
                  </button>
                </div>
                {buildError && <p className="app__error">{buildError}</p>}
                <div className="account-edit__index-row">
                  {comboStatus?.builtAt ? (
                    <p className="app__hint">
                      Combo Index built {new Date(comboStatus.builtAt).toLocaleString()} ·{' '}
                      {comboStatus.comboCardCount.toLocaleString()} combo-heavy cards
                      {comboStatus.stale ? ' · out of date' : ''}
                    </p>
                  ) : (
                    <p className="app__hint">No Combo Index yet — needed for the "Combo" tag.</p>
                  )}
                  <button
                    className="secondary-button"
                    onClick={() => setPendingIndexBuild('combo')}
                    disabled={comboBuilding}
                  >
                    {comboBuilding ? 'Crawling…' : comboStatus?.builtAt ? 'Rebuild' : 'Build'}
                  </button>
                </div>
                {comboBuildError && <p className="app__error">{comboBuildError}</p>}

                <div className="account-edit__username-row">
                  <input
                    type="text"
                    className="filter-text"
                    value={usernameDraft}
                    onChange={(e) => setUsernameDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveUsername()}
                  />
                  <button
                    className="secondary-button"
                    onClick={handleSaveUsername}
                    disabled={savingUsername || usernameDraft.trim() === current.username}
                  >
                    {savingUsername ? t('account.saving') : t('account.save')}
                  </button>
                </div>
                {usernameError && <p className="app__error">{usernameError}</p>}

                <div className="export-deck-modal__actions">
                  {accounts.length > 1 && (
                    <button className="secondary-button" onClick={() => setMode('switch')}>
                      {t('account.switchProfile')}
                    </button>
                  )}
                  <button className="secondary-button" onClick={handleSignOut}>
                    {t('account.signOut')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingIndexBuild && (
        <div className="card-detail-overlay" onClick={() => setPendingIndexBuild(null)}>
          <div className="account-modal account-modal--confirm" onClick={(e) => e.stopPropagation()}>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              {pendingIndexBuild === 'cardTag' ? 'Rebuild Card Tag Index?' : 'Rebuild Combo Index?'}
            </h3>
            <p className="app__hint">
              {pendingIndexBuild === 'cardTag'
                ? "This downloads and processes Scryfall's card database — it can take a few minutes."
                : 'This crawls every combo Commander Spellbook knows about — it can take a few minutes.'}
            </p>
            <div className="export-deck-modal__actions">
              <button className="secondary-button" onClick={() => setPendingIndexBuild(null)}>
                Cancel
              </button>
              <button className="primary-button" onClick={confirmPendingIndexBuild}>
                Start
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
