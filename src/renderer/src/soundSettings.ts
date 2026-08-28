// A device-level preference, not an account one — kept in localStorage (same pattern as the
// Decks/Precons lists' "Simplified View" toggle) rather than on the Account record, since
// whether this machine makes noise isn't really part of "who's signed in." The toggle itself
// still lives in the account settings panel, per how it was asked for.
const MUTED_KEY = 'mtgplatform.soundsMuted'

export function isSoundMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1'
}

export function setSoundMuted(muted: boolean): void {
  localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
}
