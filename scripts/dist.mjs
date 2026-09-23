// Packaging launcher that works around a Windows quirk.
//
// electron-builder downloads and extracts archives (the Electron binary, NSIS,
// 7-Zip) into its cache directory and the output directory, then renames the
// extracted folder into place. On Windows that final rename fails with
// `EPERM: operation not permitted` whenever the path contains a space, which
// makes `electron-builder` unusable from a project folder like
// "D:\My Projects\local-note".
//
// This script detects a space in the project path and, only then, redirects the
// cache and output to space-free sibling directories. With a clean path it
// behaves exactly like a plain `electron-builder --win` invocation.
//
//   node scripts/dist.mjs               # NSIS installer + portable exe
//   node scripts/dist.mjs --dir         # unpacked app only (fast, for testing)
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const passthrough = process.argv.slice(2)
const env = { ...process.env }

const hasSpace = /\s/.test(root)

/**
 * True when a path is usable for electron-builder's extract-then-rename step.
 * An unset or space-containing path must be redirected; an existing clean one
 * (for example one the user configured globally) is left alone so caches are
 * not duplicated.
 */
function isUsable(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/.test(value)
}

if (hasSpace) {
  // Place redirected caches as siblings of the project, keeping them on the same
  // drive but out of any directory whose name contains a space.
  const parent = dirname(root)
  const fallbackCache = join(parent, 'localnote-build-cache')
  const outputDir = join(parent, 'localnote-release')

  if (!isUsable(env.ELECTRON_BUILDER_CACHE)) {
    mkdirSync(join(fallbackCache, 'builder'), { recursive: true })
    env.ELECTRON_BUILDER_CACHE = join(fallbackCache, 'builder')
  }
  if (!isUsable(env.ELECTRON_CACHE)) {
    mkdirSync(join(fallbackCache, 'electron'), { recursive: true })
    env.ELECTRON_CACHE = join(fallbackCache, 'electron')
  }

  console.log('[dist] The project path contains a space:')
  console.log(`[dist]   ${root}`)
  console.log('[dist] Redirecting electron-builder output to avoid a Windows rename bug:')
  console.log(`[dist]   builder cache -> ${env.ELECTRON_BUILDER_CACHE}`)
  console.log(`[dist]   electron cache -> ${env.ELECTRON_CACHE}`)
  console.log(`[dist]   output        -> ${outputDir}`)

  if (!passthrough.some((arg) => arg.startsWith('--config.directories.output'))) {
    passthrough.push(`--config.directories.output=${outputDir}`)
  }
} else {
  console.log(`[dist] Building in ${root}`)
}

// Resolve electron-builder's CLI entry point directly so the build never has to
// go through a shell.
const builderPkgPath = require.resolve('electron-builder/package.json')
const builderPkg = JSON.parse(readFileSync(builderPkgPath, 'utf8'))
const builderBin =
  typeof builderPkg.bin === 'string' ? builderPkg.bin : builderPkg.bin['electron-builder']
const builderCli = join(dirname(builderPkgPath), builderBin)

const result = spawnSync(
  process.execPath,
  [builderCli, '--win', ...passthrough],
  { cwd: root, stdio: 'inherit', env }
)

if (result.status !== 0) {
  console.error(`[dist] electron-builder failed with exit code ${result.status}`)
}
process.exit(result.status ?? 1)
