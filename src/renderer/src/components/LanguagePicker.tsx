import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LANGUAGES, getLocale, setLocale, useLocale } from '../i18n'

// The flag button next to the account widget — picks the device-level UI language (see
// i18n.ts). Same portaled position:fixed dropdown pattern used everywhere else in this app
// (CardTagsPanel's tag autocomplete, the Decks/Precons "⋮" menus), anchored from the right edge
// since this sits near the far-right window controls.
export default function LanguagePicker() {
  useLocale()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = LANGUAGES.find((l) => l.locale === getLocale()) ?? LANGUAGES[0]

  useEffect(() => {
    if (!open) return
    function handleScroll(): void {
      setOpen(false)
    }
    document.addEventListener('scroll', handleScroll, true)
    return () => document.removeEventListener('scroll', handleScroll, true)
  }, [open])

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setPos({ right: window.innerWidth - rect.right, top: rect.bottom + 4 })
    setOpen(true)
  }

  return (
    <>
      <button ref={buttonRef} className="language-picker" onClick={toggle} title={current.label}>
        {current.flag}
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div
              className="tag-menu-backdrop"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
            />
            <div className="tag-name-dropdown" style={{ top: pos.top, right: pos.right, left: 'auto' }}>
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.locale}
                  className="tag-name-dropdown__item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setLocale(lang.locale)
                    setOpen(false)
                  }}
                >
                  {lang.flag} {lang.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
