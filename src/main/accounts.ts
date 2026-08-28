import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { getCardByFuzzyName } from './scryfall'

// A local, password-less profile system — the "base" for a future real account system. There's
// no server to check usernames against yet, so uniqueness is only enforced among accounts ever
// created on this machine/install, same scope as everything else this app stores. When real
// (e.g. Google) sign-in is added later, that becomes another way to arrive at/create one of
// these Account records rather than a replacement for this file's shape.
export type ProfilePicture =
  | { type: 'card'; cardName: string; imageUrl: string }
  | { type: 'upload'; dataUrl: string }

// The 10 two-color "schools" a student can belong to — the 5 real Strixhaven colleges plus 5
// homebrew "Hexhaven" counterparts, together covering all 10 Ravnica guild color pairs (WU
// through GU). Kept here as the validation source of truth; the renderer has its own copy of
// this list paired with each school's color identity for swatches/gradients (see
// AccountPanel.tsx) since main has no reason to know WUBRG color codes.
export const SCHOOLS = [
  'Fatehold',
  'Theorix',
  'Stingerquill',
  'Konstrari',
  'Vigorbloom',
  'Silverquill',
  'Prismari',
  'Witherbloom',
  'Lorehold',
  'Quandrix'
] as const

export type School = (typeof SCHOOLS)[number]

export interface Account {
  id: string
  username: string
  profilePicture: ProfilePicture | null
  school: School | null
  createdAt: string
}

interface AccountsFile {
  accounts: Account[]
  currentAccountId: string | null
}

// A profile picture is stored inline as a data URL for uploads — small enough (capped below)
// that a plain JSON file is simpler than managing separate image files on disk, consistent with
// how everything else here already round-trips as one JSON blob (decks.json, precons.json).
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

let cache: AccountsFile | null = null

function accountsPath(): string {
  return join(app.getPath('userData'), 'accounts.json')
}

async function load(): Promise<AccountsFile> {
  if (cache) return cache
  try {
    const raw = await readFile(accountsPath(), 'utf-8')
    cache = JSON.parse(raw) as AccountsFile
    // Accounts created before `school` existed won't have the field at all.
    for (const account of cache.accounts) account.school ??= null
  } catch {
    cache = { accounts: [], currentAccountId: null }
  }
  return cache
}

async function persist(file: AccountsFile): Promise<void> {
  cache = file
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(accountsPath(), JSON.stringify(file, null, 2), 'utf-8')
}

function normalize(username: string): string {
  return username.trim().toLowerCase()
}

function validateUsername(username: string): string {
  const trimmed = username.trim()
  if (trimmed.length < 3) throw new Error('Username must be at least 3 characters.')
  if (trimmed.length > 24) throw new Error('Username must be 24 characters or fewer.')
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('Username can only contain letters, numbers, and underscores.')
  }
  return trimmed
}

export async function isUsernameAvailable(username: string, excludingId?: string): Promise<boolean> {
  const file = await load()
  const target = normalize(username)
  return !file.accounts.some((a) => a.id !== excludingId && normalize(a.username) === target)
}

export async function listAccounts(): Promise<Account[]> {
  const file = await load()
  return file.accounts
}

export async function getCurrentAccount(): Promise<Account | null> {
  const file = await load()
  return file.accounts.find((a) => a.id === file.currentAccountId) ?? null
}

export async function createAccount(rawUsername: string): Promise<Account> {
  const username = validateUsername(rawUsername)
  const file = await load()
  if (!(await isUsernameAvailable(username))) {
    throw new Error(`"${username}" is already taken.`)
  }
  const account: Account = {
    id: randomUUID(),
    username,
    profilePicture: null,
    school: null,
    createdAt: new Date().toISOString()
  }
  file.accounts.push(account)
  file.currentAccountId = account.id
  await persist(file)
  return account
}

export async function switchAccount(id: string): Promise<Account> {
  const file = await load()
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error('Account not found.')
  file.currentAccountId = id
  await persist(file)
  return account
}

export async function signOut(): Promise<void> {
  const file = await load()
  file.currentAccountId = null
  await persist(file)
}

export async function setUsername(id: string, rawUsername: string): Promise<Account> {
  const username = validateUsername(rawUsername)
  const file = await load()
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error('Account not found.')
  if (!(await isUsernameAvailable(username, id))) {
    throw new Error(`"${username}" is already taken.`)
  }
  account.username = username
  await persist(file)
  return account
}

export async function setSchool(id: string, school: School | null): Promise<Account> {
  if (school !== null && !SCHOOLS.includes(school)) throw new Error('Not a recognized school.')
  const file = await load()
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error('Account not found.')
  account.school = school
  await persist(file)
  return account
}

/** Sets a profile picture from a card's art (the fuzzy-name lookup already used for import/
 *  foreign-name search elsewhere in scryfall.ts) — stores the resolved name + art_crop URL,
 *  not the card's id, since this is cosmetic and shouldn't break if the printing changes. */
export async function setProfilePictureCard(id: string, cardName: string): Promise<Account> {
  const file = await load()
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error('Account not found.')

  const result = await getCardByFuzzyName(cardName)
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error((result as unknown as { details: string }).details)
  }
  const card = result as {
    name: string
    image_uris?: { art_crop?: string }
    card_faces?: { image_uris?: { art_crop?: string } }[]
  }
  const imageUrl = card.image_uris?.art_crop ?? card.card_faces?.[0]?.image_uris?.art_crop
  if (!imageUrl) throw new Error(`"${card.name}" has no art available.`)

  account.profilePicture = { type: 'card', cardName: card.name, imageUrl }
  await persist(file)
  return account
}

export async function setProfilePictureUpload(id: string, dataUrl: string): Promise<Account> {
  const file = await load()
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error('Account not found.')

  if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(dataUrl)) {
    throw new Error('Unsupported image format.')
  }
  // Rough size check against the base64 payload (~4/3 the size of the decoded bytes).
  const base64Length = dataUrl.length - dataUrl.indexOf(',') - 1
  if (base64Length * 0.75 > MAX_UPLOAD_BYTES) {
    throw new Error('Image is too large — please use one under 2 MB.')
  }

  account.profilePicture = { type: 'upload', dataUrl }
  await persist(file)
  return account
}
