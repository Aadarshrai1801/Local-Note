// Development launcher: starts the Vite dev server, compiles the Electron main
// process, then launches Electron pointed at the dev server.
//
// Main-process TypeScript is watched and Electron restarts automatically. The
// renderer gets Vite's normal hot reload.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let electron = null
let restarting = false
let shuttingDown = false

function compileMain() {
  // Invoke the TypeScript compiler directly rather than through a shell: this
  // avoids Node's DEP0190 warning about unescaped arguments and works the same
  // on every platform.
  const tsc = require.resolve('typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], {
    cwd: root,
    stdio: 'inherit'
  })
}

function startElectron(devUrl) {
  if (!existsSync(electronBin)) {
    console.error(
      '[dev] The Electron binary is missing.\n' +
        '[dev] Run: node node_modules/electron/install.js\n' +
        '[dev] (or re-run npm install)'
    )
    process.exit(1)
  }

  electron = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, LOCALNOTE_DEV_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' }
  })

  electron.on('exit', (code) => {
    if (shuttingDown || restarting) return
    console.log(`[dev] Electron exited (code ${code ?? 0}); shutting down.`)
    void shutdown(code ?? 0)
  })
}

async function restartElectron(devUrl) {
  if (restarting || shuttingDown) return
  restarting = true

  console.log('[dev] main process changed — recompiling…')
  try {
    compileMain()
  } catch {
    console.error('[dev] compile failed; keeping the previous build running.')
    restarting = false
    return
  }

  if (electron) {
    electron.removeAllListeners('exit')
    electron.kill()
    // Give Windows a moment to release the process before relaunching.
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  startElectron(devUrl)
  restarting = false
}

async function shutdown(code) {
  shuttingDown = true
  try {
    if (electron) electron.kill()
  } catch {
    /* already gone */
  }
  process.exit(code)
}

async function main() {
  console.log('[dev] compiling the Electron main process…')
  compileMain()

  console.log('[dev] starting the Vite dev server…')
  const server = await createServer({ configFile: join(root, 'vite.config.ts') })
  await server.listen()

  const port = server.config.server.port ?? 5273
  const devUrl = `http://localhost:${port}`
  console.log(`[dev] renderer served at ${devUrl}`)

  startElectron(devUrl)

  // Watch the main-process sources and restart Electron on change.
  let debounce = null
  watch(join(root, 'electron'), { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.ts')) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void restartElectron(devUrl), 150)
  })

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
}

main().catch((error) => {
  console.error('[dev] failed to start:', error)
  process.exit(1)
})
