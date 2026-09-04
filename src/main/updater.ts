import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { dirname, join } from 'path'
import { createWriteStream } from 'fs'
import { spawn } from 'child_process'

const REPO = 'Martyris/BiblioPLEX'
// A bare (unzipped) exe asset, published under this constant name on every release — see
// project_biblioplex_releases memory. Keeping it unzipped means this updater never needs an
// unzip dependency; it just streams the asset straight to disk and runs it.
const ASSET_NAME = 'BiblioPLEX-win.exe'

export interface UpdateInfo {
  version: string
  downloadUrl: string
  size: number
  releaseUrl: string
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // The whole flow (BiblioPLEX-win.exe asset, download-then-relaunch) only makes sense for the
  // portable Windows build this app actually ships as.
  if (process.platform !== 'win32') return null

  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BiblioPLEX-updater' }
    })
  } catch {
    return null
  }
  if (!res.ok) return null

  const data = (await res.json()) as {
    tag_name: string
    html_url: string
    assets: { name: string; browser_download_url: string; size: number }[]
  }

  const latestVersion = data.tag_name.replace(/^v/, '')
  if (compareVersions(latestVersion, app.getVersion()) <= 0) return null

  const asset = data.assets.find((a) => a.name === ASSET_NAME)
  if (!asset) return null

  return { version: latestVersion, downloadUrl: asset.browser_download_url, size: asset.size, releaseUrl: data.html_url }
}

// Mirrors the portable-vs-dev directory logic in main/index.ts (see the userData comment
// there) — downloads land next to the exe the user actually double-clicked, not a temp folder,
// so the result looks like a normal "grab the new portable exe" download.
function updateDownloadDir(): string {
  if (is.dev) return app.getPath('temp')
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  return portableDir ?? dirname(app.getPath('exe'))
}

export async function downloadUpdate(
  info: UpdateInfo,
  onProgress: (receivedBytes: number, totalBytes: number) => void
): Promise<string> {
  const destPath = join(updateDownloadDir(), `BiblioPLEX ${info.version}.exe`)
  const res = await fetch(info.downloadUrl)
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)

  const fileStream = createWriteStream(destPath)
  const reader = res.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress(received, info.size)
      await new Promise<void>((resolve, reject) => {
        fileStream.write(value, (err) => (err ? reject(err) : resolve()))
      })
    }
  } finally {
    await new Promise<void>((resolve) => fileStream.end(resolve))
  }

  return destPath
}

// The env var main/index.ts's own cleanupOldExeIfRequested looks for on startup — named for
// what it holds, not what reads it, since the reader lives in a process that doesn't exist yet
// at the point this is set. Exported so both ends of this handoff share one literal.
export const DELETE_OLD_EXE_ENV_VAR = 'BIBLIOPLEX_DELETE_OLD_EXE'

// Launches the freshly-downloaded portable exe as its own detached process, then quits this
// one — there's no "install directory" to update in place for a portable build, so the update
// is really just "run the new copy, close the old one." Also hands the new process this one's
// own exe path (PORTABLE_EXECUTABLE_FILE — the real file the user double-clicked, not
// app.getPath('exe')'s ephemeral %TEMP% extraction) via an env var, so the new process can
// delete it once this one has actually exited and released its file lock — otherwise every
// update leaves the previous version's exe sitting right next to the new one forever.
export function installUpdate(filePath: string): void {
  const oldExePath = process.env.PORTABLE_EXECUTABLE_FILE
  spawn(filePath, [], {
    detached: true,
    stdio: 'ignore',
    env: oldExePath ? { ...process.env, [DELETE_OLD_EXE_ENV_VAR]: oldExePath } : process.env
  }).unref()
  app.quit()
}
