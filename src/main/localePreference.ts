// Mirrors the renderer's i18n locale (see src/renderer/src/i18n.ts, which is the source of
// truth — persisted in that process's localStorage) so main-process code — specifically
// scryfall.ts's card-image localization — knows which language is active without every single
// IPC call needing a `locale` parameter threaded through it. The renderer pushes changes here
// via the `locale:set` IPC handler (see index.ts) whenever it switches, plus once on launch to
// sync the persisted preference.
let currentLocale = 'en'

export function setMainLocale(locale: string): void {
  currentLocale = locale
}

export function getMainLocale(): string {
  return currentLocale
}
