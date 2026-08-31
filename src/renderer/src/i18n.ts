import { useEffect, useState } from 'react'

// Pilot scope: header/nav + the Home page only (see HomeView.tsx, App.tsx). Every other
// component still has hardcoded English strings — this proves the plumbing (a key/dictionary
// lookup, a device-level preference, a picker in the header) before translating the rest of the
// app key-by-key. A lightweight hand-rolled t()/dictionary rather than a library (react-intl,
// i18next) to match how the rest of this app avoids dependencies for things a ~15-line function
// covers (see clickSound.ts, soundSettings.ts for the same instinct).
export type Locale = 'en' | 'pt-BR'

type Dictionary = Record<string, string>

const en: Dictionary = {
  'nav.home': 'Home',
  'nav.search': 'Search',
  'nav.sets': 'Sets',
  'nav.tokens': 'Tokens',
  'nav.commander': 'Commander',
  'nav.precons': 'Precons',
  'nav.decks': 'Decks',
  'nav.playtest': 'Simulation',
  'search.placeholder': 'Search cards (name, or use filters below)',
  'home.searchPlaceholder': 'Search for a card by name…',
  'home.welcomeGuest':
    'Welcome esteemed guest, to the BiblioPLEX, all of those who seek knowledge are welcome, even if they are not yet enrolled.',
  'home.welcomeBack': 'Welcome back to the {brand}, {username}.',
  'home.welcomeBackStudent': 'Welcome back to the {brand}, {username}, student of {school}.',

  'account.buttonDefault': 'Profile',
  'account.chooseProfile': 'Choose a profile',
  'account.createProfile': 'Create Profile',
  'account.createProfileHeading': 'Create a profile',
  'account.usernamePlaceholder': 'Username',
  'account.usernameHint': '3-24 characters — letters, numbers, and underscores only.',
  'account.back': '← Back',
  'account.creating': 'Creating…',
  'account.yourProfile': 'Your profile',
  'account.cardArt': 'Card Art',
  'account.uploadImage': 'Upload Image',
  'account.chooseImage': 'Choose Image…',
  'account.uploadHint': 'PNG, JPEG, GIF, or WebP — under 2 MB.',
  'account.updatingPicture': 'Updating picture…',
  'account.imageTooLarge': 'Image is too large — please use one under 2 MB.',
  'account.couldNotReadFile': 'Could not read file.',
  'account.school': 'School',
  'account.saving': 'Saving…',
  'account.schoolTitle': '{colors} — click again to unenroll',
  'account.sounds': 'Sounds',
  'account.soundsMuted': '🔇 Muted — click to unmute',
  'account.soundsOn': '🔊 Sounds on — click to mute',
  'account.save': 'Save',
  'account.switchProfile': 'Switch Profile',
  'account.signOut': 'Sign Out',

  'decks.title': 'My Decks',
  'decks.simplifiedView': 'Simplified View',
  'decks.showArt': 'Show Art',
  'decks.newDeck': '+ New Deck',
  'decks.loading': 'Loading decks…',
  'decks.empty': 'No decks yet — create one to get started.',
  'decks.noMatches': 'No decks match your filters.',
  'decks.filterName': 'Name',
  'decks.filterSearchPlaceholder': 'Search decks…',
  'decks.includesColors': 'Includes colors',
  'decks.exactCombination': 'Exact combination',
  'decks.bracket': 'Bracket',
  'decks.anyBracket': 'Any bracket',
  'decks.noBracket': 'No bracket',
  'decks.bracketN': 'Bracket {n}',
  'decks.archetype': 'Archetype',
  'decks.anyArchetype': 'Any archetype',
  'decks.clearFilters': 'Clear filters',
  'decks.duplicateDeck': 'Duplicate Deck',
  'decks.exportDeck': 'Export Deck',
  'decks.deleteDeck': 'Delete Deck',
  'decks.deleteConfirm': 'Delete "{name}"? This cannot be undone.',
  'decks.cancel': 'Cancel',
  'decks.noGames': 'No games',
  'decks.cardCount': '{count} card(s)',
  'decks.export.title': 'Export — {name}',
  'decks.export.hint': "Edit if needed, then copy and paste into another site's import box.",
  'decks.export.close': 'Close',
  'decks.export.copy': 'Copy Text',
  'decks.export.copied': '✓ Copied!',
  'decks.chooseCommander': 'Choose a commander',
  'decks.creatingDeck': 'Creating deck…',
  'decks.chooseBackground': 'Choose a Background',
  'decks.choosePartner': 'Choose a partner',
  'decks.for': 'for',
  'decks.skipSingleCommander': 'Skip — single commander',
  'decks.searchBackgrounds': 'Search backgrounds…',
  'decks.searchPartner': 'Search for a partner…',
  'decks.noResults': 'No results.',
  'decks.dragToReorder': 'Drag to reorder',
  'decks.deckOptions': 'Deck options',
  'decks.archetypeTitle': 'Archetype'
}

