import { BrowserWindow, screen, globalShortcut, type Display } from 'electron'
import { join } from 'node:path'
import { createLogger } from './lib/log'
import { getResourceDir } from './lib/paths'
import { getSettings, updateSettings } from './db/settings'
import type { MainEvent, SessionState } from '../shared/types'

const log = createLogger('overlay')

/**
 * The floating capture bar.
 *
 * A small always-on-top window that lets the user start and stop capture from
 * anywhere on the desktop, without switching to the Hub. It is deliberately
 * minimal: audio-level bars only, no live transcript. Text arriving in a tiny
 * bar is unreadable and janky; the transcript belongs in the Hub where it can
 * be read properly.
 *
 * Window flags worth understanding:
 *   transparent + frame:false  -> the pill shape, with no OS chrome
 *   alwaysOnTop('screen-saver') -> floats above fullscreen apps, which is what
 *                                  you need when recording a call
 *   skipTaskbar                -> it is an overlay, not an application window
 *   focusable:false            -> it must never steal focus from the meeting
 *   setIgnoreMouseEvents       -> click-through everywhere except over the bar
 */

const BAR_WIDTH = 260
const BAR_HEIGHT = 56
const EDGE_MARGIN = 24

export class CaptureOverlay {
  private window: BrowserWindow | null = null
  private registeredHotkey: string | null = null
  private lastState: SessionState | null = null
  private hovering = false
  private cursorPoll: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly options: {
      /** True while the renderer should load from the Vite dev server. */
      devUrl: string | null
      /** Sends an event to every open window. */
      broadcast: (event: MainEvent) => void
      /** Called when the hotkey or the bar asks to start/stop capture. */
      onToggleCapture: () => void
      /** Preload script path. */
      preloadPath: string
    }
  ) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  /** Creates the window if needed. Safe to call repeatedly. */
  show(): void {
    const settings = getSettings()
    if (!settings.captureBarEnabled) {
      log.info('capture bar is disabled in settings; not showing')
      return
    }

    if (this.isOpen) {
      this.window!.showInactive()
      return
    }

    const position = this.resolvePosition()

    this.window = new BrowserWindow({
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // Never take focus away from the meeting the user is in.
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // 'screen-saver' keeps it above fullscreen windows, which is the whole
    // point when a call is running fullscreen.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // Start click-through; the cursor poll enables interaction on hover.
    this.window.setIgnoreMouseEvents(true, { forward: true })

    if (this.options.devUrl) {
      void this.window.loadURL(`${this.options.devUrl}/capture.html`)
    } else {
      // Use the shared resource resolver so the overlay honours the same
      // LOCALNOTE_RESOURCE_DIR override and packaged layout as everything else.
      void this.window.loadFile(join(getResourceDir(), 'dist', 'capture.html'))
    }

    this.window.once('ready-to-show', () => {
      this.window?.showInactive()
      if (this.lastState) this.sendState(this.lastState)
    })

    // Persist where the user dragged it.
    this.window.on('moved', () => {
      if (!this.window) return
      const [x, y] = this.window.getPosition()
      updateSettings({ captureBarPosition: { x, y } })
    })

    this.window.on('closed', () => {
      this.window = null
      this.stopCursorPoll()
    })

    this.startCursorPoll()
    this.registerHotkey()
    log.info(`capture bar shown at ${position.x},${position.y}`)
  }

  hide(): void {
    this.stopCursorPoll()
    this.unregisterHotkey()
    if (this.isOpen) {
      this.window!.destroy()
      this.window = null
    }
    log.info('capture bar hidden')
  }

  /** Applies a settings change without needing a restart. */
  applySettings(): void {
    const settings = getSettings()

    if (!settings.captureBarEnabled) {
      this.hide()
      return
    }

    if (!this.isOpen) {
      this.show()
      return
    }

    // Re-register in case the hotkey changed.
    this.registerHotkey()

    // Honour hide-when-idle.
    const active = this.lastState?.active ?? false
    if (settings.captureBarHideWhenIdle && !active) {
      this.window!.setOpacity(0)
    } else {
      this.window!.setOpacity(1)
    }
  }

  /** Pushes session state to the bar so its meters reflect real audio. */
  update(state: SessionState): void {
    this.lastState = state

    if (!this.isOpen) return
    const settings = getSettings()

    if (settings.captureBarHideWhenIdle) {
      this.window!.setOpacity(state.active ? 1 : 0)
    } else {
      this.window!.setOpacity(1)
    }

    this.sendState(state)
  }

  private sendState(state: SessionState): void {
    if (!this.isOpen) return
    this.options.broadcast({ type: 'session', state })
  }

  /* ---------------- position ---------------- */

  private primaryDisplay(): Display {
    return screen.getPrimaryDisplay()
  }

  /**
   * Resolves where the bar should sit.
   *
   * Electron works in DIP (device-independent pixels), so the position is
   * stored and applied in DIP and stays correct across monitors with different
   * DPI scaling. A stored position is validated against the current displays so
   * a bar dragged onto a monitor that is no longer connected returns to the
   * default rather than off-screen.
   */
  private resolvePosition(): { x: number; y: number } {
    const stored = getSettings().captureBarPosition

    if (stored) {
      const visible = screen.getAllDisplays().some((display) => {
        const { x, y, width, height } = display.workArea
        // Require a reasonable overlap rather than any intersection at all.
        return (
          stored.x + BAR_WIDTH > x + 40 &&
          stored.x < x + width - 40 &&
          stored.y + BAR_HEIGHT > y &&
          stored.y < y + height - 20
        )
      })
      if (visible) return stored
      log.warn('stored capture bar position is off-screen; falling back to bottom centre')
    }

    return this.defaultPosition()
  }

  private defaultPosition(): { x: number; y: number } {
    const { x, y, width, height } = this.primaryDisplay().workArea
    return {
      x: Math.round(x + (width - BAR_WIDTH) / 2),
      y: Math.round(y + height - BAR_HEIGHT - EDGE_MARGIN)
    }
  }

  resetPosition(): void {
    updateSettings({ captureBarPosition: null })
    if (this.isOpen) {
      const { x, y } = this.defaultPosition()
      this.window!.setPosition(x, y)
    }
  }

  /* ---------------- click-through ---------------- */

  /**
   * Makes the bar interactive only while the cursor is over it.
   *
   * A transparent window that ignores mouse events cannot receive hover events,
   * so the cursor position is polled instead. This gives click-through
   * everywhere on the desktop except on the bar itself, which is what makes an
   * always-on-top overlay tolerable to live with.
   */
  private startCursorPoll(): void {
    if (this.cursorPoll) return

    this.cursorPoll = setInterval(() => {
      if (!this.isOpen) return
      const point = screen.getCursorScreenPoint()
      const bounds = this.window!.getBounds()

      const inside =
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height

      if (inside === this.hovering) return
      this.hovering = inside
      // forward:true keeps move events flowing so the renderer can style hover.
      this.window!.setIgnoreMouseEvents(!inside, { forward: true })
    }, 120)
  }

  private stopCursorPoll(): void {
    if (this.cursorPoll) {
      clearInterval(this.cursorPoll)
      this.cursorPoll = null
    }
    this.hovering = false
  }

  /* ---------------- global hotkey ---------------- */

  private registerHotkey(): void {
    const settings = getSettings()
    const accelerator = settings.captureHotkey?.trim()
    if (!accelerator) return

    if (this.registeredHotkey === accelerator && globalShortcut.isRegistered(accelerator)) {
      return
    }

    this.unregisterHotkey()

    try {
      const ok = globalShortcut.register(accelerator, () => {
        this.options.onToggleCapture()
      })
      if (ok) {
        this.registeredHotkey = accelerator
        log.info(`global hotkey registered: ${accelerator}`)
      } else {
        log.warn(`could not register global hotkey "${accelerator}" — another app may hold it`)
      }
    } catch (error) {
      log.warn(`invalid global hotkey "${accelerator}"`, error)
    }
  }

  private unregisterHotkey(): void {
    if (this.registeredHotkey) {
      try {
        globalShortcut.unregister(this.registeredHotkey)
      } catch {
        /* already gone */
      }
      this.registeredHotkey = null
    }
  }

  /** Reports whether the configured hotkey could actually be claimed. */
  hotkeyStatus(): { accelerator: string; registered: boolean } {
    const accelerator = getSettings().captureHotkey
    return {
      accelerator,
      registered: Boolean(accelerator && globalShortcut.isRegistered(accelerator))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopCursorPoll()
    this.unregisterHotkey()
    if (this.isOpen) {
      this.window!.destroy()
      this.window = null
    }
  }
}
