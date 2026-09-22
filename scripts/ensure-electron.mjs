// Ensures the Electron binary is present.
//
// Some environments (CI sandboxes, corporate proxies, or npm configs that skip
// lifecycle scripts) install the `electron` npm package but never fetch the
// platform binary, leaving node_modules/electron/dist missing. This script
// detects that and runs Electron's own installer, so `npm install` is always
// enough to get a runnable app.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electronDir = join(root, 'node_modules', 'electron')

if (!existsSync(electronDir)) {
  // No electron package at all: nothing to do (e.g. production install).
  process.exit(0)
}

const pathTxt = join(electronDir, 'path.txt')
const installer = join(electronDir, 'install.js')
let installed = false

if (existsSync(pathTxt)) {
  const rel = readFileSync(pathTxt, 'utf8').trim()
  if (rel && existsSync(join(electronDir, 'dist', rel))) installed = true
}

if (installed) {
  process.exit(0)
}

if (!existsSync(installer)) {
  console.warn('[local-note] electron/install.js not found; skipping binary check.')
  process.exit(0)
}

console.log('[local-note] Electron binary missing — downloading it now...')
const res = spawnSync(process.execPath, [installer], { cwd: electronDir, stdio: 'inherit' })
if (res.status !== 0) {
  console.warn(
    '[local-note] Could not download the Electron binary automatically.\n' +
      '[local-note] If you are behind a proxy, set ELECTRON_MIRROR or run:\n' +
      '[local-note]   node node_modules/electron/install.js'
  )
}
process.exit(0)
