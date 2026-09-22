/**
 * Renderer entry point. Mounts the app into #root.
 *
 * No StrictMode double-invoke surprises: the store guards its event
 * subscription and bootstrap behind one-shot module flags, so mounting twice in
 * development cannot double-count segments or duplicate toasts.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import '@/index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Local Note: #root element is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
