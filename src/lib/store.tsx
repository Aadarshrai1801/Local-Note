/**
 * The renderer's entire state layer: one tiny external store plus a React
 * context that bootstraps it.
 *
 * Design notes
 * ------------
 * - There is exactly one store instance per window. It lives at module scope so
 *   plain functions (e.g. `attempt`, `stopRecording`) can use it without a hook,
 *   while components subscribe through `useSyncExternalStore`.
 * - Every state object is replaced immutably, so `useStore()` gets a stable
 *   snapshot and never triggers an infinite render loop.
 * - Backend events are the single source of truth for live recording state; the
 *   store only translates them and bumps per-meeting revisions so detail views
 *   know to refetch.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type {
  AppPaths,
  AppSettings,
  BackendStatus,
  LiveSegment,
  MainEvent,
  SessionState,
  StartRecordingOptions
} from '@shared/types'
import { api, isMockApi } from '@/lib/api'
import { errorMessage } from '@/lib/format'

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

export type ViewName = 'home' | 'live' | 'meeting' | 'search' | 'dictionary' | 'settings' | 'setup'

const VIEWS: ViewName[] = ['home', 'live', 'meeting', 'search', 'dictionary', 'settings', 'setup']

function toViewName(view: string): ViewName {
  return (VIEWS as string[]).includes(view) ? (view as ViewName) : 'home'
}

export interface NavState {
  view: ViewName
  /** Selected meeting for the detail view. */
  meetingId: string | null
}

/* ------------------------------------------------------------------ */
/* State shape                                                         */
/* ------------------------------------------------------------------ */

export type ToastLevel = 'info' | 'warn' | 'error'

const SETUP_DISMISSED_KEY = 'localnote.setupDismissed'

export interface Toast {
  id: string
  level: ToastLevel
  message: string
  createdAt: number
}

export interface BusyState {
  label: string
  /** 0..1 when the backend reports a known fraction. */
  progress: number | null
}

export interface StoreState {
  nav: NavState
  /** Last session snapshot pushed by the main process. */
  session: SessionState
  /** Segments streamed while a session is live, in arrival order. */
  liveSegments: LiveSegment[]
  status: BackendStatus | null
  statusLoaded: boolean
  settings: AppSettings | null
  paths: AppPaths | null
  /** Per-meeting revision counters; bump to force detail views to refetch. */
  revisions: Record<string, number>
  /** Bumped whenever the meeting list itself may have changed. */
  meetingsRevision: number
  toasts: Toast[]
  /** Progress reported by the backend over the `busy` event. */
  backendBusy: BusyState | null
  /** Progress of an in-flight renderer task (e.g. a dictionary save). */
  localBusy: BusyState | null
  /** Query handed from Home to the Search view. */
  searchQuery: string
  /** Set once the initial status/settings/paths load has finished (or failed). */
  bootstrapped: boolean
}

/** Neutral starting point: "nothing is known yet, and nothing is recording". */
export const EMPTY_SESSION: SessionState = {
  active: false,
  meetingId: null,
  title: '',
  startedAt: null,
  elapsedMs: 0,
  levels: { system: null, mic: null },
  error: null,
  warnings: [],
  queueDepth: 0,
  backlogSeconds: 0
}

const INITIAL_STATE: StoreState = {
  nav: { view: 'home', meetingId: null },
  session: EMPTY_SESSION,
  liveSegments: [],
  status: null,
  statusLoaded: false,
  settings: null,
  paths: null,
  revisions: {},
  meetingsRevision: 0,
  toasts: [],
  backendBusy: null,
  localBusy: null,
  searchQuery: '',
  bootstrapped: false
}

/* ------------------------------------------------------------------ */
/* Store implementation                                                */
/* ------------------------------------------------------------------ */

export interface Store {
  getState: () => StoreState
  setState: (updater: (prev: StoreState) => StoreState) => void
  subscribe: (listener: () => void) => () => void
}

function createStore(): Store {
  let state = INITIAL_STATE
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state)
      if (next === state) return
      state = next
      for (const listener of Array.from(listeners)) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const store = createStore()

