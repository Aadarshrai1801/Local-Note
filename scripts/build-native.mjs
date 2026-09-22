// Compiles the native WASAPI capture helper into native/bin/WasapiRecorder.exe.
//
// Run automatically by `npm run build`, and again at runtime by the app if the
// binary is missing (see electron/audio/recorder-build.ts). Uses the C# compiler
// that ships with Windows, so no SDK or build tools are required.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'native', 'WasapiRecorder.cs')
const outDir = join(root, 'native', 'bin')
const target = join(outDir, 'WasapiRecorder.exe')

function findCompiler() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function isUpToDate() {
  if (!existsSync(target) || !existsSync(source)) return false
  return statSync(target).mtimeMs >= statSync(source).mtimeMs
}

if (process.argv.includes('--force') || !isUpToDate()) {
  const compiler = findCompiler()
  if (!compiler) {
    console.error(
      '[build-native] Could not find csc.exe (the C# compiler bundled with Windows).\n' +
        '[build-native] System audio capture will be unavailable.\n' +
        '[build-native] The app will try to compile the helper at first run instead.'
    )
    // Not fatal: the app retries at runtime on the user's machine.
    process.exit(0)
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  try {
    execFileSync(
      compiler,
      ['/nologo', '/platform:x64', '/optimize+', '/target:exe', `/out:${target}`, source],
      { stdio: 'inherit' }
    )
    console.log(`[build-native] built ${target}`)
  } catch (error) {
    console.error('[build-native] compilation failed:', error.message)
    process.exit(1)
  }
} else {
  console.log('[build-native] audio helper is up to date')
}
