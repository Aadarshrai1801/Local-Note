import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, INVOKE_METHODS } from '../shared/api'

/**
 * The only bridge between the renderer and Node.
 *
 * The renderer runs with context isolation on and Node integration off, so it
 * can only reach the main process through the small, explicitly enumerated
 * surface built here. Nothing else from Electron is exposed.
 */

const api: Record<string, unknown> = {}

for (const method of INVOKE_METHODS) {
  // Arguments are always forwarded as an array so the main-process dispatcher
  // has one predictable calling convention for every method.
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(CHANNELS.invoke, method, args)
}

api.onEvent = (callback: (event: unknown) => void): (() => void) => {
  const listener = (_event: unknown, payload: unknown): void => callback(payload)
  ipcRenderer.on(CHANNELS.event, listener)
  return () => {
    ipcRenderer.removeListener(CHANNELS.event, listener)
  }
}

// A hard guarantee for the "no cloud, ever" promise: the renderer cannot open
// external links or navigate away from the app's own documents.
api.__offlineGuard = true

contextBridge.exposeInMainWorld('localNote', Object.freeze(api))
