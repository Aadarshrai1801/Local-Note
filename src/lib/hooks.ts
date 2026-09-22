/**
 * Small React utilities shared across views. Kept dependency-free on purpose:
 * the renderer ships no state library, router, or data-fetching library.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList
} from 'react'
import { errorMessage } from '@/lib/format'
import { pushToast } from '@/lib/store'

/**
 * A stable callback whose identity never changes, but which always calls the
 * latest version of `fn`. Essential for keeping memoized rows memoized.
 */
export function useEventCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: Args) => ref.current(...args), [])
}

export interface AsyncData<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Re-run the loader, keeping the previous data on screen while it loads. */
  refresh: () => void
  /** Apply a local update (used for optimistic edits). */
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

/**
 * Load async data with loading/error state and stale-response protection.
 * Rejections are captured into `error` so views can render an error state
 * instead of a blank screen — the loader never throws into the tree.
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  options: { toastOnError?: string } = {}
): AsyncData<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const toastRef = useRef(options.toastOnError)
  toastRef.current = options.toastOnError

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const result = await loaderRef.current()
        if (cancelled) return
        setDataState(result)
        setError(null)
      } catch (err) {
        if (cancelled) return
        const message = errorMessage(err)
        setError(message)
        if (toastRef.current) {
          pushToast('error', `${toastRef.current} — ${message}`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) =>
      typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater
    )
  }, [])

  return { data, error, loading, refresh, setData }
}

/** Escape closes inline panels; ignores keystrokes while typing in a field. */
export function useEscape(handler: () => void, enabled = true): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      ref.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

/**
 * A ticking clock. Returns `Date.now()` refreshed on an interval, so timers and
 * relative dates stay live even if backend events stall.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, enabled])
  return now
}

/** Debounce a value (used by the search box). */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

/** Track whether an element is scrolled to the bottom (live transcript rails). */
export function useStickyScroll<T extends HTMLElement>(
  dependency: unknown,
  enabled: boolean
): {
  setRef: (node: T | null) => void
  pinned: boolean
  jumpToLatest: () => void
} {
  // The node lives in state (rather than a plain ref) so the listener effect
  // re-runs when the scroll container first appears — which happens when the
  // live transcript goes from empty to its first line.
  const [node, setNode] = useState<T | null>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (!node) return
    const onScroll = (): void => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      setPinned(distance < 64)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => node.removeEventListener('scroll', onScroll)
  }, [node])

  useEffect(() => {
    if (!enabled || !pinned || !node) return
    node.scrollTop = node.scrollHeight
  }, [dependency, enabled, pinned, node])

  const jumpToLatest = useCallback(() => {
    if (node) node.scrollTop = node.scrollHeight
    setPinned(true)
  }, [node])

  return useMemo(() => ({ setRef: setNode, pinned, jumpToLatest }), [pinned, jumpToLatest])
}
