import { useEffect, useState } from 'react'

// The app runs fully frameless (see frame:false in main/index.ts) so these are the *only*
// minimize/maximize/close controls that exist — Windows' titleBarOverlay was tried first, but
// its native buttons have an OS-enforced minimum height (~32px) that can't be shrunk below,
// which is exactly what was wanted here.
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.api.isWindowMaximized().then(setMaximized)
    return window.api.onWindowMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button className="window-controls__button" onClick={() => window.api.minimizeWindow()} aria-label="Minimize">
        <svg viewBox="0 0 10 10" width="10" height="10">
          <path d="M0 5H10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className="window-controls__button"
        onClick={() => window.api.toggleMaximizeWindow()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M2 0H10V8" stroke="currentColor" strokeWidth="1" fill="none" />
            <path d="M0 2H8V10H0Z" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" width="10" height="10">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button
        className="window-controls__button window-controls__button--close"
        onClick={() => window.api.closeWindow()}
        aria-label="Close"
      >
        <svg viewBox="0 0 10 10" width="10" height="10">
          <path d="M0 0L10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
