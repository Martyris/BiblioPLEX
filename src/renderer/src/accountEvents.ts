// AccountPanel (the header widget) and HomeView both hold their own independent copy of "the
// current account" — AccountPanel is a persistent overlay that outlives tab switches, so
// picking a school there while already on the Home tab never unmounts/remounts HomeView, and
// its stale fetched account would otherwise just sit there unchanged. Rather than lifting
// account state up into a shared store, AccountPanel just announces "something changed" here
// and anything that cares (HomeView) refetches.
const EVENT_NAME = 'biblioplex:account-changed'

export function notifyAccountChanged(): void {
  window.dispatchEvent(new Event(EVENT_NAME))
}

export function onAccountChanged(callback: () => void): () => void {
  window.addEventListener(EVENT_NAME, callback)
  return () => window.removeEventListener(EVENT_NAME, callback)
}