function patch(partial: Partial<StoreState>): void {
  store.setState((prev) => ({ ...prev, ...partial }))
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

let toastSeq = 0

export function pushToast(level: ToastLevel, message: string): void {
  toastSeq += 1
  const toast: Toast = {
    id: `toast-${toastSeq}`,
    level,
    message,
    createdAt: Date.now()
  }
  store.setState((prev) => ({ ...prev, toasts: [...prev.toasts, toast].slice(-6) }))
}

export function dismissToast(id: string): void {
  store.setState((prev) => ({ ...prev, toasts: prev.toasts.filter((t) => t.id !== id) }))
}

export function bumpRevision(meetingId: string): void {
  store.setState((prev) => ({
    ...prev,
    revisions: { ...prev.revisions, [meetingId]: (prev.revisions[meetingId] ?? 0) + 1 }
  }))
}

export function bumpMeetingsRevision(): void {
  store.setState((prev) => ({ ...prev, meetingsRevision: prev.meetingsRevision + 1 }))
}

export function setSearchQuery(query: string): void {
  patch({ searchQuery: query })
}

export function go(view: ViewName, meetingId?: string | null): void {
  store.setState((prev) => ({
    ...prev,
    nav: {
      view,
      meetingId:
        meetingId !== undefined
          ? (meetingId ?? null)
          : view === 'meeting'
            ? prev.nav.meetingId
            : null
    }
  }))
}

export function openMeeting(meetingId: string): void {
  go('meeting', meetingId)
}

/* ---- busy ------------------------------------------------------- */

let localBusySeq = 0

export function setLocalBusy(label: string | null, progress: number | null = null): void {
  patch({ localBusy: label ? { label, progress } : null })
}

export interface AttemptOptions {
  /** Show a busy indicator with this label while the promise is in flight. */
  label?: string
  /** Toast on success. */
  success?: string
  /** Prefix for the error toast, e.g. "Could not save the summary". */
  errorPrefix?: string
  /** Never toast on failure (the caller renders the error instead). */
  quiet?: boolean
  /** Refresh the meeting list / detail data when the call succeeds. */
  meetingId?: string
}

/**
 * Run an async backend call with uniform busy + error handling.
 * Returns `undefined` when the call failed (after pushing a toast), so callers
 * never need their own try/catch for the common case.
 */
export async function attempt<T>(
  fn: () => Promise<T>,
  opts: AttemptOptions = {}
): Promise<T | undefined> {
  const seq = ++localBusySeq
  if (opts.label) setLocalBusy(opts.label, null)
  try {
    const result = await fn()
    if (opts.success) pushToast('info', opts.success)
    if (opts.meetingId) {
      bumpRevision(opts.meetingId)
      bumpMeetingsRevision()
    }
    return result
  } catch (error) {
    if (!opts.quiet) {
      const message = errorMessage(error)
      pushToast('error', opts.errorPrefix ? `${opts.errorPrefix} — ${message}` : message)
    }
    return undefined
  } finally {
    if (seq === localBusySeq) setLocalBusy(null)
  }
}

/** True once the user has chosen "skip and explore" on the setup screen. */
export function isSetupDismissed(): boolean {
  try {
    return window.localStorage.getItem(SETUP_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissSetup(): void {
  try {
    window.localStorage.setItem(SETUP_DISMISSED_KEY, '1')
  } catch {
    // Storage can be unavailable (private mode); skipping is best-effort.
  }
}

/* ---- settings ---------------------------------------------------- */

export function applySettings(settings: AppSettings): void {
  patch({ settings })
}

/**
 * Save a settings patch and keep the store in sync with what the backend
 * actually persisted (it may normalise values).
 */
export async function saveSettings(patchIn: Partial<AppSettings>): Promise<AppSettings | null> {
  const result = await attempt(() => api.updateSettings(patchIn), {
    errorPrefix: 'Could not save settings'
  })
  if (result) patch({ settings: result })
  return result ?? null
}

/* ---- recording -------------------------------------------------- */

export async function startRecording(opts: StartRecordingOptions = {}): Promise<string | null> {
  const result = await attempt(() => api.startRecording(opts), {
    label: 'Starting capture…',
    errorPrefix: 'Could not start recording'
  })
  if (!result) return null
  bumpMeetingsRevision()
  store.setState((prev) => ({
    ...prev,
    nav: { view: 'live', meetingId: result.meetingId },
    liveSegments: []
  }))
  return result.meetingId
}

export async function stopRecording(): Promise<string | null> {
  const result = await attempt(() => api.stopRecording(), {
    label: 'Finishing up…',
    errorPrefix: 'Could not stop the recording'
  })
  if (!result) return null
  pushToast('info', 'Recording stopped. The transcript is saved.')
  bumpRevision(result.meetingId)
  bumpMeetingsRevision()
  // Show the meeting that was just captured — that is where the summary lands.
  go('meeting', result.meetingId)
  return result.meetingId
}

/* ---- backend events --------------------------------------------- */

const MAX_LIVE_SEGMENTS = 4000

function handleEvent(event: MainEvent): void {
  switch (event.type) {
    case 'session': {
      store.setState((prev) => {
        const previousMeetingId = prev.session.meetingId
        const nextMeetingId = event.state.meetingId
        // Keep the live buffer in sync with whichever meeting is live.
        const liveSegments =
          nextMeetingId == null
            ? []
            : previousMeetingId !== nextMeetingId
              ? prev.liveSegments.filter((s) => s.meetingId === nextMeetingId)
              : prev.liveSegments
        return { ...prev, session: event.state, liveSegments }
      })
      if (!event.state.active && event.state.meetingId) {
        // A finished session means the persisted transcript changed.
        bumpRevision(event.state.meetingId)
        bumpMeetingsRevision()
      }
      break
    }
    case 'segment': {
      const segment = event.segment
      store.setState((prev) => {
        const existing = prev.liveSegments.findIndex((s) => s.id === segment.id)
        if (existing >= 0) {
          const next = prev.liveSegments.slice()
          next[existing] = segment
          return { ...prev, liveSegments: next }
        }
        const next =
          prev.liveSegments.length >= MAX_LIVE_SEGMENTS
            ? [...prev.liveSegments.slice(-MAX_LIVE_SEGMENTS + 1), segment]
            : [...prev.liveSegments, segment]
        return { ...prev, liveSegments: next }
      })
      break
    }
    case 'segments-updated': {
      bumpRevision(event.meetingId)
      bumpMeetingsRevision()
      break
    }
    case 'summary': {
      bumpRevision(event.meetingId)
      bumpMeetingsRevision()
      if (event.status === 'failed') {
        pushToast('error', 'Summarising failed. The transcript is still saved.')
      }
      break
    }
    case 'action-items': {
      bumpRevision(event.meetingId)
      bumpMeetingsRevision()
      break
    }
    case 'toast': {
      pushToast(event.level, event.message)
      break
    }
    case 'busy': {
      patch({
        backendBusy: event.label ? { label: event.label, progress: event.progress } : null
      })
      break
    }
    case 'navigate': {
      go(toViewName(event.view), event.meetingId ?? null)
      break
    }
    case 'status': {
      patch({ status: event.status, statusLoaded: true })
      break
    }
    default: {
      // Exhaustive switch: if MainEvent gains a variant this line fails to compile.
      const never: never = event
      void never
    }
  }
}

let bootStarted = false

/**
 * Browser-mock affordance: `?view=live&meeting=mtg-1042&q=pricing` lets a
 * contributor (or a screenshot tool) open a specific screen without clicking
 * through the app. Only honoured when the bridge is absent, so the packaged app
 * always starts on Home.
 */
function applyDeepLink(): void {
  if (!isMockApi) return
  try {
    const params = new URLSearchParams(window.location.search)
    const view = params.get('view')
    const meetingId = params.get('meeting')
    const q = params.get('q')
    const next: Partial<StoreState> = {}
    if (q) next.searchQuery = q
    if (view && (VIEWS as string[]).includes(view)) {
      next.nav = { view: view as ViewName, meetingId: meetingId ?? null }
    } else if (meetingId) {
      next.nav = { view: 'meeting', meetingId }
    }
    if (Object.keys(next).length > 0) patch(next)
  } catch {
    // A malformed URL must never stop the app from starting.
  }
}

function bootstrap(): void {
  if (bootStarted) return
  bootStarted = true
  applyDeepLink()

  const fail = (what: string, error: unknown): void => {
    pushToast('error', `Could not load ${what} — ${errorMessage(error)}`)
  }

  void (async () => {
    const [session, status, settings, paths] = await Promise.allSettled([
      api.getSession(),
      api.getStatus(),
      api.getSettings(),
      api.getPaths()
    ])
    patch({
      session: session.status === 'fulfilled' ? session.value : EMPTY_SESSION,
      status: status.status === 'fulfilled' ? status.value : null,
      statusLoaded: true,
      settings: settings.status === 'fulfilled' ? settings.value : null,
      paths: paths.status === 'fulfilled' ? paths.value : null,
      bootstrapped: true
    })
    if (session.status === 'rejected') fail('the session', session.reason)
    if (status.status === 'rejected') fail('backend status', status.reason)
    if (settings.status === 'rejected') fail('settings', settings.reason)
    if (paths.status === 'rejected') fail('file locations', paths.reason)
  })()
}

/* ------------------------------------------------------------------ */
/* React bindings                                                      */
/* ------------------------------------------------------------------ */

interface StoreContextValue {
  store: Store
}

const StoreContext = createContext<StoreContextValue>({ store })

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const value = useMemo(() => ({ store }), [])
  useEffect(() => {
    const unsubscribe = api.onEvent(handleEvent)
    bootstrap()
    return unsubscribe
  }, [])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

function useStoreInstance(): Store {
  return useContext(StoreContext).store
}

/** The whole state. The snapshot is stable between updates. */
export function useStore(): StoreState {
  const instance = useStoreInstance()
  return useSyncExternalStore(instance.subscribe, instance.getState, instance.getState)
}

/**
 * Subscribe to a slice of state. `equal` decides whether the slice actually
 * changed, which keeps high-frequency events (level meters) from re-rendering
 * expensive subtrees.
 */
export function useStoreSelector<T>(
  selector: (state: StoreState) => T,
  equal: (a: T, b: T) => boolean = Object.is
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalRef = useRef(equal)
  equalRef.current = equal
  const cacheRef = useRef<{ state: StoreState; value: T } | null>(null)
  const getSnapshotRef = useRef(() => {
    const state = store.getState()
    const cache = cacheRef.current
    if (cache && cache.state === state) return cache.value
    const value = selectorRef.current(state)
    if (cache && equalRef.current(cache.value, value)) {
      cacheRef.current = { state, value: cache.value }
      return cache.value
    }
    cacheRef.current = { state, value }
    return value
  })
  return useSyncExternalStore(store.subscribe, getSnapshotRef.current, getSnapshotRef.current)
}

export function useSession(): SessionState {
  return useStore().session
}

export function useLiveSegments(): LiveSegment[] {
  return useStoreSelector((state) => state.liveSegments)
}

export function useStatus(): { status: BackendStatus | null; loaded: boolean } {
  const status = useStoreSelector((state) => state.status)
  const loaded = useStoreSelector((state) => state.statusLoaded)
  return { status, loaded }
}

/** Just the session's liveness — cheap enough for the app shell to watch. */
export function useIsRecording(): boolean {
  return useStoreSelector((state) => state.session.active)
}

/** A stable slice of the session, for views that need one field only. */
export function useSessionField<T>(selector: (session: SessionState) => T): T {
  return useStoreSelector((state) => selector(state.session))
}

export function useSettings(): AppSettings | null {
  return useStoreSelector((state) => state.settings)
}

export function usePaths(): AppPaths | null {
  return useStoreSelector((state) => state.paths)
}

export function useToasts(): Toast[] {
  return useStoreSelector((state) => state.toasts)
}

export function useNav(): NavState {
  return useStoreSelector((state) => state.nav)
}

export function useMeetingRevision(meetingId: string | null): number {
  return useStoreSelector((state) => (meetingId ? (state.revisions[meetingId] ?? 0) : 0))
}

export function useMeetingsRevision(): number {
  return useStoreSelector((state) => state.meetingsRevision)
}

export function useBusy(): BusyState | null {
  return useStoreSelector((state) => state.localBusy ?? state.backendBusy)
}

export function useBackendBusy(): BusyState | null {
  return useStoreSelector((state) => state.backendBusy)
}

export function useSearchQuery(): string {
  return useStoreSelector((state) => state.searchQuery)
}

/** Read the current state outside of React (event handlers, async flows). */
export function getStateSnapshot(): StoreState {
  return store.getState()
}