const ptBR: Dictionary = {
  'nav.home': 'Início',
  'nav.search': 'Buscar',
  'nav.sets': 'Coleções',
  'nav.tokens': 'Fichas',
  'nav.commander': 'Comandante',
  'nav.precons': 'Precons',
  'nav.decks': 'Decks',
  'nav.playtest': 'Simulação',
  'search.placeholder': 'Busque cartas (nome, ou use os filtros abaixo)',
  'home.searchPlaceholder': 'Busque uma carta pelo nome…',
  'home.welcomeGuest':
    'Bem-vindo, estimado visitante, à BiblioPLEX. Todos que buscam conhecimento são bem-vindos, mesmo que ainda não estejam matriculados.',
  'home.welcomeBack': 'Bem-vindo de volta à {brand}, {username}.',
  'home.welcomeBackStudent': 'Bem-vindo de volta à {brand}, {username}, estudante de {school}.',

  'account.buttonDefault': 'Perfil',
  'account.chooseProfile': 'Escolha um perfil',
  'account.createProfile': 'Criar Perfil',
  'account.createProfileHeading': 'Criar um perfil',
  'account.usernamePlaceholder': 'Nome de usuário',
  'account.usernameHint': '3 a 24 caracteres — apenas letras, números e sublinhados.',
  'account.back': '← Voltar',
  'account.creating': 'Criando…',
  'account.yourProfile': 'Seu perfil',
  'account.cardArt': 'Arte da Carta',
  'account.uploadImage': 'Enviar Imagem',
  'account.chooseImage': 'Escolher Imagem…',
  'account.uploadHint': 'PNG, JPEG, GIF ou WebP — até 2 MB.',
  'account.updatingPicture': 'Atualizando imagem…',
  'account.imageTooLarge': 'A imagem é muito grande — use uma com até 2 MB.',
  'account.couldNotReadFile': 'Não foi possível ler o arquivo.',
  'account.school': 'Escola',
  'account.saving': 'Salvando…',
  'account.schoolTitle': '{colors} — clique novamente para sair',
  'account.sounds': 'Sons',
  'account.soundsMuted': '🔇 Mudo — clique para ativar',
  'account.soundsOn': '🔊 Som ativado — clique para silenciar',
  'account.save': 'Salvar',
  'account.switchProfile': 'Trocar Perfil',
  'account.signOut': 'Sair',

  'decks.title': 'Meus Decks',
  'decks.simplifiedView': 'Visão Simplificada',
  'decks.showArt': 'Mostrar Arte',
  'decks.newDeck': '+ Novo Deck',
  'decks.loading': 'Carregando decks…',
  'decks.empty': 'Nenhum deck ainda — crie um para começar.',
  'decks.noMatches': 'Nenhum deck corresponde aos seus filtros.',
  'decks.filterName': 'Nome',
  'decks.filterSearchPlaceholder': 'Buscar decks…',
  'decks.includesColors': 'Inclui cores',
  'decks.exactCombination': 'Combinação exata',
  'decks.bracket': 'Bracket',
  'decks.anyBracket': 'Qualquer bracket',
  'decks.noBracket': 'Sem bracket',
  'decks.bracketN': 'Bracket {n}',
  'decks.archetype': 'Arquétipo',
  'decks.anyArchetype': 'Qualquer arquétipo',
  'decks.clearFilters': 'Limpar filtros',
  'decks.duplicateDeck': 'Duplicar Deck',
  'decks.exportDeck': 'Exportar Deck',
  'decks.deleteDeck': 'Excluir Deck',
  'decks.deleteConfirm': 'Excluir "{name}"? Isso não pode ser desfeito.',
  'decks.cancel': 'Cancelar',
  'decks.noGames': 'Sem partidas',
  'decks.cardCount': '{count} carta(s)',
  'decks.export.title': 'Exportar — {name}',
  'decks.export.hint': 'Edite se necessário e cole na caixa de importação de outro site.',
  'decks.export.close': 'Fechar',
  'decks.export.copy': 'Copiar Texto',
  'decks.export.copied': '✓ Copiado!',
  'decks.chooseCommander': 'Escolha um comandante',
  'decks.creatingDeck': 'Criando deck…',
  'decks.chooseBackground': 'Escolha um Background',
  'decks.choosePartner': 'Escolha um parceiro',
  'decks.for': 'para',
  'decks.skipSingleCommander': 'Pular — comandante único',
  'decks.searchBackgrounds': 'Buscar backgrounds…',
  'decks.searchPartner': 'Buscar um parceiro…',
  'decks.noResults': 'Nenhum resultado.',
  'decks.dragToReorder': 'Arraste para reordenar',
  'decks.deckOptions': 'Opções do deck',
  'decks.archetypeTitle': 'Arquétipo'
}

const DICTIONARIES: Record<Locale, Dictionary> = { en, 'pt-BR': ptBR }

export const LANGUAGES: { locale: Locale; label: string; flag: string }[] = [
  { locale: 'en', label: 'English', flag: '🇺🇸' },
  { locale: 'pt-BR', label: 'Português (Brasil)', flag: '🇧🇷' }
]

const LOCALE_KEY = 'mtgplatform.locale'
const LOCALE_EVENT = 'biblioplex:locale-changed'
const DEFAULT_LOCALE: Locale = 'en'

export function getLocale(): Locale {
  return localStorage.getItem(LOCALE_KEY) === 'pt-BR' ? 'pt-BR' : DEFAULT_LOCALE
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_KEY, locale)
  window.dispatchEvent(new Event(LOCALE_EVENT))
  // Mirrors the choice into the main process — see localePreference.ts — so Scryfall fetches
  // there know to prefer Portuguese printings' art/name without every IPC call needing its own
  // locale parameter.
  window.api.setAppLocale(locale)
}

/** Forces a re-render whenever the locale changes — components call this once (its return
 *  value doesn't need to be used) so their own t() calls in the same render pick up the switch,
 *  same as onAccountChanged's role for account state (see accountEvents.ts). */
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState(getLocale)
  useEffect(() => {
    function handleChange(): void {
      setLocaleState(getLocale())
    }
    window.addEventListener(LOCALE_EVENT, handleChange)
    return () => window.removeEventListener(LOCALE_EVENT, handleChange)
  }, [])
  return locale
}

export function t(key: string, vars?: Record<string, string>): string {
  const dict = DICTIONARIES[getLocale()]
  let text = dict[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
